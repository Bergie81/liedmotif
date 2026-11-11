#!/bin/sh
# Liedmotif backup sidecar.
#
# Compose gives the stack durable volumes; durable is not the same as recovered.
# A deleted volume, a mistyped `docker compose down -v`, or ransomware takes
# every Session, playlist and Track with it, so this runs from the moment the
# stack is up, with no operator action.
#
# Once a minute it asks the database whether a backup is due
# (docker/backup-due.sql: the Admin's schedule from Settings → Backups, the
# Back up now request, and the scheduled slots in the instance timezone) and
# rewrites `status.json`, which the web app reads from the same volume. A run
# writes one self-contained folder, `liedmotif-backup-<stamp>/`: the gzipped,
# optionally encrypted dump, a snapshot of `/data`, and `manifest.json`.
#
# The database and `/data` are ONE logical dataset: a dump restored beside the
# wrong media yields Tracks that will not play. The dump is therefore taken
# FIRST and the media snapshot right after it, so the media is a superset of
# what the dump references.
#
# The schedule counts from the newest complete folder, never from process
# start: a deploy restarts this container, and a restart must not make a backup
# that rotates a scheduled one out.
#
# `status.json` is read by the web app, so a failure reaches it only as one of
# the fixed words `dump-failed`, `media-failed`, `low-disk`,
# `database-unreachable`, never as raw tool output. The tools' own errors go to
# the container log, which says why: libpq names the server, user and database
# but never the password, and the passphrase only ever travels as `env:` to
# openssl, because an archive is worthless if its key rode next to it.
#
# `liedmotif-backup restore <archive> [--yes]` is the other mode, run by hand
# with the app stopped: it replaces the database and `/data` with one backup
# (see the Restore section below).

set -u
# The dump is the FIRST stage of its pipeline: without this, a failed `pg_dump`
# still exits 0 through gzip and gets renamed as a good backup.
set -o pipefail

: "${BACKUP_DIR:=/backups}"
: "${BACKUP_RETRY_SECONDS:=300}"
# Backups share a disk with Postgres, and a full disk takes Postgres down.
: "${BACKUP_MIN_FREE_BYTES:=2147483648}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:=}"
: "${MEDIA_DIR:=/data}"
# Who restored media belongs to: the `node` user the app images run as.
: "${MEDIA_OWNER:=1000:1000}"
: "${STORAGE_PROVIDER:=local}"
# The app's own connection string when it uses a database other than the bundled
# one, so the backup reads the schedule from and dumps the database the app
# writes; empty, libpq's PG* variables name the bundled one.
: "${DATABASE_URL:=}"
# libpq verifies a server certificate only against a root file it is given,
# where the app's driver trusts the system roots; `system` gives libpq the same.
case "$DATABASE_URL" in
  *sslmode=verify-full*) : "${PGSSLROOTCERT:=system}" && export PGSSLROOTCERT ;;
esac

CHECK_SECONDS=60
RETRY_CEILING_SECONDS=86400
DUE_SQL="$(dirname "$0")/backup-due.sql"
STATUS_FILE="$BACKUP_DIR/status.json"
# One line: `<startedAt> <finishedAt> <error|-> <retryAt|-> <retryDelaySeconds>`.
# It outlives restarts, so a handled Back up now request stays handled and a
# pending retry stays pending.
ATTEMPT_FILE="$BACKUP_DIR/.last-attempt"
# Touched with every status write while the schedule is on track; its age is
# the healthcheck.
HEALTHY_FILE="$BACKUP_DIR/.healthy"
ISO='%Y-%m-%dT%H:%M:%SZ'
# The `openssl enc` format of the dumps, the download (apps/web/lib/backup-download.ts)
# and the restore; `-md sha256` is the PBKDF2 digest the download's key derivation uses.
CIPHER='-aes-256-cbc -pbkdf2 -iter 600000 -md sha256'

log() { echo "[backup] $*"; }

