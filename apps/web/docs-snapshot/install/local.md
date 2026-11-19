---
title: Install Liedmotif on your laptop
description: Run Liedmotif on your Mac, Windows or Linux computer with Docker, from a clean start to your first session.
checkedOn: 2026-11-18
howTo: true
---

This is the easiest way to try Liedmotif, with nothing new to buy or rent. The app runs on your own computer, and only that computer can reach it. Your provider makes the music, so you need an internet connection. It plays while your laptop is awake and Docker is running. When you want music on your phone, or friends on your instance, move to a [home server](/docs/install/home-server) or a [cloud provider](/docs/install/cloud).

## Before you start

You need four things:

- **Docker.** [Docker Desktop](https://www.docker.com/products/docker-desktop/) on a Mac or Windows, or Docker Engine 28+ with Docker Compose 2.24+ on Linux. An older Engine can let other machines on your network reach Liedmotif. Start it before you carry on.
- **Git** to get the code. Macs and most Linux systems already have it, or you can get it from [git-scm.com](https://git-scm.com/).
- **About 10 GB of free disk space** for the app and the files that build it. Each track you make adds about 5 MB.
- **A key from a music provider.** Guided setup tests your key before it lets you continue, so get it first. Sign up at [sunoapi.org](https://sunoapi.org), buy credits, then open **Dashboard › API Keys** and create a key. You pay the provider directly, at about 4 cents per track, so $5 is plenty to start.

> **On Windows,** run every command in a WSL 2 terminal, such as Ubuntu, and keep the `liedmotif` folder inside it. This guide has been tested on a Mac, but not yet on Windows.

## 1. Get the code

```bash
git clone https://github.com/bergie81/liedmotif.git
cd liedmotif
```

Run every command in this guide from the `liedmotif` folder.

## 2. Create your secrets

This makes your settings file, `.env`, and fills it with fresh secrets. Liedmotif won't work with the examples it ships with.

```bash
cp .env.example .env
cat >> .env <<EOF
APP_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
BACKUP_ENCRYPTION_PASSPHRASE=$(openssl rand -base64 32)
EOF
```

> **Run this only once.** A second run replaces the secrets that protect your saved provider keys and backups.

**Now copy `.env` somewhere safe,** such as a password manager. [Keep your library safe](#keep-your-library-safe) explains why.

## 3. Start Liedmotif

```bash
docker compose up -d --build
```

The first start builds the app. It took about a minute on a fast Mac, and an older laptop will take longer. Build warnings such as `InvalidDefaultArgInFrom` are harmless.

To check that it's running:

```bash
docker compose ps -a
```

You should see `backup`, `postgres`, `web` and `worker` as `Up (healthy)`, `caddy` as `Up`, and `migrate` as `Exited (0)`. If some still say `health: starting`, give them a minute and check again. `migrate` prepares the database and then stops, so that one is meant to look finished.

## 4. Create your admin account

Open [http://localhost:2206](http://localhost:2206) in your browser. A fresh instance goes straight to setup, where you create the admin account. If you see a sign-in page or a different app instead, another program on your computer already uses that port: see [the port fix](#port-is-already-allocated-or-address-already-in-use).

Use exactly that address. Liedmotif accepts setup and sign-ins from only one address, so `127.0.0.1` won't work even though it's the same computer. Setup opened at another address says so above the form.

Your password needs at least 12 characters, with a number, an uppercase letter and a special character.

## 5. Walk through guided setup

Guided setup starts right after your account is created and asks one thing per screen. Only two of the setup screens are required.

| Screen | What it asks | Required |
| --- | --- | --- |
| You | Your profile | Yes |
| People | People who can appear on tailored covers | No |
| Music model | Your provider key. Paste it and test it to continue | Yes |
| Track limit | How many tracks Liedmotif may make. It won't go below what a new session needs to start, 6 tracks by default | No |
| Text AI | A service that expands your requests and names your sessions | No |
| Cover art | An image provider for tailored covers, and a limit on all generated covers, your music provider's included. Your text AI's key works when it's the same service. Every session gets a free cover without one | No |

A key you save here works right away, with no restart. Setup doesn't make any music: your spending starts when you start a session.

Press **Start your first Session** on the last screen, describe the moment you're in, and listen.

## Stop and start

Done for the day? This stops Liedmotif and keeps everything:

```bash
docker compose stop
```

`backup` may then show `Exited (137)`. That's normal for a stop.

To bring it back:

```bash
docker compose start
```

If you leave it running, it comes back by itself whenever Docker Desktop starts. If you stopped it, it stays stopped until you start it.

## Update

Press **Back up now** in **Settings › Backups** and wait for the new backup to appear in the list. Then run:

```bash
docker compose down
git pull
docker compose up -d --build
```

Your library stays where it is. `docker compose down` removes the running containers, but not your music or your database.

Updates only go forward. An older version can break on a database that a newer one has changed, so the way back is the backup you just made.

## Keep your library safe

**Your `.env` holds secrets nobody can recover:**

- Without `CREDENTIAL_ENCRYPTION_KEY`, your saved provider keys can't be read, and you have to enter them again.
- Without `BACKUP_ENCRYPTION_PASSPHRASE`, your backups can't be opened, so a backup without it is as good as deleted.

**Backups run by themselves,** weekly by default, and you can change that in **Settings › Backups**. They stay on the same laptop, so they won't save you from a lost or broken laptop. Download one from the same page now and then, and keep it somewhere else.

## Troubleshooting

### "Sign-in only works at the address Liedmotif was set up with."

Check your browser's address bar. It needs to say exactly `http://localhost:2206`. Any other address for the same computer, such as `127.0.0.1` or `https://localhost`, is refused, even with the right email and password. Setup follows the same rule: opened at another address, it shows "This install is set up for http://localhost:2206" above the form.

### "Port is already allocated" or "address already in use"

Something else on your computer is using a port Liedmotif wants.

If the message names port 80 or 443, Liedmotif is running anyway, so `http://localhost:2206` works. Only Caddy couldn't start, the HTTPS proxy for servers, which a laptop doesn't need. To clear the message, move Caddy to other ports, still private to this computer:

```bash
printf 'CADDY_HTTP_PORT=127.0.0.1:8080\nCADDY_HTTPS_PORT=127.0.0.1:8443\n' >> .env
docker compose up -d
```

If it names port 2206, or `localhost:2206` shows a different app, give Liedmotif another port. Run these two lines, then use the new address, here `http://localhost:2207`:

```bash
printf 'WEB_PORT=2207\nAPP_PUBLIC_URL=http://localhost:2207\n' >> .env
docker compose up -d
```

### Every page shows a server error

Run this to read the reason:

```bash
docker compose logs web --tail 20
```

If it says `BETTER_AUTH_SECRET/APP_SECRET is still the .env.example placeholder` or `CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes`, the secrets weren't created. Run the second part of [step 2](#2-create-your-secrets), from `cat >> .env`, and then start it again:

```bash
docker compose up -d
```

### Sessions fail with "failed to decrypt secret"

`CREDENTIAL_ENCRYPTION_KEY` has changed since you saved your provider keys, usually because the secrets were created a second time. Put your copy of `.env` back and run `docker compose up -d`, or enter your provider keys again in Settings.

## Remove Liedmotif

> **This deletes your music, your database and every backup on this laptop.** Download a backup from **Settings › Backups** first if you might want your library back, and keep your copy of `.env` too: the download opens only with it. Move both out of the `liedmotif` folder, because the last line deletes it.

```bash
docker compose down -v --rmi all
cd ..
rm -rf liedmotif
```

This also removes the images Liedmotif built or downloaded, Postgres and Caddy included. Docker itself stays.
