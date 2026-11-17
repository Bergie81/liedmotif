---
title: Privacy and security
description: What stays on your own Liedmotif instance, what each provider sees, what an admin can see, and how the instance protects itself.
checkedOn: 2026-11-17
---

Everything on this page is about your own instance: the copy of Liedmotif you run on your laptop, your server or your cloud provider. There's no Liedmotif-run service behind it. This website, liedmotif.com, has no accounts and no connection to your instance, so we can't see your music, your prompts or even that you exist.

Your instance does talk to the providers you connect, because they're the ones making the music. This page says exactly what goes where.

## What stays on your instance

Your library lives in your own database and on your own disk, or in your own storage bucket if you chose that:

- Your sessions, tracks, playlists and history
- Your requests and your learned taste
- Your stats and listening history
- Your profile and your people, with their About text and photos
- Your saved provider keys, encrypted
- Your backups

The app's own build has Next.js telemetry turned off, and the browser only ever talks to your instance. Audio and images from providers are fetched by the server and served from your own address, so a provider never sees your listeners' devices.

## What each provider sees

You choose these services and you pay them directly, so what they do with your data is covered by their own terms. Deleting something on your instance doesn't delete what a provider already received. Your provider key identifies your account to them.

### The music provider

This is the one service Liedmotif can't work without. For each batch of tracks it receives:

- The musical direction: style, genre, energy, tempo and key
- The track title
- Your **Avoid** terms
- For vocal tracks, the singer choice, the language and a short lyric brief

**Without a writing AI,** your request reaches the music provider exactly as you wrote it. So don't type anything into a request you wouldn't send to that provider.

**With a writing AI,** the provider gets the direction the AI wrote rather than your raw request. The lyric brief may carry details the AI developed from your profile and from people you named, so those can reach the music provider in a vocal session.

### The writing AI

This is optional, and it's the service `.env` calls the text LLM. If you connect one, it receives:

- Your request and your fine-tuning picks
- The earlier requests of a session, when you change its vibe
- Your profile's name, city and country, if you filled them in
- For a person you name exactly in your request, their name and About text, unless you picked **Instrumental**
- Your own About text with every request, unless you picked **Instrumental**, since every session is about your life. The writing AI decides from your words whether the session is sung, and uses About text only in the lyrics of a sung one
- For **Surprise Me**, your chosen theme, the music your learned taste picked, and your city and country. Vocal proposals may also use your own About text.

About text is only for lyrics. It's never used for style, titles or covers.

**When you ask Roadie,** the AI assistant inside the app, the writing AI receives your question and the last few messages of that conversation. What Roadie looks up for you to answer, such as the names of your sessions, playlists and tracks, a matching line of lyrics, what is playing or how many tracks and covers you have left, goes to the writing AI provider with the conversation. So does the tone you gave Roadie under **Settings › Roadie**, which your instance stores. Nothing from your profile or your people is sent, except that a Surprise Me you ask Roadie for sends what **Surprise Me** sends, listed above. The conversation lives in your browser tab only: your instance doesn't store it or write it to its logs, and it's gone when you reload the page.

With no writing AI, none of this leaves your instance. With a local Ollama, it stays on your own machine.

### The image provider

This is optional too, and it's what makes tailored covers. If you add an image key, it receives:

- The session or playlist name, the cover idea from the writing AI, your request and any cover direction you give
- The mood, activity and genres
- Reference photos of people, when a cover uses them

A photo is sent only in these cases: you name that person exactly in your request, the writing AI reads your request as putting you in the scene ("me", "we"), you ask for people on a playlist cover, or your own photo fits the frequency you set in **Settings › People**. One named person sends up to three photos, and several named people send one each. **Never** switches off all your reference photos, named people included, and refuses a cover that asks for them. When a cover uses photos of several people, their names in your request are swapped for neutral labels such as "subject one". With one person, their name stays in the request. The session name and the cover idea aren't changed, so a name in either one reaches the provider. Without an image key, the music provider makes a standard cover from a finished track, or your session keeps the free cover, and no photo is sent.

