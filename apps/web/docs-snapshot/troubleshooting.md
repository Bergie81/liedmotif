---
title: Troubleshooting
description: Real Liedmotif problems with the exact message, the reason and the fix, plus how to read logs and check health.
checkedOn: 2026-11-20
---

Find your message or symptom below. A message about something you just did, such as a failed save or a **Test** result, shows as a notification at the top of the screen; an error stays there until you close it. A problem that lasts shows where it is, such as the banner in the player or a page that couldn't load. Most fixes are one line. Run every command in your install folder: `/opt/liedmotif` from the installer, or your `liedmotif` folder on a laptop. If your user isn't in the `docker` group, write `sudo docker` for `docker`.

Running Liedmotif on a laptop? [The laptop guide](/docs/install/local#troubleshooting) has the problems specific to it, such as ports already in use and signing in at `localhost:2206`.

## First, look

### Check health

```bash
docker compose ps -a
```

Give a fresh start 30 to 60 seconds. You want to see:

| Service | Healthy looks like | What it checks |
| --- | --- | --- |
| `postgres` | `healthy` | The database accepts connections. |
| `migrate` | `Exited (0)` | The database is up to date. It runs once and stops, so this is meant to look finished. |
| `web` | `healthy` | The app answers and can reach the database. |
| `worker` | `healthy` | The background worker is alive and ready to run jobs. |
| `backup` | `healthy` | The first backup has finished, and the schedule is on track. |
| `caddy` | Running | HTTPS on a server. A laptop doesn't need it. |

Three quick checks tell you more:

```bash
# The app reaches the database. Look for "database":true.
curl -s http://localhost:2206/api/health

# The worker reached the database. Look for "database reachable".
docker compose logs worker | grep -i "database reachable"

# The worker's heartbeat is fresh. It prints a time within the last few seconds.
docker compose exec worker node -e "console.log(require('fs').statSync('/tmp/liedmotif-worker-heartbeat').mtime)"
```

**Settings › Diagnostics & worker** shows the same from inside the app, for the admin: your public URL, the version, the providers, storage, the worker and recent events.

### Read the logs

```bash
docker compose logs -f              # everything, live. Stop with Ctrl+C
docker compose logs -f worker       # one service
docker compose logs web --tail 50   # the last 50 lines of one service
docker compose logs migrate         # why a database update failed
```

Use `worker` for making music, `web` for pages and sign-in, `caddy` for certificates and `backup` for backups. Logs leave out keys, tokens and prompts, but read them over before you share them.

### Everyday commands

```bash
docker compose ps           # what's running
docker compose config       # check your settings without starting anything
docker compose up -d        # start everything, on a server
docker compose build        # rebuild the images, on a source install
docker compose down         # stop and remove containers, and keep your data
```

> **`docker compose down -v` also deletes your database, your music and your backups.** Nothing brings them back except a copy you keep elsewhere.

`docker compose restart` doesn't re-read `.env`. After changing `.env`, run `docker compose up -d`. For a change that should only reach the app, `docker compose up -d web` is enough.

## Starting up

### A stop takes up to 3 minutes

That's normal. Stopping Liedmotif lets the worker finish its running jobs first, such as a track download or a paid cover, so a retry doesn't pay twice. Docker gives it up to 3 minutes. The app also keeps serving music that's already streaming for 15 seconds before it closes. Let it finish instead of forcing it. You can lengthen that window with `WEB_SHUTDOWN_GRACE_MS`, and then raise `WEB_STOP_GRACE_PERIOD` above it, so Docker waits long enough. A value that isn't a number stops the app from starting.

### The worker says `another worker process is running against this database; refusing to start a second one`

Only one worker may run per database. If the last one crashed, the new one waits up to about 35 seconds and then starts by itself, so give it a moment. If the message stays, look for a second copy of Liedmotif using the same database. Running more than one `web` or `worker` isn't supported.

### `BETTER_AUTH_SECRET/APP_SECRET is still the .env.example placeholder`

Every page shows a server error because `.env` still has the example secrets, which anyone can read. The same fix applies to `BETTER_AUTH_SECRET (or APP_SECRET) must be set` and to `BETTER_AUTH_SECRET/APP_SECRET must be at least 32 characters`. Generate a value and put it in `.env`:

```bash
openssl rand -base64 32
```

Then run `docker compose up -d`. On a running instance with users, don't replace working secrets. See [Secrets changed](#secrets-changed).

### `CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes`

The key is missing, is still the example, or isn't a real key. The same goes for `CREDENTIAL_ENCRYPTION_KEY is required when DB-stored secrets are enabled` and `CREDENTIAL_ENCRYPTION_KEY must be a non-empty base64 string`. Generate one with `openssl rand -base64 32` and paste only the value:

```bash
CREDENTIAL_ENCRYPTION_KEY=generated_value
```

If you've saved provider keys before, use your saved copy instead. A new key can't read them.

### `APP_PUBLIC_URL is plain http on a non-local host in production`

Liedmotif won't start on a plain `http` address other than `localhost`, because sign-in cookies would travel unprotected. Serve it over HTTPS and set `APP_PUBLIC_URL=https://<your address>`. If it's a network you trust and that's your deliberate choice, set `ALLOW_INSECURE_PUBLIC_URL=1`, and it starts with a warning instead. [Phone access](/docs/install/phone-access) lists the HTTPS paths.

Related messages: `APP_PUBLIC_URL must be an absolute http(s):// URL` and `APP_PUBLIC_URL must use http:// or https://` mean the value itself is wrong. Use the full address, with `https://`.

### The log warns `APP_DOMAIN is "<name>" ... but APP_PUBLIC_URL is "<address>"`

Caddy serves one address and sign-in expects another, so sign-in will fail or cookies won't be secure. Set `APP_PUBLIC_URL=https://<your APP_DOMAIN>` and run `docker compose up -d web`.

### `SMTP_URL is missing` or `MAIL_FROM is missing`

Account email needs both lines, or neither. Set the missing one, or clear the other. `SMTP_URL is not a valid URL` usually means a special character in the password: write `@` as `%40`, `/` as `%2F` and `#` as `%23`. [Email and storage](/docs/email-and-storage) has the setup.

### `ALERT_CHECK_TOKEN is set but alerts have nowhere to go`

[Instance alerts](/docs/alerts) lists this and its related messages.

### `The storage root (DATA_DIR) is not writable by the user this process runs as`

The app runs as an unprivileged user and can't write to its music folder. This shows up as a refused start, or as storage writes failing with `EACCES` in the logs, and also as `The storage tree (DATA_DIR) contains a directory this process cannot read, write, or traverse. Check the permissions of its existing sub-folders. If DATA_DIR is the top level of a mounted disk, use a dedicated sub-folder instead.` There are two usual causes.

**The folder is the top level of a disk.** A freshly formatted disk has a `lost+found` folder at its top that only root can read. Make a folder of its own on the disk, such as `/mnt/music/liedmotif`, and mount that at `/data` (or point `DATA_DIR` at it when running from source). See [Using your own folder](/docs/email-and-storage/#using-your-own-folder).

**The volume belongs to root.** It was created by an older version that ran as root. Hand it over once:

```bash
docker compose down
docker compose run --rm --user root --cap-add CHOWN worker chown -R 1000:1000 /data
docker compose up -d
```

New installs don't need this. If you mounted a folder from the machine instead of the volume, run `sudo chown -R 1000:1000 ./data` on the machine.

`The storage root (DATA_DIR) does not exist` and `DATA_DIR must be an absolute path` are for running from source: create the folder and use its full path.

### `DATABASE_URL (DOCKER_DATABASE_URL in Docker) points at a public host without a verifying sslmode`

Your database is on a public host, and its address doesn't say `sslmode=verify-full` or `sslmode=verify-ca`. Liedmotif accepts only that spelling. Add `?sslmode=verify-full` to the address, or `verify-ca` where the host name can't be verified. If the address says `ssl=true`, replace it with `sslmode=verify-full`: the connection would be encrypted, but Liedmotif doesn't accept that form. A Docker install sets the address in `DOCKER_DATABASE_URL`, running from source in `DATABASE_URL`.

### A container exits with code 137, or `docker compose ps -a` shows it restarting

It hit its memory limit, and Docker stopped it. `docker compose stats` shows the use. Raise the limit in `.env`, such as `WEB_MEM_LIMIT` or `WORKER_MEM_LIMIT`, and run `docker compose up -d`. If you raise `WORKER_TMPFS_SIZE`, raise `WORKER_MEM_LIMIT` with it: that temporary space counts as memory. The defaults suit a machine with a few GB of RAM to spare.

### The worker log says `not enough temp-disk headroom`

The worker's temporary space is too small for a large track. It retries by itself. If it keeps happening, raise `WORKER_TMPFS_SIZE` and `WORKER_MEM_LIMIT` together in `.env`.

### An update or install stopped with an error

The error names the step and what to try, and running the same command again is safe. [Updates](/docs/updates#if-an-update-fails) lists every stop, including how to go back after a failed database update.

### Database errors when running from source

These three only come up when you run the app with `npm run dev`.

- `liedmotif_dev: command not found`: `DATABASE_URL` is split across two lines in `.env`. Put it on one line.
- `database "liedmotif" does not exist`: `.env` didn't load, or `DATABASE_URL` still points at the fallback database. Reload it as below, check it with `echo "$DATABASE_URL"`, and run `npm run db:migrate` again.
- `getaddrinfo ENOTFOUND postgres`: your shell is still using the address Docker uses inside its own network. Change the line in `.env` to the one below, and reload it.

```bash
DATABASE_URL=postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev
```

To reload `.env` in your shell:

```bash
set -a
source .env
set +a
```

## Reaching your instance

### Another device can't reach it

By default, Caddy listens on the machine itself and nothing else. That depends on how you installed:

- **Tailscale mode:** only devices in your tailnet can reach it, so a phone on your home Wi-Fi outside the tailnet gets "connection refused". Install Tailscale on the device and sign in to the same tailnet.
- **`--domain`:** `.env` needs `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443`. The installer writes both, so check that nobody removed them.
- **By hand, on a domain or local address:** add `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443` to `.env`, set `SETUP_TOKEN` before the internet can reach it, and run `docker compose up -d`.

### `Liedmotif did not answer within <n> seconds`, or certificate errors

Caddy can't get or serve its certificate, or the app is slow to start.

- **On your own domain:** check that the DNS record points at this server, and that ports 80 and 443 are open to the internet. Caddy needs both to get its certificate. Let's Encrypt allows only a few failed tries an hour, so fix this before you try many times.
- **In Tailscale mode:** turn on **MagicDNS** and **HTTPS Certificates** in the Tailscale admin console, under DNS.
- **On a slow machine:** give it more time, as in [Updates](/docs/updates).

`docker compose logs caddy` has the details. A request for a host name other than `APP_DOMAIN` only shows up in that log.

## Setup and sign-in

### `Setup is not available.`

The setup page needs the token in its address. Open the link the installer printed, or `https://<your address>/setup?token=<SETUP_TOKEN from .env>`. A missing token and a wrong one give the same answer.

### "This install is set up for <address>. Open it there, or set `APP_PUBLIC_URL` to this address and restart."

The setup page was opened at another address than the one in `APP_PUBLIC_URL`, for example `127.0.0.1` when `.env` says `localhost`, or a home network name such as `nas.local`. Setup only works at that one address, so the form would be refused. Open the address the message names, with the setup token if you have one. Or, if the address in your browser is the one you want to keep, set `APP_PUBLIC_URL` to it (and, on a server, `APP_DOMAIN` to its host name alone, such as `music.example.com`) and run `docker compose up -d`.

### `Setup is already complete.`

An admin already exists, so the setup page has closed. Sign in instead. If you didn't create that admin and the instance was open to the network, someone else did. Treat that as a lost instance: start again with a [clean install](/docs/install/home-server) and a setup token.

### "Sign-in only works at the address Liedmotif was set up with."

Liedmotif accepts setup and sign-ins from exactly one address, the one in `APP_PUBLIC_URL`: scheme, host and port (setup checks host and port). Any other way to reach the same instance, such as a local IP address next to your domain, is refused, even with the right email and password. Other changes on the page answer `Cross-origin request refused.`

Check the address bar against `APP_PUBLIC_URL` in `.env`, and use that address everywhere. A second address for one instance isn't supported. To change the address, set `APP_PUBLIC_URL` (and `APP_DOMAIN` on a server) and run `docker compose up -d`. Invite links use it too.

### "Too many failed sign-in attempts. Wait a few minutes, then try again."

Ten failed attempts from one address lock that address out for 15 minutes. It clears by itself, or when the app restarts. If it hits everyone at once, your instance is behind a proxy and can't tell callers apart: see [rate limits](/docs/privacy-and-security#rate-limits).

"Too many requests. Please slow down." is the same kind of limit, on invites, resets, starting sessions and changing the vibe.

### You forgot the admin password

With account email on and a confirmed address, use **Forgot password?** on the sign-in page. Otherwise reset it on the machine. The first line waits for you to type the new password, without showing it, and keeps it out of your command history. Press <kbd>Enter</kbd> when you're done:

```bash
read -rs ADMIN_RESET_PASSWORD && export ADMIN_RESET_PASSWORD && echo
docker compose exec -e ADMIN_RESET_PASSWORD worker node dist/reset-admin-password.js
unset ADMIN_RESET_PASSWORD
```

If your user isn't in the `docker` group, which is common after the installer, plain `sudo` drops the password on the way. Use this as the second line instead:

```bash
sudo --preserve-env=ADMIN_RESET_PASSWORD docker compose exec -e ADMIN_RESET_PASSWORD worker node dist/reset-admin-password.js
```

The new password has to meet the usual rules. To name the admin account, add `--email admin@example.com` to the end of that line, using your own address. Every device signed in as the admin is signed out within a minute, so sign in again. The logs record your account's ID and email, never the password.

### A member can't sign in or lost their password

The admin can send a reset link from the member's card in **Settings › Members**. It's mailed if the member has a confirmed address, otherwise you copy the link and pass it on. It lasts 24 hours when copied, and 1 hour when mailed. A disabled member can't sign in until you enable them again.

### Secrets changed

Sessions fail with `failed to decrypt secret`, or **Settings › AI Providers** says "The stored value cannot be decrypted". `CREDENTIAL_ENCRYPTION_KEY` in `.env` no longer matches the database, usually because the secrets were generated a second time or a backup was restored without them. New `APP_SECRET` and `BETTER_AUTH_SECRET` values only sign everyone out, and people sign in again with their passwords.

- **You have your copy of `.env`:** put the original `CREDENTIAL_ENCRYPTION_KEY` back, and run `docker compose up -d`.
- **You don't:** enter your provider keys again in **Settings › AI Providers**. A lost `CREDENTIAL_ENCRYPTION_KEY` can't be recovered, but your music and library aren't tied to it.

Changing `CREDENTIAL_ENCRYPTION_KEY` always makes saved keys unreadable, so keep the [secrets](/docs/backups#keep-these-secrets) somewhere safe.

## Providers and keys

### "The music provider rejected these credentials."

The key is wrong, was revoked, or your provider account has a problem. Create a new key in your provider's dashboard, then paste and test it in **Settings › AI Providers**. If a `SUNO_API_KEY` line in `.env` is set, it wins over the app: change it there and run `docker compose up -d`.

"Could not reach the music provider to verify credentials." is different. The key may be fine, but the machine can't reach the provider. Check its internet connection.

### "The music key is missing or can't be read." or "Music isn't set up on this server yet."

Starting a session, More Like This or Surprise Me is refused because Liedmotif has no music key it can use. Nothing is created or spent. The admin sees "The music key is missing or can't be read. Enter it under Settings › AI Providers." Enter or re-enter the music key there, then press **Test**. If that doesn't help, check `.env`: `MUSIC_PROVIDER` must say `suno`, and `CREDENTIAL_ENCRYPTION_KEY` must be the key the saved one was stored with. A changed `CREDENTIAL_ENCRYPTION_KEY` makes a saved key unreadable: put the original back as in [Secrets changed](#secrets-changed), and enter the key again only if it's lost. With no `CREDENTIAL_ENCRYPTION_KEY` at all, no key can be saved in the app: set one first, as in [`CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes`](#credential_encryption_key-must-decode-to-32-bytes). A member sees "Music isn't set up on this server yet. Ask the Admin to set it up." and should ask the admin.

### "... rejected this API key." on the text AI or image key

This comes from the **Test** button, as a notification at the top of the screen, with your provider's name at the start. The key is wrong for that provider. A message that starts "Key works, but" and goes on to say the provider has no such model means the key is fine and the model ID has a typo.

### "Google needs billing turned on for image models." or "OpenAI needs your organisation verified for image models."

The **Cover Images** card shows this when a cover failed because the image account isn't set up for image models yet, even though the key works. Regenerating a cover says "Your image provider's account isn't ready for images. Check Settings › AI Providers." A Member sees "The image provider's account on this server isn't ready for images. Ask the Admin to check it." instead, and should ask the Admin. Turn on billing for the key's project at Google, or verify your organisation at OpenAI. The message goes away with the next successful cover, or when you save the provider again. [When the account isn't ready](/docs/providers-and-keys#when-the-account-isnt-ready) has the details.

### Generation paused: out of credits

"The music provider is out of credits — playing your ready tracks until the Admin tops it up."

Your provider account is empty. Your ready tracks keep playing. Top up at your provider, and generation picks up by itself. Liedmotif doesn't count this as spending.

### Generation backing off

"The music provider is busy — playing your ready tracks until generation resumes automatically in a few minutes."

The provider is limiting requests. Wait, and it resumes by itself. Maintenance looks similar: "The music provider is under maintenance — generation resumes automatically when it is back."

### "The music provider blocked this prompt — use Change Vibe to adjust it."

The provider refused the request, often over a named artist. Nothing retries until something changes, so change the vibe and describe moods, moments and genres instead. "The music provider refused this request" has the same fix, or check your provider setup.

### Free-text requests fail, but buttons work

A text AI is set up and it's failing. Liedmotif treats that as a retryable error and doesn't quietly go without it. Test it in **Settings › AI Providers**. To go without one, do both of these, because Liedmotif uses `.env` first and the saved one next: clear the `LLM_` lines in `.env` and run `docker compose up -d web worker`, then press **Disable Text AI** in **Settings › AI Providers**. If `.env` still sets one up on its own, that button says **Delete stored fallback**. Your words then reach the music provider as you wrote them.

### Every track sounds like a test, or nothing comes from the music provider

Check `MUSIC_PROVIDER` in `.env`. It must say `suno`. Blank or `mock` uses the built-in test provider, which makes no real music.

### "Generation limit reached", "Not enough Tracks left to start" or "You have reached your generation headroom for now"

That's a budget, not a fault. A running session replays its own tracks for free and picks up again when the budget renews. A new session needs a few tracks left (**Headroom to start**), and the message says how many it needs, how many are left and when more come back. The admin can change limits in **Settings › Cost limits**, and a member sees their budget in **Settings › My budget**. A session that needs tracks but has none yet says "No Tracks yet — the generation limit was reached before the first one." [Costs and limits](/docs/costs-and-limits) explains how they work.

### "New music is paused" or "… has paused new music"

**Pause all new music** is on in **Settings › Generation**, so a new session, More Like This, Surprise Me and Change Vibe are refused, and nothing is spent. The admin turns it off there; a member asks the admin. Resume, the Library, playlists and the Lounge keep working meanwhile.

## Sessions and music

### A session looks stuck on generating

Read the banner in the player first, because it names most problems. If the problem started while you were on another page, the same message showed once as a notification at the top of the screen. Then, in order:

1. **Give it time.** The first track can take a minute or more, and longer when the provider has no early stream and the file has to finish first. "Generation is catching up" clears by itself.
2. **Check the worker.** Run `docker compose ps` and `docker compose logs worker --tail 50`, or open **Settings › Diagnostics & worker**. The app can look fine while the worker is down, and then no track will arrive.
3. **Check the provider.** Test your key in **Settings › AI Providers**, and look at your balance.

A provider job that never finishes is given up on after about ten minutes of checking, so a session doesn't hang forever. Interrupted work resumes after a restart, without paying twice.

If the session has no tracks and nothing can move it on, the banner offers **Try again** and **Delete Session**. **Try again** buys one new pair, the number shown on the button, and starts at once if your limits have room. If a limit is reached, the banner says so instead. Nothing tries again without your tap, so a failing provider never spends in the background. When the provider blocked the request for its content, there is no **Try again**: use **Change Vibe** to adjust it. The banner stays until a track arrives or you delete the session. You can also stop it and start a new one.

"Generation hit a problem" means the last try failed. Ready tracks keep playing while it recovers. Read `docker compose logs worker` for the reason.

### A track is marked "Could not be kept"

The music provider failed after the track had started streaming, so its finished file never arrived. A track that's playing at that moment plays to its end. After that it doesn't play anywhere, and the session leaves it out. If you had saved it, it stays in its playlists with this mark, so you can see what was lost. Remove or delete it whenever you like. The session makes up for the lost tracks only the usual way: while you listen, with **New music** on and within your limits.

### Only one session starts at a time

You can cancel a start that's under way. The limit is on purpose, to protect your spending.

### Tracks don't play after a restore

The backup held no music, or the files came from a different moment than the database. Restore a backup with music and covers included. See [Backups and restore](/docs/backups).

### No new music while nobody is listening

That's on purpose too. Sessions make music only while playing, and an idle session stops itself. Resume it from **Sessions**.

## Disk and storage

### Disk full

Run these to see what's using the space:

```bash
df -h
docker system df
docker compose exec backup du -sh /backups
```

Liedmotif has three levels of protection. Each one explains a message you may see:

| Message | What's happening | Fix |
| --- | --- | --- |
| "The storage quota is full" or "The configured storage quota is full" | There's no room left under your own limit, 10 GiB by default. A track claims up to 64 MiB before it downloads, so this can show up just before the total reaches the limit. Sessions stop making tracks and uploads are refused. Playback and deleting still work. | Delete tracks you no longer keep, or raise **Storage quota** in **Settings › Cost limits**. |
| "The storage volume is nearly full, so new uploads are paused." | A write would leave under 256 MB on the disk. Uploads are refused and downloads of finished tracks wait and retry, so a full disk can't take the database down with it. | Free up disk space or add more. |
| "the backups disk is nearly full" | A backup needs at least 2 GiB free. | Free up disk space or add more. A refused backup deletes nothing, and lower **Keep** in **Settings › Backups** only helps after the next backup finishes. |

Nothing is ever deleted to make room. Freed space shows at the next measurement, which runs at worker start and then hourly, so a limit can take up to an hour to lift. **Settings › Storage** shows what's stored. Each track takes about 5 MB. The quota counts track audio, covers and their thumbnails and people's photos, but not avatars. With object storage there's no disk to check, so only the quota applies.

To free space outside Liedmotif, remove old Docker images with `docker image prune`. Don't remove volumes.

When a database update fails on a full disk, [fix the disk and run the same command again](/docs/updates#if-an-update-fails).

### Backups say Failing, Overdue or Not running

[Read the status](/docs/backups#read-the-status) has each one and its fix. **Not running** means the `backup` container has stopped. Start it with `docker compose up -d backup`, and look at `docker compose logs backup`.

### Download is greyed out in Settings › Backups

"Download is off: it is encrypted with BACKUP_ENCRYPTION_PASSPHRASE, and the web server has none set in .env." Set it in `.env` and run `docker compose up -d`.

## Alerts

### The scheduled check fails or stays quiet

[Instance alerts](/docs/alerts) lists what each status means, and how to test the whole path by hand.

## Known limitations

These are real limits today, not faults on your side:

- **Time to first note isn't guaranteed.** The provider doesn't always supply an early stream, so the first track can wait for the full file.
- **One music provider and one image provider.** There's one Suno-compatible music provider and one image provider today. Local music generation isn't available, so you need a provider key and an internet connection.
- **No voice input** for requests, and no feedback chips such as "more drums". **Change Vibe** is how you steer.
- **Dislike doesn't steer.** It swaps the track and leaves the direction alone.
- **Extending a track isn't possible.** The provider rewrites a track's ending instead of lengthening it.
- **No taste import.** Taste comes only from listening in Liedmotif.
- **No "export everything" and no global instrumental setting.** You can download tracks, sessions and playlists. Every session is instrumental until you choose vocals.
- **Offline is listen-only.** No making, saving or editing offline, and offline marks don't sync across devices.
- **No public share links.** Sharing stays inside your instance's lounge.
- **The installer is for 64-bit Debian, Ubuntu and Raspberry Pi OS.** A Mac or Windows laptop can run the Docker stack, and Windows hasn't been tested yet.
- **Alerts can't report the machine itself being down.** Use an uptime check from elsewhere for that.

## Still stuck

Open **Settings › Diagnostics & worker**, collect the last lines of `docker compose logs`, and check them for anything private. Then look at the [FAQ and license](/docs/faq-and-license) page.
