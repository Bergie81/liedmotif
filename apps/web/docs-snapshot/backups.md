---
title: Backups and restore
description: How Liedmotif protects your library, how to keep a copy somewhere safe, and how to restore it on the same machine or a new one.
checkedOn: 2026-11-07
---

A deleted volume, a mistyped command, a dead disk or ransomware could otherwise take every session, playlist and track with it. So backups start with Liedmotif and need nothing from you. Your job is the part software can't do for you: keep one copy off the machine, and keep your secrets safe.

## What's in a backup

One backup is one folder holding the whole library at one moment: the database, with every account and prompt, and a copy of your music, covers and people's photos. The two belong together, because a database restored beside the wrong files gives you tracks that won't play. Liedmotif copies the database first and the files right after it, so the files cover what the database names. The one gap is a file deleted while the backup runs: it can be missing from the copy, and that one track won't play after a restore.

## Set the schedule

Open **Settings › Backups**. Only the admin sees this page.

| Setting | Choices | Default |
| --- | --- | --- |
| **Scheduled backups** | On or off. When off, backups run only from **Back up now** | On |
| How often | Daily or weekly | Weekly |
| **Day** | Any day of the week, for weekly backups | Sunday |
| **Time** | Any hour, in your instance timezone | 03:00 |
| **Keep** | 1 to 52 backups. Older ones are deleted after a new one finishes | 4 |
| **Include music & covers** | On or off | On |

**Instance timezone** shows on the same page. You change it in **Settings › Cost limits**, and it also sets when limits reset.

The defaults are a starting point. Ask yourself how much music you could stand to lose, and how often you'd copy a backup somewhere else.

## When backups run

The backup service checks once a minute. It runs a backup when a scheduled time has passed since the newest finished backup, or when you press **Back up now**.

- **Restarts and updates never make a backup.** They can't push a scheduled one out of your list.
- **A time missed while the machine was off runs when it comes back.**
- **The first backup runs within a minute** of a new install, so a broken setup shows up at once.
- **A failed run tries again after 5 minutes while a scheduled backup is due,** then waits twice as long each time, up to a day. **Back up now** skips the wait. To change the first wait, set `BACKUP_RETRY_SECONDS` in `.env`. A failed **Back up now** with no scheduled backup due doesn't retry, so press it again.
- **A new backup never costs you the old one.** A run works in a temporary folder and takes its final name only when it's complete. Old backups are deleted only after that.

## Back up now

**Back up now** runs one backup right away, even with the schedule off. It starts within a minute. Press it before an update or any risky change, and wait for the new backup to appear in the list.

## Read the status

The **Status** card tells you whether you're protected.

| Badge | What it means |
| --- | --- |
| **Healthy** | Backups run on schedule, or the schedule is off and **Back up now** still works. |
| **Requested** | **Back up now** was pressed. The backup starts within a minute. |
| **Running** | A backup is running right now. |
| **Overdue** | A scheduled backup is due and hasn't run yet. |
| **Failing** | The last backup failed. The card gives the reason, and the next try when one is planned. |
| **Not running** | The backup service has stopped reporting. No backup runs until it's back. |