### Run without my profile details

Turn on **Run without my profile details** when you start a session to keep your own details out of that session's AI prompts and its cover references: your profile, your own About text and your photos. People you name exactly in the request are still used, with their About text and photos. The lyric brief is then built from your request and those people alone. **More Like This** starts a new session with personalization back on.

### Other services you may connect

| Service | What it sees |
| --- | --- |
| Email account (`SMTP_URL`) | The invites, password reset links, address confirmations, notices and alerts it sends, and the addresses they go to |
| Storage bucket (`STORAGE_PROVIDER=s3`) | Your music, covers and photos |
| Alert webhook | Problem names, counts and your instance's host name |
| Tailscale, or a public certificate | Your machine and tailnet names, or your domain, which end up in public certificate logs. Pick a name that says nothing private. |

The installer also contacts GitHub, the Docker image registry, and, when it needs to install them, Docker and Tailscale. A first `--domain` install looks up the machine's public address and your domain's DNS records through public services.

## What an admin can and can't see

One instance can serve a household, and everyone keeps their own private space.

| An admin can see | An admin can't see in the app |
| --- | --- |
| Each member's name, join date and last active time | A member's requests or prompts |
| Their track count and stored bytes | Their tracks, titles, covers or playlists |
| Their budget, usage and estimated cost | Their people, photos and About text |
| Whether they're disabled | What they play |

A playlist a member shares in the lounge is visible to its audience. The admin sees it only if they're in that audience, and can make a shared playlist they can see private again.

A backup holds everyone's content, so the admin can download one only as a file encrypted with the passphrase from `.env`. The app itself never shows that passphrase.

> **The app draws this line, not the disk.** Whoever runs the server has the machine: they can read the database, the files and `.env` directly. If you're a member, you're trusting the person who runs your instance, the way you trust anyone hosting your files. They also pay the providers, and requests go out through their accounts.

