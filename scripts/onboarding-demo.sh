#!/usr/bin/env bash
#
# A throwaway Liedmotif instance for walking first-login onboarding end to end.
#
#   npm run onboarding:demo             start it (provisions on first run)
#   npm run onboarding:demo -- reset    wipe it and start over from /setup
#   npm run onboarding:demo -- down     delete its database and files
#
# It gets its OWN database and its OWN DATA_DIR, so the instance named by
# DATABASE_URL — tracks, sessions, profile, People, limits, credentials — is never
# read or written. Everything else, including the provider keys, comes from `.env`.
# Switching back to your own instance is just Ctrl-C and `npm run dev`; `down` exists
# only to reclaim the demo's database when you are finished with it for good.
#
# Web only, no worker, so no music is ever bought. Onboarding can be finished —
# including "Start your first Session" — without anything reaching a provider, but
# the web app itself still calls the text LLM from `.env` when asked to: starting a
# Session from Home afterwards, or the Assistant.
#
# Served on 127.0.0.1 rather than localhost deliberately: cookies ignore the port, so
# two instances on "localhost" would share one session cookie and sign each other out.
# A different hostname means a different cookie jar, and both can be open at once.

set -euo pipefail

DEMO_DB=liedmotif_onboarding_demo
DEMO_PORT=${ONBOARDING_DEMO_PORT:-2207}
DEMO_URL="http://127.0.0.1:${DEMO_PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DATA="${ONBOARDING_DEMO_DATA:-${ROOT}/data/onboarding-demo}"

cd "$ROOT"

# The demo database on the same server as DATABASE_URL, with the name swapped.
demo_database_url() {
  npx --yes dotenv -- node -e "
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/${DEMO_DB}';
    process.stdout.write(url.toString());
  "
}

# Run SQL against the server's maintenance database (CREATE/DROP DATABASE cannot run
# inside the database being dropped).
maintenance_sql() {
  npx --yes dotenv -- node -e "
    const { Client } = require('pg');
    const url = new URL(process.env.DATABASE_URL);
    const owner = url.username;
    url.pathname = '/postgres';
    (async () => {
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      await client.query(process.argv[1].replace('{owner}', owner));
      await client.end();
    })().catch((error) => { console.error(error.message); process.exit(1); });
  " -- "$1"
}

# Resolved once, from the repo root: `dotenv` reads `.env` relative to the working
# directory, and the steps below run from elsewhere.
DEMO_DB_URL="$(demo_database_url)"

destroy() {
  maintenance_sql "drop database if exists ${DEMO_DB} with (force)"
  rm -rf "$DEMO_DATA"
}

# Idempotent, so a start after an interrupted provision heals itself rather than
# handing the app an empty database: an existing database is accepted, and both
# migrate and seed are no-ops when there is nothing to do.
provision() {
  npx --yes dotenv -- node -e "
    const { Client } = require('pg');
    const url = new URL(process.env.DATABASE_URL);
    const owner = url.username;
    url.pathname = '/postgres';
    (async () => {
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      try {
        await client.query('create database ${DEMO_DB} owner ' + owner);
      } catch (error) {
        // 42P04 = duplicate_database, which is the state this wants anyway.
        if (error.code !== '42P04') throw error;
      }
      await client.end();
    })().catch((error) => { console.error(error.message); process.exit(1); });
  "
  mkdir -p "$DEMO_DATA"
  # drizzle-kit resolves its migrations folder relative to the working directory.
  (cd packages/db && npx --yes dotenv -e ../../.env -- env DATABASE_URL="$DEMO_DB_URL" \
    npx drizzle-kit migrate)
  npx --yes dotenv -- env DATABASE_URL="$DEMO_DB_URL" DATA_DIR="$DEMO_DATA" \
    npx tsx packages/db/src/seed.ts
}

case "${1:-start}" in
  down)
    destroy
    echo "demo instance deleted"
    exit 0
    ;;
  reset)
    destroy
    provision
    ;;
  start)
    provision
    ;;
  *)
    echo "usage: onboarding-demo.sh [start|reset|down]" >&2
    exit 2
    ;;
esac

# Quoted delimiter: the banner is literal text, so nothing in it — including any
# command it names — can be substituted and run.
cat <<'BANNER'

  Sign up at the URL below, then onboarding starts by itself.

  Provider keys come from .env, so the provider steps show their
  "already configured from the environment" state. To exercise the
  paste-a-key state instead, start it with the keys blanked:

    SUNO_API_KEY= LLM_API_KEY= npm run onboarding:demo

  Ctrl-C to stop; "npm run dev" puts you back on your own instance.

BANNER

printf '  sign up   %s/setup\n  database  %s   (the instance in DATABASE_URL is untouched)\n  storage   %s\n\n' \
  "$DEMO_URL" "$DEMO_DB" "$DEMO_DATA"

cd apps/web
exec npx --yes dotenv -e ../../.env -- env \
  DATABASE_URL="$DEMO_DB_URL" \
  DATA_DIR="$DEMO_DATA" \
  APP_PUBLIC_URL="$DEMO_URL" \
  npx next dev -p "$DEMO_PORT"