Below the badge you see **Last success**, **Next run**, **Disk used** and **Free space**. A warning that starts with "Unencrypted" means your database dumps are readable by anyone with the disk. [Encryption and the passphrase](#encryption-and-the-passphrase) explains the fix.

**Failing** gives one of four reasons:

| The card says | What to do |
| --- | --- |
| the database dump failed | Read the log below. |
| copying music and covers failed | Read the log below. |
| the backups disk is nearly full | See [Disk use](#disk-use). |
| the database could not be reached | Check that `postgres` is healthy with `docker compose ps`. |

The log has the real error, and it never shows a password or the passphrase. These also list what ran, what was removed and why a run failed:

```bash
docker compose logs backup
docker compose exec backup ls -l /backups
```

In `docker compose ps`, `backup` turns `healthy` once the first backup has finished. It turns unhealthy when its once-a-minute check stops, or when the schedule is on and the last success is more than one scheduled time behind. The page warns sooner, as soon as one time is missed.

## Encryption and the passphrase

Set `BACKUP_ENCRYPTION_PASSPHRASE` in `.env` and every database dump is encrypted (AES-256-CBC with PBKDF2). The installer and the [laptop guide](/docs/install/local) both set it for you.

If it's blank:

- Dumps are written in the clear.
- Every start logs `WARNING: BACKUP_ENCRYPTION_PASSPHRASE is unset`.
- **Settings › Backups** warns you, and **Download** stays off.

To set it later, add it to `.env` and run `docker compose up -d`.

Music, covers and photos in a backup are plain files either way, because that's what lets backups share unchanged files. Treat the backups volume as carefully as the music itself.

A dump stays encrypted with the passphrase it was written under, and a restore opens it with the one in `.env`. So before you change the passphrase, download the backups you want to keep, and keep the old passphrase with them until every older backup has been rotated out. An older backup downloaded after the change won't restore: the file uses the new passphrase and the dump inside it the old one. To restore an older backup still on the machine, put the old passphrase back in `.env` for that restore.

## Download a copy

Every backup in the list has a **Download** button. You get one file, `liedmotif-backup-<stamp>.tar.enc`: the whole backup, encrypted with your passphrase.

It holds every account's content, which is why it opens only with the passphrase from `.env`. The app never shows that passphrase, so even a stolen admin sign-in only gets a file it can't open.

To check that a download opens, without restoring it, run this on a computer with your passphrase in the shell:

```bash
read -rs BACKUP_ENCRYPTION_PASSPHRASE && export BACKUP_ENCRYPTION_PASSPHRASE
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE -in liedmotif-backup-20261101T020000Z.tar.enc |
  tar -tvf - | head
```

The first line waits for you to paste the passphrase and press <kbd>Enter</kbd>. You should see a list of files.

## Where backups live, and why that's not enough

Your instance keeps its data in Docker volumes, listed in [Email and storage](/docs/email-and-storage#where-your-data-lives). Backups have their own volume, `liedmotif-backups`, so losing the database or the music volume doesn't take them along. They still sit on the same disk. They protect you from a mistake, not from a dead disk, a stolen laptop or ransomware that can write to that disk.

> **`docker compose down -v` deletes every volume, backups included.** Plain `docker compose down` is safe. Download a backup on a rhythm that suits you and keep it off the machine, with your `.env` stored separately.

Inside the volume, it looks like this. The stamp is UTC.

```
/backups/
  status.json                         what Settings › Backups reads
  .last-attempt  .healthy             the service's own notes
  liedmotif-backup-20261101T020000Z/   one complete backup
    db.sql.gz.enc                     the database (db.sql.gz without a passphrase)
    media/                            a copy of your files
    manifest.json                     when, why and what it holds
  .partial-20261108T020000Z/          a run in progress
```

## Disk use

Music and covers cost about one library, not one per backup. Each backup links to every file that hasn't changed since the last one, so four backups of a 20 GB library take about 20 GB plus what changed between them. Deleting one backup never affects the others, and **Disk used** counts each shared file once. The first backup copies the whole library, so it needs that much room.

Backups share a disk with your database, and a full disk takes the database down. So a backup is refused when it would start with less than 2 GiB free. The first backup with music is also refused if the copy would leave less than that. Later ones copy only what changed, so they're checked only at the start. The page then says the backups disk is nearly full. A refused backup deletes nothing, so first free up disk space or add more. Then, to need less room:

- Lower **Keep**. Older backups go only after the next backup finishes, so this frees nothing right away.
- Turn **Include music & covers** off. That skips copying your files, but a backup still needs the 2 GiB free.

The 2 GiB floor is `BACKUP_MIN_FREE_BYTES` in `.env`.

## If your music lives in object storage

With `STORAGE_PROVIDER=s3` there are no local files to copy. Backups hold the database only, and the list says "Database only · object storage". Turn on versioning for your bucket. If you also snapshot the bucket, do it at or after the database backup, never before: a track whose file is missing from the snapshot will never play. [Email and storage](/docs/email-and-storage) covers the setup.

## Keep these secrets

A backup is only half of a recovery. These lines in `.env` aren't in the backup, on purpose: whoever got the backup would otherwise get your provider keys too.

| Line in `.env` | Without it |
| --- | --- |
| `CREDENTIAL_ENCRYPTION_KEY` | Your saved provider keys can never be read again. You enter them again. |
| `APP_SECRET`, `BETTER_AUTH_SECRET` | Everyone is signed out, and signs in again with their password. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Your encrypted backups can't be opened. A backup with a lost passphrase is a deleted backup. |

Keep them in a password manager or a sealed offline copy, with tighter access than the backups themselves. Never store them next to a downloaded backup.

## Restore a backup

A restore replaces the database with the one in the backup, and replaces every file in your library if the backup holds files. It works from a backup on the machine or from a downloaded `.tar.enc`. The host needs nothing but Docker, since the tools come with the backup image.

It's careful about it, in this order:

1. It checks everything it can without touching anything: it decrypts the backup, reads what's in it and tests the database dump.
2. It prints what it will replace and stops there unless you add `--yes`. Run it once without `--yes` to see the targets.
3. It refuses while the app's worker has reported in the last 30 seconds.
4. It replays the database in one transaction. If that fails, your database stays as it was.
5. Only then does it copy the files, deleting any that the backup doesn't hold. A backup without music leaves your files alone and warns that restored tracks may not play.

Three rules before you start the app again:

- **Same secrets.** The `.env` you restore into needs the `CREDENTIAL_ENCRYPTION_KEY` of the instance that made the backup, or its saved provider keys stay unreadable. Its `APP_SECRET` and `BETTER_AUTH_SECRET` keep everyone signed in. With new ones, people sign in again with their passwords. An encrypted backup also needs its `BACKUP_ENCRYPTION_PASSPHRASE`.
- **Same version or newer.** Database updates that are newer than the backup run at the next start. Never restore into an older Liedmotif.
- **Provider keys come along.** A copy of an instance keeps that instance's keys, so making music there spends on its provider accounts until you replace them.

A downloaded file also needs temporary disk space while it's unpacked: about the size of the backup, in Docker's disk. On Docker Desktop that's its virtual disk.

Each command below is for a machine where your user can reach Docker. If it can't, write `sudo docker` for `docker`.

### On the same machine

Use this to take your instance back to an earlier moment. Run it from your install folder: `/opt/liedmotif` unless you chose another, or the `liedmotif` folder on a laptop.

```bash
cd /opt/liedmotif
docker compose stop web worker
sleep 30   # the restore refuses while the worker's last report is fresh
docker compose exec backup ls /backups   # find the name of the backup you want
```

Restore a backup from this machine, by its name:

```bash
docker compose run --rm -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data \
  backup restore liedmotif-backup-20261101T020000Z --yes
```

Or restore a downloaded file, here in the current folder:

```bash
docker compose run --rm -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data \
  -v "$PWD/liedmotif-backup-20261101T020000Z.tar.enc:/restore/archive:ro" \
  backup restore /restore/archive --yes
```

Then start the app. This also brings the database up to your current version:

```bash
docker compose up -d
```

The `-v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data` part is needed because the backup service can only read your files, not change them. Without it, the restore refuses before changing anything. If you moved your music to a `./data` folder, as in [Email and storage](/docs/email-and-storage), write `-v "$PWD/data:/restore/data"` instead of `-v liedmotif-data:/restore/data` in every restore command.

### On a new machine

Use this to move your instance to a new server, or to recover from a dead one.

**1. Get what you need from the old instance:** a downloaded backup and your copy of `.env`.

**2. Install Liedmotif on the new machine** the normal way: the [home server](/docs/install/home-server) or [cloud](/docs/install/cloud) guide. Ignore the setup link it prints. The restore brings your admin account back.

**3. Put the old secrets into the new `.env`.** Replace the values of these four lines with the ones from your old `.env`:

```text
APP_SECRET=
BETTER_AUTH_SECRET=
CREDENTIAL_ENCRYPTION_KEY=
BACKUP_ENCRYPTION_PASSPHRASE=
```

Leave the database lines as the new install wrote them, and the address lines too unless the new machine takes over the old address. Copy over anything else you set by hand, such as `SMTP_URL`, `MAIL_FROM` and the `ALERT_` lines. [Instance alerts](/docs/alerts) also need their scheduled check set up again, because it lives on the machine rather than in `.env`.

**4. Put the backup in the install folder, and restore it:**

```bash
cd /opt/liedmotif
docker compose stop web worker
sleep 30
docker compose run --rm -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data \
  -v "$PWD/liedmotif-backup-20261101T020000Z.tar.enc:/restore/archive:ro" \
  backup restore /restore/archive --yes
docker compose up -d
```

If you never started the stack on this machine, skip the `stop` and the `sleep`. `docker compose run` then starts only the database and its setup, and the restore replaces that fresh database with your backup.

**5. Sign in with your old admin account** at the new address, and play an old track. Keep the old instance switched off from now on: both copies spend on the same provider accounts.

### On a laptop

The commands are the same. Run them from your `liedmotif` folder, and put the backup there too:

```bash
docker compose stop web worker
sleep 30
docker compose run --rm -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data \
  -v "$PWD/liedmotif-backup-20261101T020000Z.tar.enc:/restore/archive:ro" \
  backup restore /restore/archive --yes
docker compose up -d
```

For a copy of a server, put that server's four secrets into the laptop's `.env` first, as in [step 3 above](#on-a-new-machine).

If you run the app from source with `npm run dev`, stop it first and use the restore script. It takes a downloaded file only, and it assumes Docker Desktop. It builds the backup image itself:

```bash
npm run backup:restore -- ~/Downloads/liedmotif-backup-20261101T020000Z.tar.enc --yes
npm run db:migrate
```

### If a restore refuses

| The restore says | What to do |
| --- | --- |
| `nothing changed: run it again with --yes to replace them` | This is the dry run. Read the targets, then add `--yes`. |
| `the Liedmotif worker reported to this database in the last 30 s` | Run `docker compose stop web worker`, wait half a minute and try again. |
| `nothing changed: /data is not writable` | Add `-v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data`, as in the commands above. |
| `a downloaded backup is encrypted: set BACKUP_ENCRYPTION_PASSPHRASE` | Put the passphrase in `.env`. |
| `could not open the archive: wrong BACKUP_ENCRYPTION_PASSPHRASE, or not a complete Liedmotif backup download` | Check the passphrase in `.env`, and that the download finished. |
| `could not decrypt the database dump: wrong BACKUP_ENCRYPTION_PASSPHRASE?` | Use the passphrase the backup was written under. |
| `the database dump is missing or damaged` | Use another backup. |
| `backup format <n> is unknown to this version` | Restore with the Liedmotif version that made it, or a newer one. |
| `the dump did not replay; the database is unchanged` | Read the lines above the message, which name the failing statement. |
| `the database is restored, but syncing <folder> failed: run the restore again` | Fix what the lines above it name, often disk space, and run it again. |

On a managed Postgres, restore as the database owner: the restore recreates the `public` schema, and only the owner may do that. The Postgres that ships with Liedmotif needs nothing.

## Test a restore

A backup you've never restored is a hope. Try one now and then, so a problem shows up while the original still works. Use a Liedmotif on a different computer from your real instance: the restore replaces whatever library it runs on, and the last step below deletes it. A second folder on the same computer isn't separate, because it shares the real instance's Docker volumes by default. To test on one computer, the copy's `.env` needs its own `COMPOSE_PROJECT_NAME` and ports before it first starts.

1. Check that **Settings › Backups** says **Healthy**, and download the newest backup.
2. Put the four secrets into the test computer's `.env` and restore, as in [On a laptop](#on-a-laptop).
3. Check that `docker compose ps -a` shows `migrate` as `Exited (0)`. That proves an older backup still comes up under the current version.
4. Sign in as the admin with your old password. If that fails, check that the address you're using matches `APP_PUBLIC_URL` in `.env`.
5. Open **Settings › AI Providers** and test a saved key. If that fails, the database is back, but `CREDENTIAL_ENCRYPTION_KEY` doesn't match and you'd have to enter your keys again.
6. Play a track from an old session and check its cover. That proves the database and the files belong together.
7. Don't start anything new unless you mean to pay for it, because this copy spends on the real provider accounts. Remove the copy when you're done:

```bash
docker compose down -v
```

Any step that fails is a backup that wouldn't have worked. Fix it before you need it.

## Deleted content in old backups

A deleted track, session or member stays in every backup made before the deletion, until that backup is rotated out. At the defaults, that's four weeks: the keep count times the schedule, as long as new backups keep landing. Old backups are removed only after a new one finishes, so with the schedule off or backups failing, they stay until you delete them. Copies you downloaded are yours to delete.

## Coming from an older version

The schedule, keep count and media setting used to live in `.env`. `BACKUP_INTERVAL_SECONDS`, `BACKUP_KEEP` and `BACKUP_INCLUDE_MEDIA` are now ignored, and the service logs a line saying so at the start. Delete them from `.env`.

The defaults apply until you change them, music and covers included. The first backup runs within a minute of the new service starting and copies the whole library. Without room for that, it's refused as described in [Disk use](#disk-use).

Old backup files (`liedmotif-db-<stamp>.sql.gz` and `liedmotif-media-<stamp>.tar.gz`, with or without `.enc`) stay where they are. They're never listed, rotated or deleted. Once a new backup exists, you can remove them by hand. The first line confirms the new backup, the second shows the old files, and the third deletes them:

```bash
docker compose exec backup sh -c 'ls -d /backups/liedmotif-backup-*'
docker compose exec backup sh -c 'ls -l /backups/liedmotif-db-* /backups/liedmotif-media-*'
docker compose exec backup sh -c 'rm -f /backups/liedmotif-db-* /backups/liedmotif-media-*'
```
