# Liedmotif local setup instructions

This guide runs Liedmotif locally with a SunoAPI key and an optional real text LLM.

The current easiest path is host development with Docker only for Postgres. The
`npm` scripts (`dev`, `db:migrate`, `db:migrate:worker`, `db:seed`) auto-load `.env`
via `dotenv-cli`, so they run in any terminal without exporting anything first.

## Prerequisites

- Node.js 24+
- npm 11+
- Docker Engine + Docker Compose v2
- A SunoAPI key from https://sunoapi.org — a third-party API for Suno models. A
  suno.com account or subscription is not an API key and does not work here.
- Optional: an OpenRouter, OpenAI-compatible, or Ollama text LLM

Install dependencies once:

```bash
npm install
```

## 1. Create `.env`

Copy the example:

```bash
cp .env.example .env
```

The copied `.env.example` starts with Docker Compose defaults. This host-dev guide
runs web/worker/npm scripts on your host, so replace those defaults with the
local-dev values below before sourcing `.env`.

Generate three secrets:

```bash
openssl rand -base64 32
openssl rand -base64 32
openssl rand -base64 32
```

Use the three generated strings like this:

```env
APP_SECRET=first_generated_string
BETTER_AUTH_SECRET=second_generated_string
CREDENTIAL_ENCRYPTION_KEY=third_generated_string
```

Do not paste command placeholders such as `<openssl rand -base64 32>` into `.env`.
The web server enforces this at boot: the shipped `change-me-…` example values
(and any secret under 32 characters) are rejected before a single request is
served.

Your local-dev `.env` should include:

```env
APP_PUBLIC_URL=http://localhost:2206
APP_SECRET=paste_first_generated_string
BETTER_AUTH_SECRET=paste_second_generated_string
CREDENTIAL_ENCRYPTION_KEY=paste_third_generated_string
INSTANCE_TIMEZONE=UTC

DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev
TEST_DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_test
# Persistent, ABSOLUTE path for generated audio + covers (see the DATA_DIR note
# below). This repo's gitignored `data/` folder is the recommended default.
DATA_DIR=/absolute/path/to/liedmotif/data
STORAGE_PROVIDER=local-fs

MUSIC_PROVIDER=suno
SUNO_API_KEY=paste_your_sunoapi_org_key
SUNO_BASE_URL=https://api.sunoapi.org
SUNO_MODEL=V5

NODE_ENV=development
LOG_LEVEL=info
```

Important `.env` rules:

```env
DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev
```

must be one line.

`DATABASE_URL` (your app data) and `TEST_DATABASE_URL` (the throwaway test DB) must
name **different** databases — `liedmotif_dev` vs `liedmotif_test`. Never point
`DATABASE_URL` at a database whose name contains `test`: the test suite drops and
reseeds that database, so sharing it would let `npm test` erase your admin account.
This is enforced: the app refuses to start when `DATABASE_URL` names a database
containing `test`, and the test suites refuse to run against anything else.

`DATA_DIR` is where generated audio and cover images are written. Point it at a
**persistent, absolute** path so tracks survive restarts — this repo's gitignored
`data/` folder is the recommended default. Get its absolute path from the repo root:

```bash
echo "$(pwd)/data"
```

Use that value (for example `/home/you/liedmotif/data`). It must be **absolute**:
the web app and worker run from different working directories, so a relative path
(`./data`) would split their files across two folders and tracks would look missing.
Avoid `/tmp/...` unless you are fine losing tracks on reboot. Anything under the
repo's `data/` folder is gitignored, so your audio never lands in git.

Note the database is the other half: a saved track is audio bytes under `DATA_DIR`
**plus** a metadata row in `liedmotif_dev`. Both must persist together. `liedmotif_dev`
lives in a Docker volume that survives `docker compose stop`, reboots, and
`npm run db:test:down` (which removes only the container); it is destroyed only by
deleting the volume itself (see "Restart from a clean local database").

Also avoid spaces around `=`:

```env
APP_SECRET=value
```

not:

```env
APP_SECRET = value
```

## 2. Choose a text LLM

The text LLM is optional. When one is configured it is always used to expand your
free-text request; without one, your words reach the music model exactly as written,
with the fine-tune picks still applied.

