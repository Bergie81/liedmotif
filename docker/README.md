# Docker / self-hosting

Liedmotif ships as a Docker Compose stack: `postgres`, `migrate` (a one-shot
schema migration), `web`, `worker`, and `caddy` (an HTTPS-capable reverse
proxy). One multi-stage `Dockerfile` at the repo root builds both the `web` and
`worker` runtime targets.

**User guides live on the website,
[liedmotif.com/docs](https://liedmotif.com/docs/):** installing on a laptop, a
home server or a cloud provider, phone access, sharing with a friend, updates,
backups and restore, alerts, account email, storage and troubleshooting. This
file keeps the developer and operator internals they leave out. A user-visible
change updates those pages too.

## Install with one command

User guide: [Install on a home server](https://liedmotif.com/docs/install/home-server/)
(Tailscale mode, the default) and
[Install on a cloud provider](https://liedmotif.com/docs/install/cloud/) (`--domain`). The flags are in
[Installer options](https://liedmotif.com/docs/install/home-server/#installer-options).

On a first run, `docker/install.sh` copies `.env.example` to `.env` (mode `600`)
and generates `APP_SECRET`, `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`POSTGRES_PASSWORD` with the matching `DOCKER_DATABASE_URL`, `SETUP_TOKEN` and
`BACKUP_ENCRYPTION_PASSPHRASE`. It sets `LIEDMOTIF_VERSION`, `APP_DOMAIN` and
`APP_PUBLIC_URL=https://<domain>`; with `--domain` also `CADDY_HTTP_PORT=80` and
`CADDY_HTTPS_PORT=443` (not for `--domain localhost`); in Tailscale mode also
`COMPOSE_FILE` and `TAILSCALE_IP`. A rerun changes only `LIEDMOTIF_VERSION`.

Once Docker is reachable, and before it downloads, copies or writes anything,
the installer refuses a folder when containers of the same Compose project
(`docker ps -a`, stopped ones included) were started from another folder: a
start from there would replace the running app's containers and meet its
database with a new password. The project is `liedmotif`, unless the target
folder's `.env` sets `COMPOSE_PROJECT_NAME`. Folders compare by inode, so a
symlink to the install folder is the same install. The message names the
folder to pass as `--dir`, or, when the containers' folder is gone, points at
`docker compose ls -a`; the installer never stops or removes the other install.
Removing a stale install whose folder is gone takes
`docker compose -p <project> down -v`, which deletes its database and files: a
plain `down` keeps its volumes, and the next install would meet that database
with a new password.

### Update

User guide: [Update Liedmotif](https://liedmotif.com/docs/updates/). The installer always
stops `web`, `caddy` and then `worker` before `migrate` runs, never a plain
`docker compose up -d`; "Session Cover planner cutover" below is why.

### Tailscale mode

What it means for users is on the website:
[What Tailscale mode means for you](https://liedmotif.com/docs/install/home-server/#what-tailscale-mode-means-for-you).
This is how it works.

Caddy stays the edge in Tailscale mode, so the security headers, the request
size limit and the token redaction in the access log all still apply.
`tailscale serve` is not used: it would bypass Caddy.

Caddy gets the `*.ts.net` certificate from the machine's `tailscaled`, which it
reaches over a socket in `/var/run/tailscale`. Caddy runs in a container, so
setting `APP_DOMAIN` alone is not enough: the container cannot see that socket
until it is mounted. `docker-compose.tailscale.yml` does two things:

- It mounts `/var/run/tailscale` into the `caddy` container, read-only.
- It publishes ports 80 and 443 on the machine's Tailscale address
  (`TAILSCALE_IP`) only. A phone or
  laptop on your home Wi-Fi that is not in your tailnet gets "connection
  refused".

The installer turns the file on by writing
`COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml` and
`TAILSCALE_IP` into `.env`. Without those lines Compose never loads it, so
`npm run docker:up` and Docker Desktop on macOS work as before. Replacing the
ports needs Docker Compose 2.24.4 or newer.

Three system settings keep the app up, and on your tailnet only, after a
reboot or a Tailscale update, with nobody at the keyboard:

- `/etc/sysctl.d/99-liedmotif-tailscale.conf` sets
  `net.ipv4.ip_nonlocal_bind = 1`. At boot, Docker starts Caddy before
  Tailscale has its address (after a power cut, the router often comes back
  last). Docker cannot open a port on an address the machine doesn't have yet,
  and it does not try again. With this setting it can, and the app answers as
  soon as Tailscale connects. Ordering Docker after `tailscaled` is not enough:
  `tailscaled` reports "started" before it has its address.
- `/etc/systemd/system/tailscaled.service.d/liedmotif.conf` sets
  `RuntimeDirectoryPreserve=yes`. Otherwise every Tailscale restart (an
  update does one) replaces `/var/run/tailscale`, and Caddy, still holding the
  old folder, can no longer get its certificate.
- `/etc/systemd/system/liedmotif-tailnet-only.service` adds three firewall
  rules at every boot, before Docker starts. Docker answers on a published
  address whatever network a request comes in from, so a device on your home
  network that sends traffic for the `100.x.y.z` address to this machine on
  purpose (a route through its home-network IP) would reach the app. The
  rules drop that traffic unless it comes through Tailscale, from the machine
  itself or from its containers. They cover IPv4 only: nothing is published
  on the machine's IPv6 Tailscale address.

Your machine and tailnet names end up in public certificate logs, as every
HTTPS certificate does. Pick a machine name that says nothing private.

To let a friend in, the website has
[Share a home server with a friend](https://liedmotif.com/docs/share-with-a-friend/) for you and
[Help for members](https://liedmotif.com/docs/member-help/) for your friend.

### Tailscale mode hand test

Not yet done on a real device: until it has passed on a Raspberry Pi 5 and one
amd64 box, treat Tailscale mode as unverified. You need a tailnet with MagicDNS
and HTTPS on, a phone in it, and a second device on the same home network
without Tailscale (or with Tailscale switched off).

1. On a fresh OS, run the install command. It prints the Tailscale sign-in link,
   waits, and ends with `https://<machine>.<tailnet>.ts.net/setup?token=…`.
2. On the phone, open that link: no certificate warning, nothing to install.
   Create the Admin account.
3. From a tailnet device, `curl -sI https://<machine>.<tailnet>.ts.net/` lists
   `content-security-policy`, `strict-transport-security` and `x-frame-options`.
4. On the box, `sudo ss -tlnp | grep -E ':(80|443) '` shows only the
   `100.x.y.z` address, never `0.0.0.0` or `*`.
5. From the second device, `curl -m 5 http://<LAN-IP>/` and
   `curl -m 5 -k https://<LAN-IP>/` both fail to connect.
6. Still on the second device, send traffic for the Tailscale address to the
   box: `sudo ip route add 100.x.y.z/32 via <LAN-IP>` on Linux, or
   `sudo route -n add -host 100.x.y.z <LAN-IP>` on macOS. Then
   `curl -m 5 -k https://100.x.y.z/` gets no answer (it times out). Remove the
   route again (`sudo ip route del 100.x.y.z/32`, or
   `sudo route -n delete -host 100.x.y.z`). On the box,
   `sudo iptables -t raw -S PREROUTING` lists the three `100.x.y.z` rules.
7. Cold reboot: shut the box down, unplug it for 10 seconds, plug it back in.
   Within a few minutes the phone opens the app again, with nobody touching the
   box, and `sudo iptables -t raw -S PREROUTING` lists the three rules again.
8. Late network: shut down, disconnect the network (cable out, or router off),
   start the box, wait 3 minutes, reconnect. The app comes back on its own.
9. `sudo systemctl restart tailscaled`, then open the app in a new private tab
   on the phone. It loads (the certificate still comes through the socket).
10. Run the install command again. `.env` changes only `LIEDMOTIF_VERSION`, and
    it ends with `Liedmotif <version> is running at https://<machine>.<tailnet>.ts.net`.

## Hardware

User guide: [Pick a machine](https://liedmotif.com/docs/install/home-server/#pick-a-machine)
and [Choose your storage](https://liedmotif.com/docs/install/home-server/#choose-your-storage).

## Prerequisites

- Docker Engine 24+ and Docker Compose v2+ (`docker compose`, not `docker-compose`).
  Engine 28+ if ports published to `127.0.0.1` must stay private: see "Who can reach
  Caddy".
- A `.env` file at the repo root. Copy the example and edit:

  ```bash
  cp .env.example .env
  # then set APP_SECRET and CREDENTIAL_ENCRYPTION_KEY, e.g.:
  #   openssl rand -base64 32
  ```

  The infrastructure defaults (Postgres user/password/db, the in-cluster
  database URL, `/data` storage) are filled in by Compose even with a sparse
  `.env`, so the stack boots out of the box. Provider keys (`SUNO_API_KEY`,
  `LLM_*`, `IMAGE_*`) are read from `.env` or configured in first-login
  onboarding; a value in `.env` wins, and a key saved in the app applies
  without a restart.
  Until the music key exists the worker stays up and music jobs fail with
  `needs an API key`.

  A host-side `DATABASE_URL` / `DATA_DIR` in `.env` (used by `npm run dev`) is
  deliberately **ignored by the containers** — they always use the in-cluster
  Postgres and the `/data` volume. To run the stack against an external
  Postgres instead, set `DOCKER_DATABASE_URL`.

## Who can reach Caddy

With `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` unset, Caddy publishes on `127.0.0.1`,
so only this machine can reach the app: `https://localhost`. Anything other devices
must reach (a domain, a LAN IP, a hostname) needs plain ports in `.env`,
`CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443`, then `docker compose up -d`. Those
publish on every interface, IPv4 and IPv6. The installer sets them for `--domain`.
Tailscale mode publishes on the Tailscale address alone. If `APP_DOMAIN` is a real
name and `CADDY_HTTPS_PORT` is unset, `web` logs a warning at boot.

On Linux, "only this machine" takes Docker Engine 28 or newer: on older engines,
[hosts on the same network segment can reach ports published to `127.0.0.1`](https://docs.docker.com/engine/network/port-publishing/#publishing-ports).
That covers `WEB_PORT` too. Docker Desktop is not affected.

To move Caddy off a taken port but keep it private, set
`CADDY_HTTP_PORT=127.0.0.1:8080` and `CADDY_HTTPS_PORT=127.0.0.1:8443`. To sign in
through Caddy, also set `APP_PUBLIC_URL=https://localhost:8443`, then run
`docker compose up -d` and open that address.

An install made with `--domain localhost` and later moved to a real domain needs
those two lines added by hand: the installer never rewrites an existing `.env`.

## First-run setup on an exposed instance

User guide: [First-run safety](https://liedmotif.com/docs/install/cloud/#first-run-safety)
and [The setup token](https://liedmotif.com/docs/privacy-and-security/#the-setup-token).
`SETUP_TOKEN` gates `/api/setup` and the pre-admin credential probe, with one
identical response for a missing and a wrong token; unset, both routes stay open
to anyone who can reach them.

## Behind a load balancer (trusted proxies)

Rate limiting — failed sign-ins, invite-claim, reset, confirm, and
forgot-password submits, the setup wizard — keys on the client address the
proxy chain forwarded. `X-Forwarded-For` grows by one entry per proxy, so the
app has to be told how many of those entries were written by a proxy it
trusts:

```bash
TRUSTED_PROXY_HOPS=1   # default: the shipped stack, Caddy alone at the edge
TRUSTED_PROXY_HOPS=2   # client -> cloud load balancer -> Caddy
TRUSTED_PROXY_HOPS=0   # nothing in front of the app at all
```

With a load balancer in front, also name the balancer's address range in
`.env`, so Caddy keeps the client hop it forwards:

```bash
CADDY_TRUSTED_PROXIES=10.0.0.0/8                # one range, or several separated by spaces
CADDY_TRUSTED_PROXIES=private_ranges            # every private and loopback range
```

Compose hands it to Caddy, whose `Caddyfile` turns it into `trusted_proxies
static <ranges>` in the global `servers` block; unset, Caddy trusts no proxy.
Because it lives in `.env`, an update that replaces the `Caddyfile` keeps it.
Name the range your real proxy chain uses: `private_ranges` is what the
Cloudflare Tunnel guide uses, not a fit for every proxy. It does not change
`TRUSTED_PROXY_HOPS`, and both halves must agree: set too low, every client
keys as the load balancer and ten failed logins by anyone lock out everybody;
set too high, the key comes from a header the caller wrote and every limit is
bypassable per request. A malformed value fails the boot rather than
defaulting.

At `0` the app is assumed directly reachable, both forwarding headers are
ignored, and all callers share one limiter bucket — the limits still bite, but
they cannot tell callers apart (Next gives a route handler no access to the
socket peer address). Keep the app private behind the proxy: Compose binds `web`
to `127.0.0.1`.

Invite, reset, and confirm links carry a one-shot token as a path segment, and
their pages drop it from the address bar as soon as they load — so nothing
that happens *after* that first request can carry it. That first request still
does. **Exclude `/join/*`, `/reset/*`, and `/confirm/*` from request-path
logging** anywhere in front of the app (CDN, load balancer, WAF): a 7-day
invite sitting in a log aggregator is a claimable account. Caddy is already configured for this — see
"Access logs" below for the shape to copy.

The limiters live in the web process's memory. That assumes **one web replica**:
run two and each budget doubles, and every redeploy resets them. Scaling out
means moving the windows into Postgres first (see Deployment topology below).

## Deployment topology

The stack runs **exactly one `web` and one `worker` container per database**.
The web side is the rate-limit assumption above. The worker side is stronger: a
job lock is the only exclusivity the queue offers, and the worker's boot reaper
releases the locks it judges dead so a crash cannot stall the pipeline for four
hours — two workers would therefore race the same jobs.

Deploys must be **stop-then-start**, never overlapping. Compose does this by
default (`docker compose up -d --build` recreates each container); on an
orchestrator that defaults to a rolling update, set the equivalent of
`Recreate`/`stop-first` and a replica count of `1` for both services. `docker
compose up --scale worker=2` is not a supported configuration.

The worker enforces this rather than trusting the setting: at boot it reads the
worker heartbeat and refuses to start while another worker process is still
writing it, exiting non-zero with

```
another worker process is running against this database; refusing to start a second one
```

A worker whose predecessor was killed sees a heartbeat that is fresh but frozen,
waits for it to age out (up to ~35 s), and then starts normally — so an OOM or
`docker kill` costs one short delay, not a crash loop.

## Provider media egress

Every URL the music provider hands back (stream audio, final audio, cover
images) is fetched server-side through the egress guard, never by the browser.
The guard resolves the hostname, refuses private, loopback, CGNAT and
cloud-metadata addresses, re-checks every redirect hop — and **pins the
connection to the addresses it vetted**, so a provider that answers one address
to the lookup and another to the connection cannot reach anything internal.

Provider media must be served over **https**. A self-hosted provider on a
trusted network that cannot serve TLS can opt out with
`ALLOW_INSECURE_PROVIDER_MEDIA=1`; everything else about the guard still
applies. The bundled `mock` music provider is unaffected either way — its
sample URLs are not http at all.

## Ollama on the same machine

Setting it up is on the website:
[Ollama on the same machine](https://liedmotif.com/docs/providers-and-keys/#ollama-on-the-same-machine).

The provider URL guard allows the `ollama` preset two exemptions besides public
hosts: loopback, and whatever private (RFC1918 / IPv6 ULA) address the name
`host.docker.internal` resolves to. The exemption follows that name, so it is
only as trustworthy as the resolver answering it. Any other private address (a
second machine on the LAN, a Tailscale peer) is refused.

## Content Security Policy

The `Caddyfile` and `apps/web/next.config.mjs` carry the same policy — edit both
together or a `npm run dev` origin stops matching the proxied one. Each ships it
twice: **enforcing**, plus a Report-Only twin that is the slot for soaking a
future tightening against real traffic. The one deliberate difference is that
the Next copy adds `script-src 'unsafe-eval'` when it runs as the dev server,
whose hot reload evaluates module code; a production build never carries it.

Both name `report-uri /api/csp-report`, an app route that logs every violation:

```bash
docker compose logs -f web | grep 'csp violation reported'
```

Each line carries the directive that fired, the blocked URI and the page path
(invite/reset/confirm tokens stripped), and `disposition` says whether the enforcing or
the Report-Only copy produced it. Reports are rate-limited per client address,
so a broken page cannot flood the log.

A violation you did not provoke means the policy is blocking something the app
needs: relax that directive in **both** copies with a comment saying what
depends on it — never by dropping the header.

## External or managed Postgres (TLS and passwords)

The shipped stack reaches Postgres over the Compose network, where the
connection never leaves the host. Point `DOCKER_DATABASE_URL` (or `DATABASE_URL`)
at a database somewhere else and the same string suddenly describes a public
connection, so both processes check its posture at boot:

- **A public host must speak verifying TLS.** Append `?sslmode=verify-full` (or
  `verify-ca` where the provider has no verifiable hostname); without a
  verifying `sslmode` the boot fails. Only the explicit `sslmode` spelling
  counts: an address with `ssl=true` is refused too, even though the driver
  would encrypt it — replace it with `sslmode=verify-full`.
  `sslmode=require` boots with a warning — it encrypts, but whether it verifies
  the certificate depends on the driver version. A LAN or VPC address
  (including its IPv4-mapped IPv6 form) and a well-known private name
  (`host.docker.internal`, `*.internal`, `*.local`, `*.lan`, `*.home.arpa`,
  `*.svc.cluster.local`) warn instead of failing: that network is yours to
  judge. Any other dotted name counts as public. Loopback and a Compose
  service name (`postgres`) are silent — the connection never leaves the host.
- **The compose default password warns.** `POSTGRES_PASSWORD` falls back to
  `liedmotif`, which is published in this repository. Set it — and the matching
  password in `DOCKER_DATABASE_URL` — to a generated value before exposing the
  instance.

## Database connection pools

Web and worker each own one pool, sized and timed for the work they do. The
defaults suit the shipped single-host stack; every value is `.env`-overridable
(shown here at its default, timeouts in milliseconds, `0` meaning "set nothing
and inherit the database's own configuration"):

```bash
WEB_DB_POOL_MAX=10               WORKER_DB_POOL_MAX=8
WEB_DB_STATEMENT_TIMEOUT_MS=30000    WORKER_DB_STATEMENT_TIMEOUT_MS=300000
WEB_DB_LOCK_TIMEOUT_MS=10000         WORKER_DB_LOCK_TIMEOUT_MS=30000
WEB_DB_IDLE_TX_TIMEOUT_MS=60000      WORKER_DB_IDLE_TX_TIMEOUT_MS=300000
```

The timeouts exist so one runaway query cannot hold a connection forever:
without them ten stuck queries exhaust the web pool and every request after that
fails at the acquire timeout, with nothing able to break the stuck ones. The
worker's ceilings are far higher on purpose — its jobs are long (downloads are
bounded at 120s, analysis runs longer), and a web-sized ceiling there would
abort work already paid for. Migrations and seeds open untimed pools, because a
DDL migration on a grown table legitimately runs past any of these.

On a managed Postgres, size `WEB_DB_POOL_MAX + WORKER_DB_POOL_MAX` against the
instance's connection cap, leaving room for the one-shot migration pool and your
own `psql`. A malformed value fails the boot rather than defaulting.

## Graceful shutdown (web)

On SIGTERM — every `docker compose up`/rolling redeploy — the web container does
not exit immediately. The image sets `NEXT_MANUAL_SIG_HANDLE=1`, so
`instrumentation.ts` owns the signal: it keeps serving in-flight responses
(audio streams, zip downloads) for `WEB_SHUTDOWN_GRACE_MS` (default `15000`),
then closes the Postgres pool and exits. Stopping *new* connections is Docker's
job — it has already begun stopping the container — so this only prevents an
in-flight stream from being cut mid-byte and drains the pool cleanly. A second
SIGTERM during the drain forces an immediate exit.

`WEB_STOP_GRACE_PERIOD` (compose `stop_grace_period`, default `25s`) is how long
Docker waits before SIGKILL; keep it above `WEB_SHUTDOWN_GRACE_MS` plus a few
seconds of pool-close headroom, and raise both together. A malformed
`WEB_SHUTDOWN_GRACE_MS` fails the boot rather than silently draining to zero.

Manual verification (there is no vitest seam for process signals):

```bash
# 1. Build and start just the web + its deps.
docker compose up -d --build web
# 2. Start a long download and hold it open (don't let it finish).
curl -sS -o /tmp/session.zip 'http://127.0.0.1:2206/api/sessions/<id>/download' &
# 3. While it streams, send SIGTERM (a stop with a generous grace).
docker compose stop -t 25 web
# 4. Expect: the curl completes (non-zero exit only if it outran the grace),
#    and `docker compose logs web` shows the drain + a clean pool close, not an
#    abrupt exit. Confirm the container stopped within the grace period.
```

## Graceful shutdown (worker)

On SIGTERM the worker stops its Graphile runner — letting in-flight jobs finish —
and then closes the pool. Both steps are bounded: the runner stop gets the 150 s
analysis deadline (the longest a job may legitimately still be running) and the
pool close 10 s, after which the process exits regardless. The worker's
`stop_grace_period` of `180s` sits above that sum, so Docker's SIGKILL only ever
lands on a process that ignored its own deadline — which matters because a
SIGKILLed worker leaves its job locks marked live until the next boot reaps them.
A stop can therefore legitimately take a few minutes when a job just started.

## Database migrations

Migrations run automatically: the one-shot `migrate` service applies the
committed Drizzle app migrations and the `graphile_worker` schema, then exits;
`web` and `worker` only start after it completes successfully. It re-runs on
every `docker compose up` and is idempotent (a no-op when the schema is
current), so fresh volumes and image upgrades are both covered. If it fails,
`docker compose ps -a` shows it exited non-zero and `docker compose logs
migrate` has the (sanitized) reason — web/worker will not have started.

Search's lyric index needs the `pg_trgm` extension, which the migration creates
itself. That is transparent on the bundled Postgres (the extension is trusted
from Postgres 13 on, so the database owner may install it). Against an external
`DOCKER_DATABASE_URL` whose role is not the database owner — some managed
providers — install it once by hand before upgrading:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

The same migration builds a GIN index over `tracks.lyrics`, which holds a write
lock on `tracks` for the duration of the build. On a large library, expect that
migration step to take longer than the others.

### Session Cover planner cutover

The migration that introduces persisted Custom styles and the private Session
Cover generation ledger is an atomic runtime cutover. Do not run it while an old
web or worker process is alive: the old web can write the legacy Auto-plus-hint
shape, and the old worker cannot consume the new persisted `custom` value.

An install made with the installer runs this kind of sequence on every update
([What happens, in order](https://liedmotif.com/docs/updates/#what-happens-in-order)). On a source
checkout, use this maintenance-window sequence for that upgrade:

```bash
# Prevent old web writes, then let an in-flight image request finish.
docker compose stop web caddy
docker compose stop -t 90 worker

# Build the replacement images while no application process is running.
docker compose build web worker migrate

# Apply the enum rebuild, legacy rewrite, constraints, and ledger together.
docker compose run --rm migrate

# Start only the replacement runtime.
docker compose up -d web worker caddy
docker compose ps
```

The 90-second example exceeds the 60-second default image timeout. If
`IMAGE_REQUEST_TIMEOUT_MS` is higher, use a stop grace period longer than that
configured value. If the worker does not stop cleanly, inspect its sanitized logs
and do not start the migration until the old worker is confirmed stopped.
Existing generated covers and Session cover pointers are not rewritten or
regenerated.

### Generated Session Cover operations

Every Session gets a Cover; the owner's switch picks which source paints it.
An OpenAI, Gemini or OpenRouter image key (saved under Settings → Providers →
Cover images, or `IMAGE_PROVIDER=openai` / `gemini` / `openrouter` with
`IMAGE_API_KEY` in `.env`)
plus Settings → Generation → "Generate Tailored Cover Art" (on by default)
enables that hosted adapter, the only source that can honor a Cover style or carry People. With either missing, covers come from the
music provider instead — derived from the session's first completed Suno music
task using the music provider's key (`SUNO_API_KEY`, or the one saved in the
app), at no extra credit cost and counting
against the same cover budget. With neither source available, no generated cover
is coming and sessions keep the built-in branded placeholder.

The OpenAI adapter has fixed capabilities and needs no discovery: it paints one
square 1024px image, through image generation, or image editing when People
photos ride along. The Gemini adapter is fixed too: one native
`generateContent` call carries the prompt and up to four People photos as
inline images and returns one square 1K image. Gemini paints Covers only on a
Google project with billing turned on.

The rest of this section applies to the OpenRouter adapter only. The worker discovers the configured model's definitive
endpoint descriptor during provider validation and pins requests to that
endpoint. Only a successful descriptor is cached for the process: a failed probe
yields the conservative model-and-prompt core — references, seed, candidate
count, resolution, and quality omitted — reused for five minutes before the next
cover probes again. An OpenRouter blip therefore cannot pin the worker to
conservative mode for its lifetime, and a sustained outage costs one probe
timeout per five-minute window rather than one per cover.

`IMAGE_SUPPORTED_PARAMS` is for a sustained probe outage only, and is best left
blank. It is an operator restriction when discovery succeeds, never a way to
broaden the endpoint; when discovery is unavailable it becomes the configured
capability assertion. Keep any assertion no broader than capabilities confirmed
for the exact configured model and endpoint — it fails silently, not loudly.
Changing the model, endpoint, assertion, resolution, or aspect ratio requires
restarting the worker so its cached descriptor is rebuilt. Provider validation failure does not stop the worker;
new Session Cover operations settle terminally and Sessions keep the branded
placeholder cover.

Each admitted operation persists one plan, idempotency key, cost disposition,
and final square-WebP storage key before provider I/O. `not_started` failures may
use the same bounded safe retry. Ambiguous submissions without idempotency become
`submission_unknown`, count conservatively as possibly paid, settle terminally,
and must not be manually requeued. The scheduled `recover-session-covers` job
passes aged work back through the same `SessionCoverGenerator.ensureGenerated`
entry point. It probes the final storage key before any permitted provider retry;
there is no second recovery pipeline.

Logs should contain only controlled identifiers and sanitized categories. Do not
add full prompts, Session intent, Custom definitions, `coverConcept`, reference
descriptions or bytes, credentials, raw provider bodies, signed URLs, or provider
URLs to diagnostics.

The paid qualification harness is separate from ordinary tests and CI. Follow
the **Compare cover models** procedure in the root `INSTRUCTIONS.md` exactly: use
a fresh output directory, two materially different models, the explicit spend
confirmation, an exact 72-call ceiling, and a controlled synthetic reference.
Provider or artifact failures remain evidence and are never silently rerun. Two
independent blind rating exports and the comparison report are required before
interpreting a run. A failed gate blocks release rather than weakening thresholds
or triggering an automatic paid rerun.

## FFmpeg pin and source releases

`NOTICE.md` names the worker image's ffmpeg package and where its source is.
This keeps that true:

- **Pin.** `docker/ci/ffmpeg-pin.txt` holds the Debian package version. One pin
  serves amd64 and arm64: Debian builds both from the same source.
- **Build flags.** Each arch has a reviewed `ffmpeg -buildconf` list:
  `docker/ci/ffmpeg-buildconf-expected-amd64.txt` and `-arm64.txt`. They differ
  only in `--arch`, `--libdir`, `--incdir` and arm64's missing
  `--enable-libmfx`; both are `--enable-gpl` builds of the same source.
- **Smoke.** `docker/ci/ffmpeg-smoke.mjs` asserts the installed version matches
  the pin, the build flags match the arch file, and the Debian `copyright` file
  survived. CI's `worker-image` job runs it on amd64, the release workflow on
  both arches, before anything is pushed.
- **Source release.** `.github/workflows/release.yml` publishes the source once
  per pin, as a prerelease tagged `ffmpeg-source-<version>` (`:` and `+` written
  as `_`), before it pushes any worker image. It fetches the `.dsc`, the
  `.orig` tarball with its signature and the `.debian` tarball with
  `apt-get source`, which verifies them against Debian's signed index. Every
  release's notes link it. A prerelease never becomes the latest release, so the
  installer never picks it up.
- **Self-built images** install ffmpeg unpinned, so they keep Debian's security
  updates; there Debian is the distributor.

Bumping the pin updates `NOTICE.md`'s version, source URLs and release tag in
the same change.

## Common commands

Run these from the repo root.

```bash
# Validate the merged Compose configuration (no containers started).
docker compose config

# Build both images (web + worker) from the shared Dockerfile.
docker compose build

# Start the whole stack in the background (builds if needed).
docker compose up -d
# or: npm run docker:up

# Follow logs (all services, or one).
docker compose logs -f
docker compose logs -f worker
# or: npm run docker:logs

# Check health/status.
docker compose ps

# Stop and remove containers (keep volumes/data).
docker compose down
# or: npm run docker:down

# Stop and ALSO delete every volume — Postgres, /data, AND the backups that
# would have been the way back (destructive).
docker compose down -v
```

## What "healthy" looks like

After `docker compose up -d`, give it ~30–60s and run `docker compose ps`. Expected:

- **postgres** — `healthy` (`pg_isready`).
- **migrate** — `Exited (0)` (visible in `docker compose ps -a`; it runs once and
  exits before web/worker start).
- **web** — `healthy`. The container healthcheck hits `GET /api/health`, which
  returns `{"status":"ok","database":true}` once it can reach Postgres.
- **worker** — `healthy`. It has no HTTP server; its healthcheck verifies the
  heartbeat file `/tmp/liedmotif-worker-heartbeat` exists and is fresh (rewritten
  every ~10s). On boot the worker logs `database reachable`, proving connectivity.
- **caddy** — running, serving `https://localhost` (internal CA) → `web:3000`.
- **backup** — `healthy` once the first backup has completed (on a fresh install
  it starts within a minute). It reports unhealthy when its once-a-minute check
  stops, or when the schedule is on and the last success is more than one
  scheduled slot behind. Settings → Backups says why, and calls a backup overdue
  as soon as one slot is missed.

Quick manual checks:

```bash
# Web reaches Postgres (database: true):
curl -s http://localhost:2206/api/health

# Worker reached Postgres (look for "database reachable"):
docker compose logs worker | grep -i "database reachable"

# Worker heartbeat is being written:
docker compose exec worker node -e "console.log(require('fs').statSync('/tmp/liedmotif-worker-heartbeat').mtime)"
```

Open `http://localhost:2206` (direct) or `https://localhost` (via Caddy) to see
the placeholder mobile-first shell.

## Instance alerts

User guide: [Instance alerts](https://liedmotif.com/docs/alerts/), with the `.env` lines, the
cron line, the status codes and the webhook payload.

`--max-time 60` on the cron line covers one SMTP timeout budget (10 s to connect,
10 s for the greeting, 20 s on the socket): every send in a run goes out at once,
so the slowest one bounds the run. Which payload field each receiver reads:

| Receiver | What it reads |
| --- | --- |
| Slack | `text` |
| Discord | `content` |
| Gotify | `message` and `title` |
| ntfy | The `Title` and `Priority` request headers (critical `urgent`, warning `high`, recovery `default`). On a topic URL the JSON body becomes the message text; ntfy's own JSON publishing needs a `topic` field this payload does not have. |

## Data and persistence

- `liedmotif-pg` — Postgres data (named volume).
- `liedmotif-data` — the `/data` volume mounted into `web` and `worker` for audio
  and covers (addressed by storage key, never hardcoded paths).
- `liedmotif-backups` — backups: database dumps and media snapshots, written by
  `backup` and read by `web` (read-only). See "Backups and restore".
- `caddy-data` / `caddy-config` — Caddy's certificates and state.

To use a host bind mount instead of the named `liedmotif-data` volume, follow
[Using your own folder](https://liedmotif.com/docs/email-and-storage/#using-your-own-folder).

Web and worker both check the storage root at boot and refuse to start unless it
is an absolute path that exists and is writable by the user they run as. A
relative `DATA_DIR` would resolve against each process's own working directory,
which is how a library ends up written under one tree while deletes silently
no-op against another; an unwritable root is usually a volume left `root`-owned
(see "Upgrading an instance that ran as root" below). The failure names the
variable, never the path.

Every folder inside the storage root must be readable and writable too. Mount a
dedicated sub-folder at `/data`, never the top level of a disk: a freshly
formatted disk's top level holds a root-only `lost+found` folder, and the app
refuses to start on it.

Two ceilings bound growth. **The storage quota** (Settings → Generation,
`storageQuotaBytes`, 10 GiB by default) covers track audio, covers and their
thumbnails, Person reference photos, and voice recordings — everything but
avatars, which are one per user and replaced rather than accumulated. An
upload or a download claims room for its largest possible
size before it starts and gives back what it did not use, so a write that would
cross the line is refused even while the total is still under it, and concurrent
writes cannot each admit against the same figure. At the quota, uploads are
refused and sessions stop generating new tracks, with the reason naming the
quota. Playback, deletes, and already-admitted work are untouched, and nothing is
ever deleted to make room — so raising the quota (or deleting tracks) is what
resumes growth. Freed bytes reappear at the next measurement (worker boot, then
hourly), since an admission check must not scan the library.
**Free-space headroom** is the floor underneath it: with less than 256 MB left on
the volume, uploads are refused and final-audio downloads defer and retry, so a
full disk cannot take Postgres down with it. Object storage has no volume to
stat, so only the quota applies there.

## Backups and restore

User guide: [Backups and restore](https://liedmotif.com/docs/backups/), with the schedule,
status, encryption, downloads, disk use, restoring and testing a restore. The
internals the guide leaves out:

- `status.json` records a failure only as `dump-failed`, `media-failed`,
  `low-disk` or `database-unreachable`, which Settings → Backups puts in words.
  `docker compose logs backup` carries the real error from `pg_dump`, `psql` or
  `rsync`, without a password or the passphrase.
- The sidecar backs up, and its restore mode replaces, the database in
  `DOCKER_DATABASE_URL` when that is set, and the bundled `postgres` service
  otherwise: the same database web and worker use. A `sslmode=verify-full` URL
  is verified against the system roots (libpq's `sslrootcert=system`), as the
  app's driver does.
- A download is the backup folder as one tar, encrypted as a whole with the
  passphrase.
- Restore drops the schemas the dump contains (`public` is recreated) and
  replays it in one transaction, so a newer schema on the target cannot block it
  and a failed replay leaves the database unchanged. The database user must own
  `public`.

### Restoring

User guide: [Restore a backup](https://liedmotif.com/docs/backups/#restore-a-backup).

The `backup` service mounts `/data` read-only, and `docker compose run -v` onto
that same path does not make it writable, so a restore mounts the data volume a
second time at `/restore/data` and points `MEDIA_DIR` there; without both flags
it refuses before changing anything.

`npm run backup:restore` (`scripts/backup-restore.mjs`) loads `.env` and runs the
restore mode of the `backup` service's image (as `docker-compose.yml` names it) against
`DATABASE_URL` and `DATA_DIR`. A loopback database host is rewritten to
`host.docker.internal`, secrets reach the container as environment variables
passed by name (never on a command line), and restored files belong to the user
who ran it. It takes a downloaded file only and assumes Docker Desktop: on Linux,
`host.docker.internal` cannot reach a database published on 127.0.0.1.

### Restore drill

The steps are on the website: [Test a restore](https://liedmotif.com/docs/backups/#test-a-restore). Run
it into local development or an **isolated** second stack (see "Two instances on
one machine"), never against production, and record the date and result here.

**Last drill:** 2026-10-31, prod → local, passed.

## Container hardening

`web` and `worker` run as the unprivileged `node` user (uid 1000), never root.
Every service in the stack also carries `no-new-privileges` and a PID ceiling,
and everything but Postgres carries a memory ceiling, so one runaway process
cannot take the host (and Postgres with it) down. The `test`-profile containers
(`postgres-test`, `s3-test`) are unhardened development fixtures and never
run in a deployment.

`web` and `worker` additionally drop **every** Linux capability and mount their
root filesystem **read-only**, so a compromised process cannot rewrite its own
code or leave anything behind that survives a restart. Each has exactly two
writable paths:

- `/data` — the volume, where every durable byte already goes.
- `/tmp` — a tmpfs sized by `WEB_TMPFS_SIZE` (64m) and `WORKER_TMPFS_SIZE`
  (512m). The worker needs it: the heartbeat file lives there, and track
  analysis stages the audio ffmpeg reads. The web one is headroom for a
  dependency that falls back to a temp file — image work streams through
  libvips without writing to it.

A tmpfs is memory, charged against the same `mem_limit`, which is why the
worker's is sized rather than left at Docker's half-of-host-RAM default: an
honest free-space figure turns an oversized analysis input into a retryable
"not enough temp-disk headroom", instead of tmpfs pages growing until the OOM
killer takes the worker. Raise a size and its `*_MEM_LIMIT` together.

Caddy's admin API is switched off (`admin off`), and the base images
(`postgres`, `caddy`, `node`) are pinned to digests so a rebuild cannot silently
change the runtime. Refresh a pin deliberately, as its own commit:

```bash
docker pull caddy:2-alpine
docker image inspect caddy:2-alpine --format '{{index .RepoDigests 0}}'
# paste the sha256 into docker-compose.yml (or the Dockerfile, for node)
```

`GET /api/health` is intentionally left reachable through Caddy: it returns
`{status, database, time}` only — no versions, paths, or statistics — and
external uptime monitoring needs it. The container healthcheck talks to Next
directly, so an operator who would rather not expose it can uncomment the
`handle /api/health` block in the `Caddyfile` and lose nothing.

The limits are read from `.env` with the shipped defaults in `.env.example`
(`WEB_MEM_LIMIT`, `WORKER_PIDS_LIMIT`, …). Raise them when a legitimate
workload is being OOM-killed; `docker compose stats` and an exit code 137 in
`docker compose ps -a` are the symptoms. Postgres deliberately has no memory
ceiling: capping the database only converts a host-level OOM into a
database-level one.

Verify the posture after a deploy:

```bash
docker compose exec web id      # uid=1000(node) gid=1000(node)
docker compose exec worker id   # uid=1000(node) gid=1000(node)

# Root filesystem read-only, no capabilities (expect `true [ALL]` for both):
docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' \
  liedmotif-web-1 liedmotif-worker-1

# The app tree refuses writes; /data and /tmp take them:
docker compose exec web sh -c 'touch /app/probe'   # Read-only file system
docker compose exec worker sh -c 'touch /tmp/probe && rm /tmp/probe'
```

### Upgrading an instance that ran as root

Docker seeds a **fresh** `/data` volume from the image, where the directory is
already `node`-owned — new installs need nothing. A volume created by an older
root-running image keeps its root ownership, and the non-root containers cannot
write to it. Chown it once, with the stack stopped:

```bash
docker compose down
docker compose run --rm --user root --cap-add CHOWN worker chown -R 1000:1000 /data
docker compose up -d
```

The same applies to a host bind mount (`./data:/data`) — `sudo chown -R 1000:1000 ./data`
on the host instead. Skipping this shows up as storage writes failing with
`EACCES` in the web and worker logs. Ownership must be correct throughout the
tree: a writable `/data` can hide root-owned Member or Session folders. The
web and worker check existing directories at startup and refuse an unusable
tree. The temporary `CHOWN` capability lets the repair command change ownership;
normal web and worker containers keep their capabilities dropped.

## Access logs

Caddy writes one JSON line per request to `/data/logs/access.log` on the
`caddy-data` volume — source address, method, path, status, duration, size:

```bash
docker compose exec caddy tail -n 20 /data/logs/access.log
```

Rotation is capped at 10 MiB per file, 10 files, 30 days, so the log cannot
grow into the disk the library shares. These values never reach it: `Cookie` and
`Authorization` (Caddy drops those itself), the `X-Alert-Token` and
`X-Setup-Token` headers (the log filter deletes them), and the tokens in page
URLs, which are rewritten to `redacted` (`/join/redacted`, `/reset/redacted`,
`/confirm/redacted`, `/setup?token=redacted`) before the line is written — in
the request path and in `Referer` alike. Give anything you put in front of Caddy
the same exclusion.

A request that does not match `APP_DOMAIN` never reaches the site, so it is not
in this file; it is in `docker compose logs caddy` instead.

## S3-compatible object storage

User guide:
[S3-compatible object storage](https://liedmotif.com/docs/email-and-storage/#s3-compatible-object-storage),
including [moving an existing library](https://liedmotif.com/docs/email-and-storage/#move-an-existing-library).

### S3 adapter tests

The storage adapter contract tests run against a real S3 server (Versity S3
Gateway) started like the test database: `npm run s3:test:up` starts the
`s3-test` service (compose `test` profile, host port `TEST_S3_PORT`, default
9400), and `TEST_S3_ENDPOINT` in `.env` points the suite at it. With
`TEST_S3_ENDPOINT` unset the S3 leg skips visibly.

## Account email (optional SMTP)

User guide: [Account email](https://liedmotif.com/docs/email-and-storage/#account-email),
with the `.env` lines, Gmail, confirmed addresses, link lifetimes and
[replacing a placeholder address](https://liedmotif.com/docs/email-and-storage/#if-you-set-up-with-a-placeholder-address).

### Mailpit for development and tests

`npm run mail:test:up` starts Mailpit (the `mailpit-test` service, compose
`test` profile). It catches every mail on SMTP port 1025 (`TEST_SMTP_PORT`)
and shows it at http://127.0.0.1:8025 (`TEST_MAILPIT_PORT`), so placeholder
addresses work and nothing leaves the machine. Point a development `.env` at
it:

```bash
SMTP_URL=smtp://localhost:1025
MAIL_FROM=Liedmotif <liedmotif@localhost>
```

The SMTP adapter's contract tests send through the same Mailpit and read the
mail back over its HTTP API, gated on `TEST_SMTP_URL` and `TEST_MAILPIT_URL`;
with either blank that leg skips visibly. `npm run mail:test:down` removes it.
Production Compose has no Mailpit.

### Try it locally

With Mailpit up and the development `.env` above, run `npm run dev` and keep
two tabs open: the app at http://localhost:2206 and the inbox at
http://127.0.0.1:8025. Mail links are built from `APP_PUBLIC_URL`, so it must
point at the dev server (`http://localhost:2206`).

1. **Confirm the Admin address.** Settings → Profile → **Send confirm link**,
   open the mail in Mailpit, follow the link, press **Confirm email**. Most
   mails below only go to a confirmed address.
2. **Forgot password.** Sign out, press **Forgot password?** on the sign-in
   page, enter the address. Open the mail and set a new password.
3. **Change own password.** Settings → Profile → **Change password** →
   **Send link**, then follow the mail.
4. **Invite.** Settings → Members, enter any address (e.g.
   `member@example.test`) and press **Send invite**. Open the link in a private
   window and join; the email shows read-only and starts confirmed.
5. **Admin reset.** On that Member's card press **Reset password**; the mail
   lands in Mailpit.

To see the mail-off behavior, blank `SMTP_URL` and `MAIL_FROM` and restart
`npm run dev`: links go back to copy-and-hand-over, and Settings → Profile
changes a password with the current one.

## Two instances on one machine (dev + production)

The reference deployment runs development and production on the same host with
nothing shared — no ports, no env file, no containers, no volumes. Production
lives in a **dedicated clone** (e.g. `~/liedmotif-prod`) whose git origin is the
local dev repo path, so "deploy" means commit to dev `main`, then pull and
rebuild in the prod clone. The dev working tree is never used to build or run
production.

### Compose project isolation

The prod clone's `.env` sets `COMPOSE_PROJECT_NAME=liedmotif-prod`, overriding
the compose file's `name: liedmotif`. Compose namespaces containers, networks,
and volumes per project, so dev-side compose commands — including
`docker compose down -v` — physically cannot see or delete production state.
No compose-file changes are needed; the stack is fully env-driven.

The project name is also what keeps two stacks separate for
`docker/install.sh`: it refuses a folder whose project already has containers
started from another folder ("Install with one command"). A second stack needs
its own `COMPOSE_PROJECT_NAME` in its `.env` before its first start.

### Port map

| Port | Owner | Purpose |
| --- | --- | --- |
| 80/443 | production Caddy | HTTPS for `APP_DOMAIN` (the host's static LAN IP) |
| 2207 (loopback) | production web | direct access for host-side smoke checks only |
| — | production Postgres | internal-only, no host port |
| 2206 | `next dev` | host development server |
| 5433 (loopback) | dev/test Postgres | `db:test:up` profile database |
| 2216 / 8080 / 8443 | dev checkout's Docker stack | re-ported so a dev `docker compose up` never collides with production |

### Env split

The prod `.env` is written once by hand (never copied wholesale from dev):

- `COMPOSE_PROJECT_NAME=liedmotif-prod`.
- `APP_DOMAIN=<LAN-IP>` and `APP_PUBLIC_URL=https://<LAN-IP>` — a DHCP
  reservation / static IP is a prerequisite. If the address ever changes, Caddy
  reissues the certificate automatically but both variables must be updated
  (and phone bookmarks change).
- `WEB_PORT=2207`, `CADDY_HTTP_PORT=80`, `CADDY_HTTPS_PORT=443`.
- **Fresh** `APP_SECRET` / `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) —
  fresh session secrets only invalidate sessions, not passwords.
- The **same `CREDENTIAL_ENCRYPTION_KEY` as dev** — the migrated database's
  stored provider credentials are encrypted under it; rotation would
  invalidate them.
- Provider keys (`SUNO_API_KEY`, `LLM_API_KEY`, `IMAGE_API_KEY`, …)
  copied over.
- `SMTP_URL` / `MAIL_FROM` only for a real mail account: the dev values point
  at Mailpit, which production does not run.
- The host-only `DATABASE_URL` / `DATA_DIR` / `TEST_*` entries stay out — the
  containers always use the in-cluster Postgres and the `/data` volume.

### HTTPS on a LAN IP (internal CA)

Caddy's internal CA supports IP-address certificates, so `APP_DOMAIN` can be
the host's LAN IP directly (with `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443`)
— no DNS, no public domain. Because clients
connecting by IP send no SNI and Docker NAT rewrites the destination address,
the `Caddyfile` sets `default_sni {$APP_DOMAIN}` so certificate selection
works; without it the TLS handshake fails with an internal-error alert.

Export the root certificate once and install it on each client:

```bash
cd ~/liedmotif-prod
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

On Android: transfer the file, then **Settings → Security → Encryption &
credentials → Install a certificate → CA certificate** (see
[A home network address with an installed certificate](https://liedmotif.com/docs/install/phone-access/#a-home-network-address-with-an-installed-certificate)).
On desktop browsers, import it under the certificate
authorities of the browser or OS trust store. The root is valid for ten years;
certificate reissues for a changed IP do not require reinstalling it.

A WireGuard tunnel that routes the home LAN subnet reaches the same
`https://<LAN-IP>` origin — one bookmark works at home and remote.

An update through the installer (`docker/install.sh`) keeps this `APP_DOMAIN`,
and its closing health check accepts Caddy's internal certificate for exactly
the names Caddy serves with it: an IP address (IPv6 in brackets), `localhost`,
or a name ending in `.localhost`, `.local`, `.internal` or `.home.arpa`, and any
name once `.env` sets `CADDY_TLS=internal`. Every other name, and every download
the installer makes, is still verified. A timeout then points at
`docker compose ps` and `docker compose logs caddy web`, not at DNS or open
ports.

### One-time library migration (dev → prod)

Non-destructive to dev by construction: dump, never move. With the production
web/worker stopped:

```bash
cd ~/liedmotif-prod
docker compose stop web worker

# Dump the dev database (read-only against dev) and restore into prod:
docker exec <dev-postgres-container> pg_dump -U liedmotif -d <dev-db> \
  --clean --if-exists --no-owner --no-privileges > /tmp/liedmotif-dev.sql
docker exec -i liedmotif-prod-postgres-1 psql -U liedmotif -d liedmotif \
  < /tmp/liedmotif-dev.sql

# Copy the dev data directory into the prod volume (read-only source mount):
docker run --rm -v liedmotif-prod_liedmotif-data:/data \
  -v <dev-repo>/data:/src:ro alpine cp -a /src/. /data/

docker compose run --rm --user root --cap-add CHOWN worker chown -R 1000:1000 /data

docker compose up -d   # migrate reconciles the schema (expected no-op)
```

Afterwards verify: table counts match the dump-time dev counts, an existing
track plays with its cover, and stored provider credentials still validate
(they decrypt because prod reuses the dev `CREDENTIAL_ENCRYPTION_KEY`).

### Update flow

```bash
# 1. Land the change on dev main (commit or merge).
# 2. Ship it:
cd ~/liedmotif-prod
git pull origin main
docker compose up -d --build
# 3. Run the smoke checklist below.
```

Migrations apply automatically through the migrate gate. The
maintenance-window sequence above still applies to the flagged Session Cover
planner cutover class of migration. An instance whose `/data` volume predates
the non-root containers needs the one-time chown from "Container hardening"
before this flow works.

### Production smoke checklist

Run after every deploy (a few minutes total):

1. `docker compose ps -a` — postgres/web/worker `healthy`, migrate
   `Exited (0)`, caddy up, all under the `liedmotif-prod` project.
2. `curl -s http://127.0.0.1:2207/api/health` — `"database":true`.
3. `docker compose logs worker | grep -i "database reachable"` and a fresh
   heartbeat (`docker compose exec worker node -e
   "console.log(require('fs').statSync('/tmp/liedmotif-worker-heartbeat').mtime)"`).
4. Phone on WLAN: `https://<LAN-IP>` loads with no certificate warning; repeat
   once over WireGuard with WLAN off.
5. The installed PWA launches standalone with the Liedmotif icon.
6. Start a Session and let one track generate end-to-end (paid — one track is
   enough).

## Admin password reset (CLI)

User guide:
[If you forget the admin password](https://liedmotif.com/docs/members/#if-you-forget-the-admin-password).
The CLI ships in the worker image (`dist/reset-admin-password.js`), hashes with
Better Auth's own hasher, and revokes every sign-in session that admin holds, as
the Members reset link does; the session cookie cache is why sign-out can take up
to a minute.

## Android phone HTTPS access (PWA secure context)

User guide: [Use Liedmotif on your phone](https://liedmotif.com/docs/install/phone-access/),
with every HTTPS path (Tailscale, your own domain, Cloudflare Tunnel, a DNS
challenge, Caddy's internal CA). Better Auth derives its secure-cookie posture
and trusted origins from `APP_PUBLIC_URL`, and the same origin is the CSRF
second layer beside the `SameSite` cookie: a write whose browser `Origin` names
another scheme, host or port gets 403.
