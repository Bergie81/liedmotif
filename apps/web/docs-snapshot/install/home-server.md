---
title: Install Liedmotif on a home server
description: Run your own always-on Liedmotif on an old PC, a Raspberry Pi or a dedicated home server, reachable from your phone and closed to everyone else.
checkedOn: 2026-11-19
howTo: true
---

A small computer on a shelf keeps Liedmotif running day and night, so your phone can reach it at home and on the road. You change nothing on your router and open nothing to the internet. This guide starts with an empty machine and ends with your first session. Your provider makes the music, so the machine needs an internet connection.

> **Not hand-tested on real hardware yet.** The installer's Tailscale mode passes its automated tests, but it hasn't had its full hand test on a real Raspberry Pi or PC.

## Before you start

### Pick a machine

Any 64-bit Linux computer (x86_64 or arm64) with 4 GB of RAM or more runs Liedmotif. These are good choices:

| Machine | Why | System to put on it |
| --- | --- | --- |
| Raspberry Pi 4 or 5 with 4 GB or more | Small and easy to set up. Add an SSD | Raspberry Pi OS (64-bit), flashed with [Raspberry Pi Imager](https://www.raspberrypi.com/software/), which also sets the Wi-Fi, SSH and login user |
| Dedicated home server, such as a mini PC or used thin client | Cheap, quiet and low on power, and it usually has an SSD already | 64-bit Debian or Ubuntu |
| Old PC | Free if you already have one, as long as it's 64-bit with 4 GB of RAM | 64-bit Debian or Ubuntu |

**RAM.** 4 GB runs personal use comfortably. With 2 GB, Liedmotif can run slowly or stop under load, and the installer warns you when it finds less than about 3.5 GB. A 32-bit system can't run it: the installer stops and asks you to install a 64-bit one.

### Choose your storage

**Use an SSD if you can.** The database and your music library write all day. An ordinary microSD card wears out under that, and a power cut in the middle of a write can corrupt the card and your library with it.

| Storage | Verdict |
| --- | --- |
| USB 3 SSD (Pi 4), M.2 SSD on a PCIe HAT (Pi 5), or the SSD already in a mini PC | Recommended. On a Pi, boot from it |
| High Endurance microSD card, made for dash cams and security cameras | Acceptable when an SSD isn't an option |
| Ordinary microSD card | Avoid. The installer warns you, but doesn't stop |

**How big?** A track takes about 5 MB, so 1,000 tracks need about 5 GB. Backups reuse the music files that haven't changed, so they add little on top. 64 GB is plenty to start.

Liedmotif has its own storage quota, 10 GiB by default, or about 2,000 tracks. At the quota, sessions stop making new tracks and uploads are refused, but everything you already have keeps playing, and nothing is deleted to make room. With a bigger disk, raise it under **Storage quota** in **Settings › Cost limits**.

### Have these ready

- **A free [Tailscale](https://tailscale.com) account.** It's what connects your phone to the box. You can sign up with Google, Apple, Microsoft or GitHub.
- **A key from a music provider.** Sign up at [sunoapi.org](https://sunoapi.org), buy credits, and create a key under **Dashboard › API Keys**. You pay the provider directly, at about 4 cents per track.
- **A way to type on the machine:** a keyboard and screen, or SSH from another computer.

## 1. Set up the machine

Put the system on the machine, start it and connect it to your network. Then make sure `curl` is there, because a minimal system may not have it:

```bash
sudo apt-get update && sudo apt-get install -y curl
```

**Choose the machine's name with care.** It becomes part of your address, as in `https://liedmotif.tail1234.ts.net`, and it ends up in public logs ([here's why](#what-tailscale-mode-means-for-you)). Pick one that says nothing private.

## 2. Turn on HTTPS in Tailscale

Your phone needs a real certificate, and Tailscale can provide one once you allow it. The installer stops if you skip this.

1. Sign in to Tailscale and open the [DNS page of the admin console](https://console.tailscale.com/admin/dns).
2. Turn on **MagicDNS**.
3. Under **HTTPS Certificates**, select **Enable HTTPS**.

## 3. Paste the install line

On the machine, as your normal user:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash
```

It asks you for two things at most:

- **Your password,** when `sudo` needs it.
- **A Tailscale sign-in,** if this machine isn't signed in yet. It prints a link. Open it on any device and sign in, and the installer carries on by itself.

Each step it runs starts with `==>`. Here's what it does:

1. **Checks the machine.** It stops on a 32-bit system and warns about low memory.
2. **Checks Docker.** It installs Docker with Docker's official script if `docker compose` is missing, and leaves an existing Docker alone. If yours is older than version 28, update it first: older versions can let other devices on your home network reach Liedmotif's direct port. It warns if your data would sit on a microSD card.
3. **Turns on automatic security updates,** by installing `unattended-upgrades`, unless a setting is already there. Whether that setting is on or off, it stays.
4. **Downloads Liedmotif** into `/opt/liedmotif`.
5. **Checks Tailscale.** It installs Tailscale with Tailscale's official script if it's missing, and signs the machine in. It stops if HTTPS is off for your tailnet, or if Docker Compose is older than 2.24.4.
6. **Turns on Tailscale's automatic updates.** Tailscale is the box's only way in, so it should stay current. If this fails, you get a warning and the install carries on.
7. **Sets up the machine to serve Liedmotif on your tailnet only,** with [three system settings](#what-tailscale-mode-means-for-you).
8. **Writes `.env`,** your settings file, with fresh secrets that only your user can read. If a `.env` already exists, it's never regenerated.
9. **Pulls the images and starts Liedmotif.** The images are ready-made for Pi and PC, so nothing is built on the machine.
10. **Waits for Liedmotif to answer,** for up to five minutes. A slow machine can [get more time](#give-a-slow-machine-more-time).
11. **Prints your setup link,** `https://<machine>.<tailnet>.ts.net/setup?token=…`, and the command to update later.

The installer uses `sudo` only where it needs root: to install Docker, Tailscale and the security updates, to sign in to Tailscale, to write the system settings, to create the install folder, and to reach Docker if your user isn't in the `docker` group. It prints no secret except the token inside that one link, and it changes nothing else on the system. It never touches your SSH settings.

If a step fails, the error names the step and what to try. Fix that and run the same line again. That's always safe.

**You should now see** `Liedmotif <version> is running at https://…ts.net`, followed by your setup link. Keep that link private until you've used it: anyone who has it can create the admin account before you do.

## 4. Put Tailscale on your phone

The setup link opens only on devices in your tailnet, so your phone has to join first. Install Tailscale from [tailscale.com/download](https://tailscale.com/download), sign in with the same account, and switch it on. You don't need anything else on the phone: no certificate, and no app besides Tailscale.

Do the same on any other device you want to listen on. [On your phone](/docs/install/phone-access) has more, including how to add Liedmotif to your home screen.

## 5. Copy `.env` somewhere safe

`.env` holds keys nobody can recover. Without `CREDENTIAL_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_PASSPHRASE`, your saved provider keys and your encrypted backups can never be read again. If this machine dies, this copy is what brings your library back.

Run this on another computer, with your own username and the machine's address:

```bash
scp your-user@your-machine:/opt/liedmotif/.env liedmotif.env
```

Move the file to a password manager or a USB stick, never to a shared folder or an email. Copy it again whenever you change `.env`.

## 6. Create your admin account

Open your setup link on your phone or on any other device in your tailnet. There's no certificate warning, because the certificate is real.

Press **Create admin** once you've filled in your email and a password. Your password needs at least 12 characters, with a number, an uppercase letter and a special character. Setup locks as soon as the admin exists, so nobody can take it after you, and the token in the link stops granting anything.

## 7. Walk through guided setup

Guided setup starts right away and asks one thing per screen. Only your name and your music key are required. [The laptop guide](/docs/install/local) lists every screen.

A key you save here works at once, with no restart. It's stored encrypted on your own server. You can also put keys in `.env` instead (`SUNO_API_KEY`, `LLM_*`, `IMAGE_*`), and a value there wins over one saved in the app. Until a music key exists, Liedmotif stays up, but music jobs fail with `needs an API key`.

Press **Start your first Session** on the last screen, describe the moment you're in, and listen.

## What Tailscale mode means for you

Installing without `--domain` is Tailscale mode, and it shapes how you use Liedmotif from here on.

- **Your tailnet only.** Liedmotif answers only to devices signed in to your Tailscale network. The internet can't reach it, and neither can the rest of your home network. A phone on your Wi-Fi without Tailscale gets "connection refused".
- **One address everywhere.** Your phone uses the same `https://….ts.net` address at home and away, as long as Tailscale is switched on.
- **It comes back by itself.** After a reboot, a power cut or a Tailscale update, Liedmotif returns with nobody at the keyboard, even if your router comes back last. That's what the three system settings are for: two keep it running through those restarts, and the third adds firewall rules so traffic can reach it only through Tailscale.
- **Your names are public.** Your machine and tailnet names end up in public certificate logs, as they do for every HTTPS certificate. That's why the name matters.
- **Friends get one machine.** To let a friend in, share this one machine with them from the Tailscale admin console. Never invite them into your tailnet, because that gives them every device in it. [Share Liedmotif with a friend](/docs/share-with-a-friend) walks you through it.
- **Renaming has a cost.** If the machine's name or address changes on your tailnet, the next update stops and tells you what to edit. [Updates](/docs/updates) has the details.

### What stays your job

Security updates and Tailscale take care of themselves, but Docker doesn't. A Docker upgrade restarts every container, which would stop the music at a random moment, so it never runs on its own. Update it now and then, when nobody's listening:

```bash
sudo apt update && sudo apt upgrade
```

To update Liedmotif itself, see [Updates](/docs/updates). Backups run on their own, but they stay on this machine until you download one, so read [Backups](/docs/backups) too.

## Installer options

Add flags after `bash -s --`, like this:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash -s -- --dir /srv/liedmotif
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--domain <name>` | None, which means Tailscale mode | Serves this public domain instead, such as `music.example.com`, and leaves Tailscale alone. Caddy, the HTTPS proxy, gets a public certificate for it. See [Install on a cloud provider](/docs/install/cloud). `localhost` uses Caddy's internal certificate instead, and stays on this machine alone |
| `--version <tag>` | The latest release | The release to install, such as `v1.4.0` |
| `--dir <path>` | `/opt/liedmotif` | The install folder, which holds the Compose file and `.env` |

### Give a slow machine more time

A slow machine can take longer than five minutes for its first start. Set `LIEDMOTIF_HEALTH_TIMEOUT`, in seconds, to wait longer:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | LIEDMOTIF_HEALTH_TIMEOUT=900 bash
```

### Install from a copy of the code

To try code that isn't released yet, point `LIEDMOTIF_SOURCE_DIR` at a copy of it:

```bash
git clone https://github.com/bergie81/liedmotif.git
cd liedmotif
LIEDMOTIF_SOURCE_DIR=$PWD bash docker/install.sh
```

The same flags work. The installer copies the code into the install folder without asking GitHub, and it leaves out every `.env` file except `.env.example`, so the install's own `.env` stays as it is. It builds the images on the machine, which is slow on a Raspberry Pi the first time. Later runs rebuild only what changed. The version reads `local` unless you pass `--version`, and the output ends with the command to run again.

## Troubleshooting

### `curl: command not found`

Run the command in [step 1](#1-set-up-the-machine), then paste the install line again.

### "this step needs root, and sudo is not installed"

Run the same line again as root. Some Debian installs come without `sudo`.

### "this tailnet has HTTPS certificates turned off"

Follow [step 2](#2-turn-on-https-in-tailscale), then run the same line again.

### "Liedmotif on a tailnet needs Docker Compose 2.24.4 or newer"

Your existing Docker is too old for Tailscale mode, because Caddy couldn't be limited to the Tailscale address. [Update Docker](https://docs.docker.com/engine/install/), then run the same line again.

### "Liedmotif is already installed on this machine, in …"

Liedmotif already runs from the folder the message names, so the installer stops before it changes anything. Two installs in different folders would share the same containers and database, and the running one would stop working. To update, run the same line with `--dir` and that folder, as the message says.

If the message says the folder cannot be found, list the installs on this machine with `sudo docker compose ls -a`, and use the folder it shows. If that folder is gone for good, the old install can only be removed with its data: `sudo docker compose -p liedmotif down -v` deletes its database, music and backups, and can't be undone. A plain `down` is not enough, because a new install would meet the old database with a new password.

### "Liedmotif did not answer within 300 seconds"

On a slow machine, [give it more time](#give-a-slow-machine-more-time). Otherwise, check that MagicDNS and HTTPS are both on, as in [step 2](#2-turn-on-https-in-tailscale). If they are, read Caddy's log from the install folder:

```bash
cd /opt/liedmotif
sudo docker compose logs caddy
```

Then run the same line again. If your first start failed, the new run still prints your setup link.

### The setup link won't open

Check that Tailscale is on, on that device, and signed in to the same tailnet as the machine.

### You lost the setup link

The installer prints it only on the first install. Rebuild it from `.env`, on the machine:

```bash
grep '^SETUP_TOKEN=' /opt/liedmotif/.env
```

Your link is `https://<machine>.<tailnet>.ts.net/setup?token=` followed by the value after the `=`.

### **Create admin** says `Setup is not available.`

The link lost its `?token=…` part. Open the full link.

### The setup link takes you to the sign-in page

The admin account already exists. Sign in with it.

### Commands say "permission denied" for Docker

Your user isn't in the `docker` group. Put `sudo` in front of `docker compose`, as this page does.

## Uninstall

Run these on the machine, using your own folder if you set `--dir`:

```bash
cd /opt/liedmotif
sudo docker compose down
sudo rm -rf /opt/liedmotif
```

`docker compose down` stops and removes the containers, but keeps the database, your music and your backups in Docker's volumes.

> **To delete your data as well, run `sudo docker compose down -v` instead.** That deletes your database, your music and every backup on this machine, and it can't be undone. Download a backup from **Settings › Backups** first if you might want your library back, and keep your copy of `.env`, because the download opens only with it.

Then remove Tailscale mode's three system settings:

```bash
sudo systemctl disable --now liedmotif-tailnet-only.service
sudo rm /etc/sysctl.d/99-liedmotif-tailscale.conf /etc/systemd/system/tailscaled.service.d/liedmotif.conf \
  /etc/systemd/system/liedmotif-tailnet-only.service
sudo systemctl daemon-reload
```

The firewall rules stay until the next reboot. Docker and Tailscale stay installed, and the automatic updates stay on. This takes the machine off your tailnet:

```bash
sudo tailscale logout
```