You can skip this section entirely and configure the LLM in the app instead
(first-login onboarding or Settings → Text AI). Env config is an override: when
`LLM_PROVIDER` is set, it and the `LLM_*` values below win over whatever is saved
in the app.

### OpenRouter

```env
LLM_PROVIDER=openrouter
LLM_API_KEY=paste_your_openrouter_key
LLM_MODEL=minimax/minimax-m2.7
LLM_SUPPORTS_STRUCTURED_OUTPUTS=false
```

Leave `LLM_BASE_URL` unset for OpenRouter.

### OpenAI or another OpenAI-compatible API

```env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=paste_your_api_key
LLM_MODEL=gpt-4o-mini
LLM_SUPPORTS_STRUCTURED_OUTPUTS=false
```

For another OpenAI-compatible service, keep `LLM_PROVIDER=openai-compatible` and set
`LLM_BASE_URL` to that service's `/v1` endpoint.

### Ollama

Run Ollama on the same machine as Liedmotif and pull a model:

```bash
ollama pull llama3.1
```

Then configure:

```env
LLM_PROVIDER=ollama
# Docker Compose: the host machine as seen from the containers.
LLM_BASE_URL=http://host.docker.internal:11434
# Running Liedmotif natively (npm run dev / start) instead:
# LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3.1
LLM_API_KEY=
LLM_SUPPORTS_STRUCTURED_OUTPUTS=false
```

Or pick Ollama in onboarding / Settings → Providers: enter the base URL, press
Test, and choose one of the installed models it lists.

