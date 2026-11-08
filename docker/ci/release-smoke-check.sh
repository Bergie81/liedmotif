#!/usr/bin/env bash
# Release smoke check (the `smoke` job in .github/workflows/release.yml). Run it
# from an install directory the installer set up with `--domain localhost`.
# It passes when the app answers `/api/health` through Caddy over HTTPS and the
# worker container reports healthy. Both are polled, because the check runs
# right after a start.

set -Eeuo pipefail

# Prints the stack's state and the named services' recent logs, then fails.
fail() {
  echo "::error::$1"
  docker compose ps -a
  docker compose logs --tail 100 "${@:2}"
  exit 1
}

# `--insecure`: Caddy's internal CA signs `localhost`, and the runner does not
# trust it. 60 tries 5 s apart give the app about 5 minutes to come up.
curl -fsS --insecure --max-time 10 --retry 60 --retry-delay 5 --retry-all-errors \
  https://localhost/api/health ||
  fail '/api/health did not answer through Caddy.' caddy web
echo

deadline=$((SECONDS + 300))
until [ "$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q worker)" 2>/dev/null)" = healthy ]; do
  [ "$SECONDS" -lt "$deadline" ] || fail 'The worker did not report healthy within 300 s.' worker
  sleep 5
done
echo 'worker: healthy'
