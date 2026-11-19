---
title: Update Liedmotif
description: Move to a new version without losing your library, what an update does, and how to get back if one fails.
checkedOn: 2026-11-19
---

An update keeps your music, your playlists, your members and your provider keys. Liedmotif never updates itself, so you choose the moment. Pick one when nobody is listening, because the music stops for about a minute.

## Before any update

Open **Settings › Backups**, press **Back up now** and wait for the new backup to appear in the list. Updates only go forward, so this backup is your way back. [Backups and restore](/docs/backups) has the details.

## Update an install from the installer

Run the same command you installed with. The first install printed it at the end.

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash
```

If you used flags, use them again. A server with its own domain, for example:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash -s -- --domain music.example.com
```

Repeat `--domain` and `--dir` exactly as you installed. [Installer options](/docs/install/home-server#installer-options) lists every flag.

To install a named version instead of the latest one:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash -s -- --version v1.5.0
```

Add `--domain` and `--dir` to that line if your install has them.

On a slow machine the app can take longer than five minutes to answer. Give it more time with `LIEDMOTIF_HEALTH_TIMEOUT`, in seconds:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | LIEDMOTIF_HEALTH_TIMEOUT=900 bash
```

### What the update changes in `.env`

Almost nothing. `.env` holds your secrets, so it's never regenerated. The update changes only the `LIEDMOTIF_VERSION` line. The other files in the install folder, the `Caddyfile` among them, come fresh from the new release, so put your own settings in `.env`. The Caddy settings for a tunnel or a proxy, `CADDY_TLS` and `CADDY_TRUSTED_PROXIES`, live there.

The update also keeps the mode you installed with, Tailscale or `--domain`. Passing a different `--domain` doesn't move your instance. To change the domain, edit `APP_DOMAIN` and `APP_PUBLIC_URL` in `.env`. Coming from `--domain localhost`, also add `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443`, or the new domain answers only on the machine itself.

In Tailscale mode it first checks that the machine is still signed in, and runs `tailscale up` if it isn't. It also checks that the machine still has the name and address `.env` serves. If you removed the machine from your tailnet and added it again, those can change. The update then halts with the music still playing and names the three lines to edit: `APP_DOMAIN`, `APP_PUBLIC_URL` and `TAILSCALE_IP`.

### What happens, in order

1. It downloads the new release into the install folder.
2. It pulls the new images. The music keeps playing during this step. If the pull fails, nothing has changed and the old version keeps running.
3. It stops the app. The background worker finishes its running jobs first, which can take up to 3 minutes.
4. It updates the database, and waits until that's finished.
5. It starts Liedmotif again and waits for the app to answer.
6. It prints the new version and your address.

### How long Liedmotif is down

About a minute, or up to a few minutes when the worker was in the middle of a job.

A run that stopped halfway, after a network drop for example, is safe to run again. It repeats the same steps and finishes the job.

> **Always update with the installer on these installs.** A plain `docker compose up -d` updates the database while the old app is still running, and some updates must not run that way. The installer stops the app first, so no release needs its own upgrade steps.

## Update a laptop or source install

Back up first, as above. Then run these from your `liedmotif` folder:

```bash
docker compose down
git pull
docker compose up -d --build
```

`docker compose down` removes the running containers, not your music or your database. It can take up to 3 minutes while the worker finishes its jobs. Never add `-v` to it: that deletes your library and the backups next to it.

## There's no rollback

Database updates only go forward. An older Liedmotif can break on a database that a newer one has changed, so never point an older `--version` at an updated database.

The way back is the backup you made before the update: restore it, and then install the version that made it. The next section has the exact commands.

## If an update fails

When the database update fails, the installer stops with this message and leaves the app stopped, so nothing runs on a half-updated database. Postgres and your data are still there.

```text
the database update failed. Liedmotif stays stopped, so nothing runs on a half-updated database.
```

**1. Read the reason.** Run this in the install folder. If your user isn't in the `docker` group, write `sudo docker` for `docker` here and in every command below.

```bash
cd /opt/liedmotif
docker compose logs migrate
```

**2. Fix it if you can.** A full disk is the usual kind of cause. Fix that and run the same install command again.

**3. If you can't, go back.** Restore the backup from before the update, then install the version you had. The installer names that version in its error. Replace the backup name and the version with yours, and add your `--domain` and `--dir` to the last line if you installed with them.

```bash
cd /opt/liedmotif
docker compose exec backup ls /backups   # pick the newest one from before the update
docker compose run --rm --no-deps -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data \
  backup restore liedmotif-backup-20261101T020000Z --yes
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash -s -- --version v1.4.0
```

The order matters. The older version must start on the database its backup holds, never on the half-updated one. `--no-deps` keeps the restore from running the failing database update first. The backup names carry their time in UTC, so `20261101T020000Z` is 1 November 2026 at 02:00 UTC.

On a laptop or source install, run the restore from your `liedmotif` folder. Then use `git log` to find the commit you had, and go back to it:

```bash
docker compose run --rm --no-deps -v liedmotif-data:/restore/data -e MEDIA_DIR=/restore/data \
  backup restore liedmotif-backup-20261101T020000Z --yes
git checkout <the commit you had>
docker compose up -d --build
```

### Other places an update can stop

Each of these names what to try, and each is safe to run again once it's fixed.

| The installer says | What it means | What to do |
| --- | --- | --- |
| `Liedmotif is already installed on this machine, in <folder>. Nothing was changed.` | The command was run without the `--dir` the install uses. | Run the same command with `--dir <folder>`. If the message says the folder cannot be found, `sudo docker compose ls -a` shows it. |
| `could not pull the Liedmotif images for <version>. Nothing was stopped or started.` | The machine can't download the release. The old version keeps playing. | Check that the machine can reach `ghcr.io`, then run the command again. |
| `this machine is <name> (<address>) on the tailnet now, but <file> serves ...` | The machine's Tailscale name or address changed. Nothing was stopped. | Set `APP_DOMAIN`, `APP_PUBLIC_URL` and `TAILSCALE_IP` as the message says, then run the command again. |
| `could not stop the running app.` | Docker didn't stop the containers. | Look at `docker compose ps` in the install folder, then run the command again. |
| `the stack did not start.` | Docker couldn't start the new version. | Look at `docker compose logs` in the install folder, then run the command again. |
| `Liedmotif did not answer within <n> seconds` | The new version isn't answering yet. | Look at `docker compose ps` and `docker compose logs caddy web`. On a slow machine, raise `LIEDMOTIF_HEALTH_TIMEOUT`. |

## Docker and system updates

Some parts of the machine update by themselves. Some wait for you.

| What | Who updates it | How |
| --- | --- | --- |
| Liedmotif | You | The commands on this page. |
| System security updates | The machine | On Debian, Ubuntu and Raspberry Pi OS, the installer turns on `unattended-upgrades` if nothing has set them up yet. A setting that's already there, on or off, stays as it is. |
| Tailscale | Tailscale itself | Tailscale mode turns on its automatic updates on every installer run, because Tailscale is the machine's only way in. If that fails, the installer warns and carries on. |
| Docker | You | See below. |
| HTTPS certificates | Caddy or Tailscale | They renew by themselves. An update doesn't touch them. |
| Postgres, Caddy and Node images | Liedmotif releases | Each one is pinned to an exact image, so it only changes when a new Liedmotif version changes it. |

Docker never updates on its own, on purpose. A Docker upgrade restarts every container, which would stop the music at a random time. Do it now and then, when nobody is listening:

```bash
sudo apt update && sudo apt upgrade
```

The installer leaves a Docker you already have alone, and it never changes your SSH settings. On a laptop, Docker Desktop and your system update the way they always do.

## What healthy looks like

After any update, give it a minute and run this in the install folder:

```bash
docker compose ps -a
```

`postgres`, `web`, `worker` and `backup` should say `healthy`, and `migrate` should say `Exited (0)`. On a server, `caddy` should be running too. Then ask the app itself, from the same machine:

```bash
curl -s http://localhost:2206/api/health
```

If you changed `WEB_PORT`, use your port instead of 2206.

A good answer has `"status":"ok"` and `"database":true`. **Settings › Diagnostics & worker** shows the version you're now on. If something looks wrong, [Troubleshooting](/docs/troubleshooting) explains how to read each piece.