On Linux with Docker, Ollama must also listen beyond loopback — see
[Ollama on the same machine](https://liedmotif.com/docs/providers-and-keys/#ollama-on-the-same-machine).
Ollama on another machine is not supported: the provider URL guard refuses LAN
addresses.

**Thinking models** (Qwen 3, DeepSeek R1, …) reason before answering, which on
local hardware can take minutes per request and run past
`LLM_REQUEST_TIMEOUT_MS`. Set `LLM_REASONING_EFFORT=none` to turn thinking off;
leave it blank for models without thinking support. Keep
`LLM_SUPPORTS_STRUCTURED_OUTPUTS=false`: schema-constrained decoding can stall a
local model, while plain JSON parsing answers in seconds.

### No text LLM

Leave LLM config blank:

```env
LLM_PROVIDER=
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
LLM_SUPPORTS_STRUCTURED_OUTPUTS=
```

With no text LLM, sessions still start from your description: the text reaches the
music model exactly as written, with the fine-tune picks applied.

### Mock text LLM

For development only:

```env
LLM_PROVIDER=mock
```

The mock text LLM does not call any API. It deterministically turns your free text
into a Style Snapshot for offline testing.

### Check a model for the Assistant

The Assistant needs a model that calls tools reliably, keeps to what the docs
say, and acts only as asked. To check the configured text LLM, ask it the fixed
question set in `apps/web/lib/assistant/eval/eval-set.ts`:

```bash
npm run assistant:eval
```

Every question is a real Assistant turn with the app's own system prompt, route
map and tools. About half the set asks about the docs. The other half asks about
a user's own music or asks the Assistant to do something with it: play, pause,
favorite, add to a Playlist, start a Session. Those are answered from a small
fixture Library (`apps/web/lib/assistant/eval/fixture.ts`) in place of the
database: the model gets the real tool definitions, a tool that acts reports what
the app would do, and nothing is changed, played or bought. The set is asked
once, one question after the other, and no question is asked again, so a run
costs about 45 questions on that provider, each up to five model calls (a model
call that fails in transit is resent once, as in the app). It resolves the text
LLM as the app does (`LLM_*` in `.env` first, then what is saved under
**Settings › AI Providers**), so the dev database has to be up. To check another
model, name the whole connection for that run; the `LLM_*` settings count only
next to the `LLM_PROVIDER` they describe:

```bash
LLM_PROVIDER=ollama LLM_BASE_URL=http://localhost:11434 LLM_MODEL=llama3.1 npm run assistant:eval
```

The Markdown report lands in `eval-reports/`, which git ignores. It scores each
answer on the docs section read, the link, the language and the screen names,
and each turn on what it did: the expected tool called with the expected values,
nothing done where nothing is expected, a card where one is expected, and no
claim that something was done without a receipt. It records tool calls, prompt
size and time, with the time to answer summed up for the two halves of the set.
Whether an answer is right is not scored: the report puts the question, what was
expected, the tool calls and the answer side by side for you to judge. A question
that fails or gets no answer within 10 minutes is recorded as failed. One model
call is bounded by `LLM_REQUEST_TIMEOUT_MS`, which a slow local model needs
raised.

On the `openai` preset the Assistant ignores `LLM_REASONING_EFFORT` and always
asks with `none`: OpenAI refuses tool calls sent with any other effort. Session
writing keeps the configured effort.

`LLM_PROVIDER=mock npm run assistant:eval` tries the tooling without calling a
model.

## Optional generated Session Covers

Generated Session Covers use OpenRouter, with a key of its own apart from the
optional text LLM's (the same OpenRouter key can serve both). Enter it in
onboarding's "Tailor the Cover art" step or under Settings → Providers → Cover
images; it applies without a restart. To keep it in `.env` instead, which wins
over the app and locks its key field:

```env
IMAGE_PROVIDER=openrouter
IMAGE_API_KEY=paste_your_openrouter_key
```

With no image key anywhere, no paid image request is made: covers then come
from the music provider, drawn from the finished music alone at no extra credit
cost, and Sessions keep the branded placeholder cover only when that source is
unavailable too. A blank `IMAGE_PROVIDER` leaves an `IMAGE_API_KEY` in `.env`
unused. The OpenRouter key is consumed by the worker and never sent to the
browser.

### Try another cover model

Enter another OpenRouter image-model ID in the Model field next to the image
key, in onboarding or **Settings → Providers** (the default is
`google/gemini-3.1-flash-image`); the next cover uses it, with no restart.
`IMAGE_MODEL` in `.env` wins over that field and locks it. The model must
support OpenRouter's Images API; the key's **Test** checks that it does. Only
newly generated Session Covers use the new model; existing covers are not
regenerated.

Image models do not all accept the same request fields, so the adapter asks
OpenRouter what the selected model takes and caches that answer. Nothing to
configure: a model that accepts fewer fields simply receives fewer.

If a probe fails the adapter falls back to its conservative core — model and
prompt only — and reuses that fallback for five minutes before probing again. A
brief OpenRouter outage therefore costs the covers inside it their optional
fields, not every cover until a restart, while a sustained one costs a probe
every five minutes rather than one per cover.

`IMAGE_SUPPORTED_PARAMS` exists only for a *sustained* probe outage, such as a
network that blocks the endpoints route. Leave it blank otherwise — it can only
narrow what discovery reports, never broaden it, and a wrong value fails
silently, dropping your resolution and aspect ratio with no error. If you do
need it, list the fields the model's OpenRouter documentation confirms, chosen
from `resolution`, `aspect_ratio`, `quality`, `negative_prompt`, `n`, `seed`,
`input_references`. Names outside that set are ignored, and omitting
`input_references` disables uploaded-person references.

After changing the model or its request fields, stop and restart `npm run dev` so
the worker reloads `.env`. For a full Docker Compose deployment, recreate the
worker container instead of merely restarting it:

```bash
docker compose up -d --force-recreate worker
```

The first deployment containing the persisted Session Cover ledger requires the
maintenance-window cutover in `docker/README.md`: stop web, gracefully drain the
worker for at least 90 seconds, migrate, then start the replacement web and
worker. A normal rolling restart is unsafe for that one schema/runtime cutover.

### Compare cover models

The opt-in qualification harness captures a controlled, privacy-safe comparison
across exactly two materially different image models. It writes a safe manifest,
checksum-addressed images, and two model-blind rating reports to the directory
selected by `COVER_MODEL_TEST_OUT`. Every generated image is a paid OpenRouter
call. Review both model prices, choose a fresh output directory, and declare the
complete 72-call matrix before authorizing the run:

```bash
COVER_MODEL_TEST=1 \
COVER_MODEL_TEST_AUTHORIZE_SPEND=I_ACCEPT_PAID_COVER_BASELINE \
COVER_MODEL_TEST_MODELS='provider/materially-different-model-a,provider/materially-different-model-b' \
COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT=1 \
COVER_MODEL_TEST_MAX_CALLS=72 \
COVER_MODEL_TEST_BASELINE_RUN='/tmp/liedmotif-cover-qualification/pre-replacement-complete-v1' \
COVER_MODEL_TEST_REFERENCE='/absolute/path/to/controlled-synthetic-person.webp' \
COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC=1 \
COVER_MODEL_TEST_RUN_ID='replacement-YYYYMMDD' \
COVER_MODEL_TEST_OUT='/tmp/liedmotif-cover-qualification/replacement-YYYYMMDD' \
npx dotenv -e .env -- npm run smoke:cover-models -w @liedmotif/worker
```

The reference must be a controlled synthetic identity, never a real person or
profile upload. `COVER_MODEL_TEST_BASELINE_RUN` must point to the frozen complete
pre-replacement run used to build the mixed blind sheets. The harness rejects
fixture subsets, extra models, and ceilings other than 72; a failed provider or
artifact outcome remains evidence and is never rerun. It prints only fixed
failure categories and never records the key, raw prompt, reference bytes, or raw
provider response. Complete both generated blind rating passes before inspecting
model or implementation identity. A failed gate blocks release rather than
weakening thresholds or triggering an automatic paid rerun.

## 3. Validate and load `.env`

Check syntax:

```bash
bash -n .env
```

The app scripts (`npm run dev`, `db:migrate`, `db:seed`) load `.env` themselves, so
you do not need this for them. Export the variables into your shell only for the
plain shell commands below — the `echo "$VAR"` checks, `mkdir -p "$DATA_DIR"`, and
the Suno smoke test:

```bash
set -a
source .env
set +a
```

Confirm the database URL is correct:

```bash
echo "$DATABASE_URL"
```

Expected:

```text
postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev
```

If you see only `postgres://liedmotif:liedmotif@localhost:5433/`, fix the broken
line in `.env`.

If you see `postgres://...@postgres:5432/liedmotif`, you still have the Docker
Compose default. Host-run scripts cannot resolve that hostname; change it to the
`localhost:5433/liedmotif_dev` value above and reload `.env`.

## 4. Start Postgres and create the dev database

```bash
npm run db:test:up
docker compose --profile test exec -T postgres-test createdb -U liedmotif liedmotif_dev
mkdir -p "$DATA_DIR"
```

This starts a local Postgres container on `localhost:5433`. That one container
hosts two databases: `liedmotif_dev` (your app data, from `DATABASE_URL`) and
`liedmotif_test` (throwaway, from `TEST_DATABASE_URL`). The container's own default
database is `liedmotif_test`, so the `createdb` line adds `liedmotif_dev` alongside
it. Keeping the two separate is what stops `npm test` from wiping your dev account.
The `createdb` line is safe to re-run — it errors harmlessly if the database
already exists.

## 5. Migrate and seed

Run these (they auto-load `.env`, so no `source` needed):

```bash
npm run db:migrate
npm run db:migrate:worker
npm run db:seed
```

What they do:

- `db:migrate` creates the app tables.
- `db:migrate:worker` creates the `graphile_worker` job schema.
- `db:seed` creates default settings and the placeholder cover row/asset.

## 6. Optional Suno smoke test

This makes one real paid generation on your SunoAPI account. Run it only if you are ready to spend
provider credits:

```bash
SUNO_SMOKE=1 npm run smoke:suno -w @liedmotif/providers
```

The smoke script prints sanitized status only. It does not print your API key or
provider audio URLs.

## 7. Run the app

```bash
npm run dev
```

Open:

```text
http://localhost:2206
```

On first run, `/setup` asks for one thing: the admin login. Creating it signs you in
and hands over to **first-login onboarding** at `/welcome` — your profile, People,
the music model, the Track ceiling, the text LLM, and the Cover budget. That is where
provider keys are entered (or reported as already configured from `.env`) and where
spend is capped. Work through it and press **Start your first Session**. Until it is
finished, the app and Settings keep returning you to it. To test that flow again
later, see "Testing first-login onboarding" below.

Keep the Track ceiling low while testing — the default is deliberately conservative.
Suno usually returns 2 tracks per provider call, so even a small ceiling can create
multiple tracks.

## 8. Start a real session

Describe a vibe and start the Session. With no text LLM configured, your words go
to Suno exactly as written (with any fine-tune picks applied) and should submit
directly through the worker. With a text LLM configured, the same request uses it
once to create a Style Snapshot, then Suno generates tracks from that snapshot.

The worker sweep runs periodically, so after starting a session it can take a little
time before tracks appear.

## Running in production (Docker Compose)

Everything above is host development. To run Liedmotif permanently on a machine
of your own, use the Docker Compose stack instead — it bundles Postgres, the
web app, the worker, automatic database migrations, and Caddy for HTTPS. The
user guides (installing, phone access, updates, backups) are at
https://liedmotif.com/docs/, the operator reference (ports, certificates, smoke
checklist) is `docker/README.md`; this is the short path.