# `date -d` is GNU and busybox; `-r` and `-j -f` are the BSD spellings of the
# macOS hosts the tests also run on.
iso_of() { date -u -d "@$1" "+$ISO" 2>/dev/null || date -u -r "$1" "+$ISO"; }
epoch_of() {
  date -u -d "$(echo "$1" | sed 's/T/ /; s/Z$//')" +%s 2>/dev/null ||
    date -u -j -f "$ISO" "$1" +%s
}

json_string() {
  if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi
}

encrypted() {
  if [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then echo true; else echo false; fi
}

# Encrypt from stdin to stdout, or copy it through when no passphrase is set. The
# passphrase is read from the environment, never from a command line every
# process on the host can see.
encrypt_if_configured() {
  if [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
    openssl enc $CIPHER -salt -pass env:BACKUP_ENCRYPTION_PASSPHRASE
  else
    cat
  fi
}

# Complete backups, oldest first: the stamp sorts by time. A `.partial-*`
# folder never matches, so a crashed run is never counted as a backup.
complete_backups() {
  for dir in "$BACKUP_DIR"/liedmotif-backup-????????T??????Z; do
    [ -d "$dir" ] && echo "$dir"
  done
  return 0
}

newest_success_at() {
  complete_backups | tail -n 1 |
    sed 's#.*liedmotif-backup-\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z$#\1-\2-\3T\4:\5:\6Z#'
}

free_bytes() { echo "$(($(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }') * 1024))"; }

read_attempt() {
  attempt_started='' attempt_finished='' attempt_error='' retry_at='' retry_delay=0
  [ -f "$ATTEMPT_FILE" ] || return 0
  read -r attempt_started attempt_finished attempt_error retry_at retry_delay <"$ATTEMPT_FILE"
  [ "$attempt_finished" = - ] && attempt_finished=''
  [ "$attempt_error" = - ] && attempt_error=''
  [ "$retry_at" = - ] && retry_at=''
  return 0
}

write_attempt() {
  echo "$attempt_started ${attempt_finished:--} ${attempt_error:--} ${retry_at:--} $retry_delay" \
    >"$ATTEMPT_FILE.tmp" && mv "$ATTEMPT_FILE.tmp" "$ATTEMPT_FILE"
}

record_success() {
  attempt_finished="$(date -u "+$ISO")"
  attempt_error='' retry_at='' retry_delay=0
  write_attempt
}

# A failure retries after BACKUP_RETRY_SECONDS, doubling while failures repeat,
# up to a day. The database restarts on every deploy; charging that blip a
# whole period leaves the stack with no fresh backup for a week, while an
# outage that really lasts must not be retried against every minute.
record_failure() {
  if [ -n "$attempt_error" ] && [ "$retry_delay" -gt 0 ]; then
    retry_delay=$((retry_delay * 2))
  else
    retry_delay="$BACKUP_RETRY_SECONDS"
  fi
  [ "$retry_delay" -gt "$RETRY_CEILING_SECONDS" ] && retry_delay="$RETRY_CEILING_SECONDS"
  finished_epoch="$(date +%s)"
  attempt_finished="$(iso_of "$finished_epoch")"
  attempt_error="$1"
  retry_at="$(iso_of $((finished_epoch + retry_delay)))"
  write_attempt
  log "FAILED: $1"
}

write_status() {
  {
    printf '{\n'
    printf '  "checkedAt": "%s",\n' "$(date -u "+$ISO")"
    printf '  "nextRunAt": %s,\n' "$(json_string "$next_run_at")"
    if [ -n "$running_trigger" ]; then
      printf '  "running": { "startedAt": "%s", "trigger": "%s" },\n' \
        "$running_started" "$running_trigger"
    else
      printf '  "running": null,\n'
    fi
    if [ -z "$attempt_finished" ]; then
      printf '  "lastAttempt": null,\n'
    elif [ -z "$attempt_error" ]; then
      printf '  "lastAttempt": { "startedAt": "%s", "finishedAt": "%s", "ok": true },\n' \
        "$attempt_started" "$attempt_finished"
    else
      printf '  "lastAttempt": { "startedAt": "%s", "finishedAt": "%s", "ok": false, "error": "%s" },\n' \
        "$attempt_started" "$attempt_finished" "$attempt_error"
    fi
    printf '  "lastSuccessAt": %s,\n' "$(json_string "$last_success")"
    printf '  "overdue": %s,\n' "$overdue"
    # Only a retry the schedule will actually make: a failed manual run after
    # an on-time scheduled backup is not retried.
    if [ -n "$attempt_error" ] && [ "$overdue" = true ] && [ -n "$retry_at" ]; then
      printf '  "retryAt": "%s",\n' "$retry_at"
    fi
    printf '  "diskBytes": %s,\n' "$(($(du -sk "$BACKUP_DIR" | cut -f1) * 1024))"
    printf '  "freeBytes": %s,\n' "$(free_bytes)"
    printf '  "encrypted": %s\n' "$(encrypted)"
    printf '}\n'
  } >"$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
  [ "$healthy" = true ] && touch "$HEALTHY_FILE"
  return 0
}

# Overdue when the schedule is on and the last success predates the last slot
# (or there is none). Healthy when the schedule is off, or the last success is
# at most one missed slot behind: a run that is due or retrying is not yet an
# outage. An hour of DST drift in the period does not matter at this scale.
assess() {
  overdue=false healthy=true
  [ "$enabled" = t ] || return 0
  if [ -z "$last_success" ]; then
    overdue=true healthy=false
    return 0
  fi
  [ "$last_success" \< "$last_slot" ] && overdue=true
  if [ "$frequency" = daily ]; then period=86400; else period=604800; fi
  [ "$(epoch_of "$last_success")" -lt $(($(epoch_of "$last_slot") - period)) ] && healthy=false
  return 0
}

write_manifest() {
  {
    printf '{\n'
    printf '  "format": 1,\n'
    printf '  "createdAt": "%s",\n' "$running_started"
    printf '  "trigger": "%s",\n' "$running_trigger"
    printf '  "encrypted": %s,\n' "$(encrypted)"
    printf '  "includesMedia": %s,\n' "$includes_media"
    [ -n "$media_skipped" ] && printf '  "mediaSkipped": "%s",\n' "$media_skipped"
    printf '  "dbBytes": %s,\n' "$(($(wc -c <"$1/$db_name")))"
    printf '  "mediaBytes": %s,\n' "$media_bytes"
    printf '  "mediaFiles": %s\n' "$media_files"
    printf '}\n'
  } >"$1/manifest.json"
}

# Keep the newest `keep` complete backups. This runs only after a new one is
# complete, so a failing backup never deletes the last good one. A snapshot
# shares unchanged media with its neighbours through hardlinks, so deleting
# one never takes a file another still holds.
rotate() {
  excess=$(($(complete_backups | wc -l) - keep))
  [ "$excess" -gt 0 ] || return 0
  # Renamed out of the backup namespace first, so a run killed mid-delete
  # leaves a stray for the sweep above, never a half-deleted backup that lists,
  # downloads or restores.
  complete_backups | head -n "$excess" | while read -r old; do
    name="${old##*/}"
    mv "$old" "$BACKUP_DIR/.partial-rotated-$name" &&
      rm -rf "$BACKUP_DIR/.partial-rotated-$name" && log "rotated out $name"
  done
}

# Sets `failure` when the backup did not complete.
make_backup() {
  includes_media=false media_skipped='' media_bytes=0 media_files=0 previous=''
  if [ "$include_media" = t ] && [ "$STORAGE_PROVIDER" = s3 ]; then
    media_skipped=object-storage
  elif [ "$include_media" = t ]; then
    includes_media=true
    # Hardlink every file unchanged since the newest snapshot, so N backups
    # cost about one library plus what changed between them.
    previous="$(complete_backups | while read -r dir; do
      [ -d "$dir/media" ] && echo "$dir/media"
    done | tail -n 1)"
  fi

  # A run killed mid-copy (a deploy restarts this container) leaves its
  # .partial-* behind; left in place, a half-copied library would hold the
  # space the next run needs and keep it refused as low-disk.
  for stray in "$BACKUP_DIR"/.partial-*; do
    [ -d "$stray" ] && rm -rf "$stray"
  done

  # Without a snapshot to hardlink against, the media copy is the whole
  # library, so the floor must hold after it, not just at the start.
  copy_bytes=0
  if [ "$includes_media" = true ] && [ -z "$previous" ]; then
    copy_bytes=$(($(du -sk "$MEDIA_DIR" | cut -f1) * 1024))
  fi
  if [ $(($(free_bytes) - copy_bytes)) -lt "$BACKUP_MIN_FREE_BYTES" ]; then
    failure=low-disk
    return 1
  fi

  stamp="$(echo "$running_started" | tr -d ':-')"
  partial="$BACKUP_DIR/.partial-$stamp"
  mkdir -p "$partial"

  db_name="db.sql.gz"
  [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ] && db_name="db.sql.gz.enc"
  # `--clean --if-exists` so a restore over a populated database replaces it
  # rather than colliding; ownership and grants are the target cluster's.
  if ! pg_dump ${DATABASE_URL:+-d "$DATABASE_URL"} --clean --if-exists --no-owner --no-privileges |
    gzip -9 | encrypt_if_configured >"$partial/$db_name"; then
    rm -rf "$partial"
    failure=dump-failed
    return 1
  fi

  if [ "$includes_media" = true ]; then
    rsync -a ${previous:+"--link-dest=$previous"} "$MEDIA_DIR/" "$partial/media/"
    rsync_exit=$?
    # 24: a file vanished mid-copy because the app deleted it after the dump.
    # The dump still names it, so that one Track restores without its audio,
    # as the live instance already had it gone. Failing the run instead would
    # make backups flaky under ordinary deletes.
    if [ "$rsync_exit" -ne 0 ] && [ "$rsync_exit" -ne 24 ]; then
      rm -rf "$partial"
      failure=media-failed
      return 1
    fi
    read -r media_bytes media_files <<EOF
$(ls -lnR "$partial/media" | awk '/^-/ { files++; bytes += $5 } END { printf "%.0f %d", bytes, files }')
EOF
  fi

  # Rotation must never make room for a backup that did not land whole.
  if ! write_manifest "$partial" || ! mv "$partial" "$BACKUP_DIR/liedmotif-backup-$stamp"; then
    rm -rf "$partial"
    failure=dump-failed
    return 1
  fi
  log "wrote liedmotif-backup-$stamp"
  rotate
}

# The attempt that finished last stays in `status.json` until this one ends.
run_backup() {
  running_trigger="$1"
  running_started="$now"
  write_status

  # The status is the web app's liveness signal and goes stale after three
  # minutes; a first media snapshot can take far longer than that.
  ( while sleep "$CHECK_SECONDS"; do write_status; done ) >/dev/null 2>&1 &
  heartbeat=$!

  failure=''
  make_backup
  attempt_started="$running_started"
  if [ -z "$failure" ]; then
    record_success
  else
    record_failure "$failure"
  fi

  kill "$heartbeat" 2>/dev/null
  wait "$heartbeat" 2>/dev/null
  running_trigger=''
  last_success="$(newest_success_at)"
  assess
  write_status
}

# Values from the last due query that answered, kept across checks so a
# database blip does not blank the status.
enabled='' frequency='' keep='' include_media='' last_slot='' next_run_at=''
requested_at='' running_trigger='' running_started='' database_down=false overdue=false
healthy=true

check() {
  now="$(date -u "+$ISO")"
  read_attempt
  last_success="$(newest_success_at)"
  retry_pending=false
  [ -n "$attempt_error" ] && [ "$now" \< "$retry_at" ] && retry_pending=true

  trigger=''
  if row="$(psql ${DATABASE_URL:+-d "$DATABASE_URL"} -X -A -t -F '|' -v ON_ERROR_STOP=1 -v now="$now" -f "$DUE_SQL")"; then
    "$database_down" && log 'database reachable again'
    database_down=false
    IFS='|' read -r enabled frequency _weekday _hour keep include_media _timezone \
      requested_at last_slot next_slot <<EOF
$row
EOF
    next_run_at=''
    [ "$enabled" = t ] && next_run_at="$next_slot"
    assess
    # An unreachable database is recorded only so a setup that never backed up
    # shows it. With the schedule off nothing was due, so once the database
    # answers the record is withdrawn; the start time stays, so a Back up now
    # request it already covered stays handled.
    if [ "$attempt_error" = database-unreachable ] && [ "$enabled" != t ]; then
      attempt_finished='' attempt_error='' retry_at='' retry_delay=0
      write_attempt
    fi

    # A Back up now request runs once, even with the schedule off, and skips
    # any retry backoff.
    if [ -n "$requested_at" ] && { [ -z "$attempt_started" ] || [ "$requested_at" \> "$attempt_started" ]; }; then
      trigger=manual
    elif [ "$overdue" = true ] && [ "$retry_pending" = false ]; then
      trigger=schedule
    fi
  else
    "$database_down" || log 'database unreachable'
    database_down=true
    # Without the settings nothing can be scheduled. Only a setup that has
    # never backed up records the failure, so a broken one shows up within a
    # minute. An established one keeps its last report: the database restarts
    # on every deploy, and a recorded failure would read as failing until the
    # next scheduled run.
    if [ -z "$last_success" ]; then
      overdue=true healthy=false
      if [ "$retry_pending" = false ]; then
        attempt_started="$now"
        record_failure database-unreachable
      fi
    fi
  fi

  write_status
  [ -n "$trigger" ] && run_backup "$trigger"
  return 0
}

# --- Restore -------------------------------------------------------------------
# `<archive>` is a backup downloaded from Settings → Backups (`.tar.enc`) or the
# name of a folder under BACKUP_DIR. Everything that can be checked without
# touching the target is checked first, and a run without `--yes` stops there
# having said what it would replace. The target is the database DATABASE_URL
# (or else PG*) names and MEDIA_DIR.
#
# psql's and rsync's own errors pass through, as in the backup loop: they say
# which statement or file failed.

restore_refuse() {
  echo "restore: $*" >&2
  exit 1
}

# A worker that reported within WORKER_HEARTBEAT_STALE_AFTER_MS (30 s) would
# keep writing into the database while it is replaced. A database without the
# table (a fresh target) or out of reach answers no; the replay then reports
# what is wrong.
worker_running() {
  [ "$(psql ${DATABASE_URL:+-d "$DATABASE_URL"} -X -A -t -c "SELECT (value->>'ts')::timestamptz > now() - interval '30 seconds' FROM app_settings WHERE key = 'workerHeartbeat'" 2>/dev/null)" = t ]
}

# SQL that empties every schema the dump `$1` fills, run ahead of it in the
# same transaction. The dump's own `--clean` drops only the objects it holds, so
# a table a newer migration added (say, one with a foreign key to `tracks`)
# would block it and survive it; the restored database must be exactly the
# backup. pg_dump writes `CREATE SCHEMA` for every schema but `public`, which it
# assumes exists, so `public` is dropped and recreated here.
replay_into_empty_schemas() {
  echo 'DROP SCHEMA IF EXISTS public CASCADE;'
  gunzip -c "$1" | sed -n 's/^CREATE SCHEMA \(.*\);$/DROP SCHEMA IF EXISTS \1 CASCADE;/p'
  echo 'CREATE SCHEMA public;'
}

# openssl's own errors are dropped: they say nothing the refusal does not.
decrypt() {
  openssl enc -d $CIPHER -pass env:BACKUP_ENCRYPTION_PASSPHRASE "$@" 2>/dev/null
}

restore() {
  archive='' confirmed=false
  for arg in "$@"; do
    case "$arg" in
      --yes) confirmed=true ;;
      *) archive="$arg" ;;
    esac
  done
  [ -n "$archive" ] ||
    restore_refuse 'usage: liedmotif-backup restore <liedmotif-backup-<stamp>.tar.enc | liedmotif-backup-<stamp>> [--yes]'

  work="$(mktemp -d)" || restore_refuse 'could not create a temporary directory'
  trap 'rm -rf "$work"' EXIT

  backup=''
  if [ -f "$archive" ]; then
    [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ] ||
      restore_refuse 'a downloaded backup is encrypted: set BACKUP_ENCRYPTION_PASSPHRASE'
    decrypt -in "$archive" | tar -xf - -C "$work" 2>/dev/null ||
      restore_refuse 'could not open the archive: wrong BACKUP_ENCRYPTION_PASSPHRASE, or not a complete Liedmotif backup download'
    for dir in "$work"/liedmotif-backup-????????T??????Z; do
      [ -d "$dir" ] && backup="$dir"
    done
    [ -n "$backup" ] || restore_refuse 'the archive holds no backup folder: not a Liedmotif backup download'
  elif [ -d "$BACKUP_DIR/$archive" ]; then
    backup="$BACKUP_DIR/$archive"
  else
    restore_refuse "no archive file or backup named $archive"
  fi

  manifest="$backup/manifest.json"
  [ -f "$manifest" ] || restore_refuse "${backup##*/} has no manifest.json: not a Liedmotif backup"
  format="$(grep -o '"format"[[:space:]]*:[[:space:]]*[0-9]*' "$manifest" | grep -o '[0-9]*$')"
  [ "$format" = 1 ] ||
    restore_refuse "backup format ${format:-?} is unknown to this version: restore it with the Liedmotif version that made it, or a newer one"

  if [ -f "$backup/db.sql.gz.enc" ]; then
    [ -n "$BACKUP_ENCRYPTION_PASSPHRASE" ] ||
      restore_refuse 'the database dump is encrypted: set BACKUP_ENCRYPTION_PASSPHRASE'
    dump="$work/db.sql.gz"
    decrypt -in "$backup/db.sql.gz.enc" -out "$dump" ||
      restore_refuse 'could not decrypt the database dump: wrong BACKUP_ENCRYPTION_PASSPHRASE?'
  else
    dump="$backup/db.sql.gz"
  fi
  # The whole dump is verified before the replay starts: psql commits whatever
  # it was fed when its input ends, so a truncated stream would commit a
  # partial database.
  gunzip -t "$dump" 2>/dev/null || restore_refuse 'the database dump is missing or damaged'

  includes_media=false
  if grep -q '"includesMedia"[[:space:]]*:[[:space:]]*true' "$manifest"; then
    [ -d "$backup/media" ] ||
      restore_refuse "${backup##*/} is incomplete: its manifest lists music and covers, but it holds none"
    includes_media=true
  fi

  echo "Restoring ${backup##*/}. This replaces:"
  if [ -n "$DATABASE_URL" ]; then
    # Host, port and name only: the user, password and query stay out of the output.
    target="${DATABASE_URL%%\?*}"
    echo "  - the database ${target##*@}"
  else
    echo "  - the database ${PGDATABASE:-?} on ${PGHOST:-localhost}:${PGPORT:-5432}"
  fi
  if [ "$includes_media" = true ]; then
    echo "  - every file in $MEDIA_DIR"
  else
    echo "This backup holds no music or covers, so $MEDIA_DIR stays as it is and restored Tracks may not play."
  fi
  if worker_running; then
    restore_refuse 'the Liedmotif worker reported to this database in the last 30 s: stop the app (npm run dev, or docker compose stop web worker) and try again'
  fi
  if [ "$confirmed" = false ]; then
    restore_refuse 'nothing changed: run it again with --yes to replace them'
  fi
  # Before the database, so a read-only media mount (the `backup` service's
  # own `/data`) cannot leave a restored database beside the old media.
  if [ "$includes_media" = true ]; then
    { touch "$MEDIA_DIR/.liedmotif-restore" && rm -f "$MEDIA_DIR/.liedmotif-restore"; } 2>/dev/null ||
      restore_refuse "nothing changed: $MEDIA_DIR is not writable. On a Docker host, add -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data (https://liedmotif.com/docs/backups/#restore-a-backup)"
  fi

  # One transaction, committed only after the whole dump went through: a
  # failing statement, or input that ends early (the dump unreadable mid-way),
  # rolls the replay back and leaves the database as it was. psql's own
  # `--single-transaction` would commit whatever it got at end of input. The
  # dump's `--clean --if-exists` drops are chatty notices on a fresh database;
  # only warnings and errors are shown.
  {
    echo 'BEGIN;'
    replay_into_empty_schemas "$dump" && gunzip -c "$dump" && echo 'COMMIT;'
  } |
    PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning" \
      psql ${DATABASE_URL:+-d "$DATABASE_URL"} -X -v ON_ERROR_STOP=1 >/dev/null ||
    restore_refuse 'the dump did not replay; the database is unchanged'

  # Media after the database, so a replay that fails leaves both untouched.
  if [ "$includes_media" = true ]; then
    rsync -a --delete "$backup/media/" "$MEDIA_DIR/" && chown -R "$MEDIA_OWNER" "$MEDIA_DIR" ||
      restore_refuse "the database is restored, but syncing $MEDIA_DIR failed: run the restore again"
  fi

  echo "Restored ${backup##*/}. Before you start the app:"
  echo "  - Use the backed-up instance's CREDENTIAL_ENCRYPTION_KEY, or its saved provider keys"
  echo "    can't be read and have to be entered again in Settings."
  echo "  - With a different APP_SECRET or BETTER_AUTH_SECRET, everyone is signed out and signs"
  echo "    in again with their password."
  echo "  - Migrations newer than the backup run on the next start (docker compose up -d), or"
  echo "    with npm run db:migrate for npm run dev."
  echo "  - A copy of another instance keeps that instance's provider keys: generating here spends"
  echo "    on its provider accounts until you replace them."
}

# --- Modes ---------------------------------------------------------------------

start() {
  mkdir -p "$BACKUP_DIR"
  if [ -z "$BACKUP_ENCRYPTION_PASSPHRASE" ]; then
    log 'WARNING: BACKUP_ENCRYPTION_PASSPHRASE is unset — dumps are written unencrypted'
  fi
  if [ -n "${BACKUP_INTERVAL_SECONDS:-}${BACKUP_KEEP:-}${BACKUP_INCLUDE_MEDIA:-}" ]; then
    log 'BACKUP_INTERVAL_SECONDS, BACKUP_KEEP and BACKUP_INCLUDE_MEDIA are ignored: the schedule, keep count and media setting live in Settings → Backups'
  fi
}

case "${1:-}" in
  --healthcheck)
    [ -n "$(find "$HEALTHY_FILE" -mmin -3 2>/dev/null)" ]
    ;;
  restore)
    shift
    restore "$@"
    ;;
  # One check, then exit: what the loop does once a minute.
  --once)
    start
    check
    ;;
  *)
    start
    log "checking every ${CHECK_SECONDS}s; the schedule lives in Settings → Backups"
    while true; do
      check
      sleep "$CHECK_SECONDS"
    done
    ;;
esac