Members never see provider keys, the settings for the whole instance or the alerts. An admin can disable a member, which blocks sign-in and spending and keeps everything. An admin can also delete a member, which permanently removes their account and content, apart from the records listed under [When you delete something](#when-you-delete-something).

## Provider keys

Your keys stay on the server, and they never reach a browser:

- Keys you save in **Settings › AI Providers** are encrypted with AES-256-GCM before they enter the database. The key for that is `CREDENTIAL_ENCRYPTION_KEY` in `.env`, which is why the database alone can't open them.
- The app shows them masked.
- Only the admin can manage them. Members use them without ever seeing them.
- A key set in `.env` wins over the app and locks that field.
- Logs don't carry them. See [Logs](#logs).

Without `CREDENTIAL_ENCRYPTION_KEY`, saved keys can never be read again, so keep it safe: [Backups and restore](/docs/backups) lists what to store.

## Private media

Audio, covers, avatars, people's photos and downloads are served only through signed-in routes that check who owns them. The one exception is what a person chose to share in the lounge, for that share's audience. An ID you don't own looks the same as one that doesn't exist.

Provider and storage addresses never reach the browser, so a copied link isn't a way in. Providers' addresses are fetched on the server, over `https` only, and addresses inside your own network are refused. On a network you trust, a self-hosted provider without TLS can opt out with `ALLOW_INSECURE_PROVIDER_MEDIA=1`. The other checks stay on.

## Signing in

There's no public sign-up. The first account comes from the setup page, and everyone else joins through an invite.

- **Passwords** need 12 to 128 characters, with a number, an uppercase letter and a special character. Only a hash is stored.
- **Invite links** are single-use, stored only as a hash, can be revoked, and expire after 7 days.
- **Password reset links** are single-use. An emailed one lasts 1 hour, and a link the admin copies by hand lasts 24 hours. The admin never learns a password.
- **A reset signs that person out everywhere,** within a minute.
- **One address only.** Sign-in and every change compare the browser's address with `APP_PUBLIC_URL`, so another site can't act on your behalf. It's also why a second address for the same instance is [refused](/docs/troubleshooting).

### Rate limits

| What | Limit | Counted per |
| --- | --- | --- |
| Failed sign-ins | 10 in 15 minutes | IP address |
| Setup page submits | 5 a minute | IP address |
| Provider key tests during setup | 10 a minute | IP address |
| Invite, reset and confirm submits | 10 in 15 minutes | IP address |
| Forgot-password submits | 10 in 15 minutes | IP address |
| Forgot-password mails | 3 an hour | Email address |
| Starting sessions | 10 a minute | Person |

For sign-ins, only failed attempts count, so nobody is slowed down for signing in correctly. The counters live in the app's memory, so a restart resets them.

The limits need to know who's calling. `TRUSTED_PROXY_HOPS` is `1` by default, for Caddy alone, and takes `0` to `8`. If a load balancer, proxy or tunnel sits in front of Caddy, [Running behind a proxy](/docs/install/cloud#running-behind-a-proxy-such-as-cloudflare) shows what to set in `.env` and the `Caddyfile`, why a wrong value hurts, and which paths to keep out of the proxy's logs.

## HTTPS

Your instance needs HTTPS for phones, offline playback and secure sign-in cookies. The main ways are Tailscale, the installer's default, your own domain with `--domain`, a Cloudflare tunnel on a cloud server, and a local address with Caddy's own certificate. [Phone access](/docs/install/phone-access#ways-to-get-https-on-a-phone) compares them and walks through each.

Never put a home machine on a public tunnel, because a compromise of the app would land inside your home network.

Plain `http` works on `localhost`. On any other address, the app refuses to start, because sign-in cookies would have no protection. On a network you trust, `ALLOW_INSECURE_PUBLIC_URL=1` accepts that risk and turns the refusal into a warning.

Caddy also adds strict security headers, turns on HSTS, and caps every request body at 40 MB.

## What's open to the network

A fresh Liedmotif opens nothing to the network by default.

| Part | Where it listens |
| --- | --- |
| The app (`web`) | `127.0.0.1:2206`, this machine only |
| Caddy, by default | `127.0.0.1`, this machine only |
| Caddy, `--domain` install on a real domain | Every network, because the installer writes `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443` |
| Caddy, Tailscale mode | The machine's Tailscale address only, with firewall rules for anything arriving another way |
| Postgres, worker and backup | No published port. They talk over Docker's private network. |

To expose Caddy by hand, on a domain or a local address without the installer, set `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443` in `.env`. Set `SETUP_TOKEN` too, before the internet can reach it.

`/api/health` is reachable through Caddy on purpose, so an outside uptime check can use it. It answers only with a status, whether the database is reachable, and the time. To hide it, uncomment the `handle /api/health` block in the `Caddyfile`. Docker's own health check talks to the app directly, so nothing else changes.

## The setup token

The setup page creates the one admin, and on an open instance it answers whoever gets there first. Scanners find new servers within minutes of a DNS or certificate entry appearing, and the account they claim would own your keys, members and music.

The installer creates a `SETUP_TOKEN` and prints a link that carries it. For an install by hand, run this in your install folder before the machine is reachable. It adds a fresh token to `.env`:

```bash
printf 'SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

Then open `https://<your address>/setup?token=<the value>`.

Without the right token, the setup routes answer `Setup is not available.`, the same for a missing token as for a wrong one. Treat the link as a secret, since it lands in your browser history. The token does nothing once the admin exists, so you can remove it from `.env` after setup.

Without a token, the app logs a warning at every start until an admin exists: `No administrator exists yet and SETUP_TOKEN is unset`.

## How the containers are locked down

A compromised process has very little to work with:

- `web` and `worker` run as an unprivileged user, never root. They drop every Linux capability and their system files are read-only, so they can't rewrite their own code. They can only write to `/data`, which holds your library and survives a restart, and to a small temporary space in memory.
- Every service has `no-new-privileges` and a process limit, and everything except Postgres has a memory limit, which bounds what one runaway process can take from the machine.
- The Postgres, Caddy and Node images are pinned to exact versions, so a rebuild can't quietly change what runs.
- Caddy's admin interface is switched off.

The limits are in `.env`, such as `WEB_MEM_LIMIT` and `WORKER_PIDS_LIMIT`. To check all this after an update, run the commands below. The first two should say `uid=1000(node)`, and the `docker inspect` line should say `true [ALL]` twice. The container names below are the default ones.

```bash
docker compose exec web id
docker compose exec worker id
docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' liedmotif-web-1 liedmotif-worker-1
```

These show that the app refuses to write to its own files, and that it can write to its temporary space:

```bash
docker compose exec web sh -c 'touch /app/probe'
docker compose exec worker sh -c 'touch /tmp/probe && rm /tmp/probe'
```

The first should fail with `Read-only file system`. The second should print nothing.

## Logs

There are two kinds of logs, both on your machine.

**App logs** (`docker compose logs web`, `docker compose logs worker`) leave out, by field name: passwords, tokens, keys, cookies, provider audio addresses and prompts. Anything that looks like a key, a bearer token or a password inside an address is cut out too, and so is everything after the `?` in any address. **Settings › Diagnostics & worker** shows the same kind of cleaned-up events. Backup logs never show a password or the passphrase.

**The access log** records one line per request: source address, method, path, status, duration and size.

```bash
docker compose exec caddy tail -n 20 /data/logs/access.log
```

It rolls over at 10 MiB, and keeps 10 files for up to 30 days, so it can't fill the disk your library is on. Cookies, sign-in headers, the alert and setup token headers never reach it. Tokens in addresses are rewritten before a line is written, in the path and in the referrer alike: `/join/redacted`, `/reset/redacted`, `/confirm/redacted` and `/setup?token=redacted`.

A request for any other host name never reaches the site, so it isn't in this file. It's in `docker compose logs caddy`.

## When you delete something

| You do this | What happens |
| --- | --- |
| **Dislike** a track | It's hidden at once. Its audio is removed after 24 hours. A hidden record stays in the database. |
| Delete a track | Its audio is queued for deletion straight away, and removed within minutes. A hidden record stays in the database. |
| Delete a session | Its unsaved tracks and unused covers are removed. Tracks you saved in a playlist stay, and so do hidden records of the rest. If music was still being made, the delete finishes once that work has settled, and the session is hidden until then. |
| Delete a member (admin) | Their account and content are removed, and their files are queued for deletion. Their spending records stay with no name on them, and can still hold the text of their requests. They count toward limits until the period ends, and they aren't deleted then. |
| Delete a cover | The file is queued for deletion. |

Tracks and sessions have no expiry otherwise. Nothing is deleted just because it's old, or to make room.

Four things can outlive a delete:

- **Backups.** A deleted item stays in every backup made before the deletion until that backup rotates out, four weeks at the default settings. [Backups and restore](/docs/backups) has the details, and copies you downloaded are yours to delete.
- **Hidden records.** The database keeps a record of each deleted track, with its title and prompt, and of every request made to a provider, which spending limits count. The app no longer shows them and has no button to remove them, but anyone with access to the database can read them.
- **Your own stats.** Your private totals and a musical summary stay after a delete, with an ID that doesn't link back to anything. Nobody else sees them. Your listening records have no age limit either. **Clear listening history** on your stats page removes them for good, and **Reset learned taste** in **Settings › Playback** starts your taste afresh.
- **Devices.** A playlist or session you've made available offline stays on that device until the next sync, and signing out wipes it.

Separately, playback records no feature needs any more are pruned after 180 days, and the spending log after 730 days.

## Rights and your music

Liedmotif doesn't guarantee that generated music is free of other people's rights, original or safe to use in any particular way. What you may do with a track, such as sharing it or using it commercially, depends on your music provider's terms and your plan with them. Read them before you publish anything.

Liedmotif has no feature for sounding like a named artist. Describe moods, moments and genres instead.

Liedmotif itself is source-available and free for non-commercial use. [FAQ and license](/docs/faq-and-license) has the details.