Clone the repo on the production machine and create a production `.env` from
the example:

```bash
git clone <repo-url> liedmotif && cd liedmotif
cp .env.example .env
```

Edit `.env` — the production values differ from the host-dev ones above:

- `APP_SECRET`, `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` — fresh
  values from `openssl rand -base64 32`.
- `APP_DOMAIN` — the name clients will use: a domain, a Tailscale hostname, or
  the machine's static LAN IP. Caddy issues the certificate for it (its
  internal CA covers LAN IPs and hostnames; install the exported root
  certificate on your devices — see
  https://liedmotif.com/docs/install/phone-access/).
- `APP_PUBLIC_URL=https://<APP_DOMAIN>` — required for Secure session cookies.
- `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443` — Caddy answers on this machine
  only without them. Set `SETUP_TOKEN` first when the internet can reach it.
- Provider keys: `SUNO_API_KEY` (your sunoapi.org key) and the optional `LLM_*` / `IMAGE_*` — or leave
  them blank and enter them in first-login onboarding instead (a key in `.env`
  wins).
- Leave `DATABASE_URL` and `DATA_DIR` out (or ignore them): the containers
  always use their own in-cluster Postgres and the `/data` volume, both held
  in named Docker volumes that survive restarts and rebuilds.

Then start the stack:

```bash
docker compose up -d --build   # first start builds the images and migrates
docker compose ps -a           # postgres/web/worker healthy, migrate Exited (0), caddy up
docker compose logs -f         # follow logs (or: logs -f web / worker / caddy)
```

Open `https://<APP_DOMAIN>`, create the admin account at `/setup`, and walk
first-login onboarding. The stack survives reboots on its own (`restart:
unless-stopped`) as long as the Docker service is enabled at boot
(`systemctl enable docker`).

Quick health check from the machine itself:

```bash
curl -s http://127.0.0.1:2206/api/health   # {"status":"ok","database":true,...}
```

(2206 is the default direct web port, bound to loopback only — set `WEB_PORT`
to move it. LAN devices go through Caddy's HTTPS on 80/443.)

To update to a new version:

```bash
git pull
docker compose up -d --build   # migrations apply automatically
```

then run the production smoke checklist in `docker/README.md`. If you also
develop in a checkout on the same machine, give each instance its own `.env`
with a unique `COMPOSE_PROJECT_NAME` and non-overlapping ports —
`docker/README.md` ("Two instances on one machine") documents that split.

## Testing first-login onboarding

Onboarding runs once per owner, right after the admin account is created. It **writes real
configuration** as you walk it: your profile, the owner Person, your People, the
Track ceiling, the Cover budget, and any provider key you paste. It never touches
tracks, Sessions, or playlists — but walking it on an instance you actually use
will overwrite settings you meant to keep.

So test it on a throwaway instance:

```bash
npm run onboarding:demo
```

That serves a second instance at `http://127.0.0.1:2207` with its **own database**
(`liedmotif_onboarding_demo`) and its **own** `DATA_DIR`, so the instance named by
`DATABASE_URL` is never read or written. It provisions itself on the first run.
Open `http://127.0.0.1:2207/setup`, create a throwaway admin, and onboarding starts
by itself.

It is served on `127.0.0.1` rather than `localhost` on purpose: cookies ignore the
port, so two instances on `localhost` would share one session cookie and sign each
other out. Different hostname, different cookie jar — keep both open at once.

To walk onboarding again from an empty instance:

```bash
npm run onboarding:demo -- reset
```

To go back to your own instance, stop the demo (`Ctrl-C`) and run `npm run dev`.
Nothing else is needed — the two use different ports, databases, and `DATA_DIR`s, so
they never collide and you can leave both running if you prefer.

The demo keeps its database and its seeded covers between runs (about 10 MB). When
you are finished with it for good:

```bash
npm run onboarding:demo -- down
```

The demo runs the **web app only** — no worker. That is deliberate: you can finish
onboarding and press **Start your first Session** without anything reaching a
provider, so a throwaway instance can never spend your credits. Test real generation
on your own instance, where `npm run dev` runs the worker too.

The demo inherits the provider keys from `.env`, so the music and text-LLM steps
show their **already configured from the environment** state — read-only, with a
Test button, because a key typed there could never outrank `.env`. To exercise the
other state (paste a key, test it, save it), blank the keys for that run:

```bash
SUNO_API_KEY= LLM_API_KEY= npm run onboarding:demo
```

Onboarding itself spends nothing. Only starting a Session generates audio, and the
Test buttons make one minimal provider call each.

### Skipping or replaying onboarding on an instance

The stamp is a single `user_settings` row. Read it, set it, or clear it — no other
data is touched either way:

```bash
npm run onboarding:state              # show it
npm run onboarding:state -- complete  # skip onboarding on this instance
npm run onboarding:state -- clear     # run it again on the next visit
```

These act on whatever `DATABASE_URL` points at. Use `complete` on an instance whose
settings you want to keep, so opening the app never diverts you into a flow that
would overwrite them.

## Useful checks

Run local verification:

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs against `TEST_DATABASE_URL` (`liedmotif_test`), which is separate
from your dev database (`liedmotif_dev`), so the suite will not touch your app data.
The split is enforced from both sides: the integration suite refuses to run unless
its target database name contains `test` (and refuses when it equals
`DATABASE_URL`), and the app itself refuses to start when `DATABASE_URL` names a
database containing `test` — so the two can never share a database.

Check worker logs in the terminal running `npm run dev`. You should see provider
resolution and Graphile Worker startup messages.

Check setup values:

```bash
echo "$MUSIC_PROVIDER"
echo "$SUNO_BASE_URL"
echo "$SUNO_MODEL"
echo "$LLM_PROVIDER"
echo "$LLM_MODEL"
```

Do not echo API keys in shared logs or screenshots.

## Troubleshooting

### `liedmotif_dev: command not found`

Your `DATABASE_URL` is split across two lines. Put it on one line:

```env
DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev
```

### `database "liedmotif" does not exist`

Your `.env` did not load or `DATABASE_URL` is still pointing at the fallback
database. Reload it:

```bash
set -a
source .env
set +a
echo "$DATABASE_URL"
```

Then rerun migrations.

### `getaddrinfo ENOTFOUND postgres`

Your host shell is still using the Docker Compose hostname:

```env
DATABASE_URL=postgres://liedmotif:liedmotif@postgres:5432/liedmotif
```

For this host-dev setup, change it to:

```env
DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev
```

Then reload `.env`:

```bash
set -a
source .env
set +a
```

### `CREDENTIAL_ENCRYPTION_KEY must be configured`

Generate a 32-byte base64 key:

```bash
openssl rand -base64 32
```

Paste only the generated value:

```env
CREDENTIAL_ENCRYPTION_KEY=generated_value
```

### Free-text session creation fails

Free text works without a text LLM (your words pass through to the music model as
written). But when a text LLM IS configured it is always used, and a failing one is
a retryable error, never a silent fallback. Check the LLM config:

```bash
echo "$LLM_PROVIDER"
echo "$LLM_MODEL"
```

If you do not want to configure a text LLM yet, leave all `LLM_*` values blank.

### Suno is not used

Check:

```bash
echo "$MUSIC_PROVIDER"
```

It must be:

```text
suno
```

If it is blank or `mock`, the app will use the mock music provider instead.

### Restart from a clean local database

This deletes the local database container **and its data volume** (which holds both
`liedmotif_dev` and `liedmotif_test`), then recreates the dev database from scratch.
It also erases every generated track's **metadata** (the audio files under
`DATA_DIR` stay on disk but become orphaned), so only run it when you want a clean
slate. `npm run db:test:down` alone only removes the container and keeps the
volume — the `docker volume rm` line is the explicitly destructive step:

```bash
npm run db:test:down
docker volume rm -f liedmotif_liedmotif-pg-test
npm run db:test:up
docker compose --profile test exec -T postgres-test createdb -U liedmotif liedmotif_dev
set -a
source .env
set +a
npm run db:migrate
npm run db:migrate:worker
npm run db:seed
```
