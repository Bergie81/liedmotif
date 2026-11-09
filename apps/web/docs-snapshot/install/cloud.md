---
title: Install Liedmotif on a cloud provider
description: Rent a small server, point your own domain at it and invite your friends, even if you've never touched a server, DNS or SSH.
checkedOn: 2026-11-08
howTo: true
---

A rented server is always on, and anyone you invite can listen from anywhere in a normal browser, with nothing to install. This guide takes you from never having rented a server to friends listening on your own Liedmotif. Plan about an hour, plus some waiting while your domain starts working.

It stays your own instance on your own provider keys. There's no Liedmotif-run service: you pay the server provider and the music provider directly.

> **Let an AI assistant walk you through it.** Copy this whole page into an AI assistant, then send it this message:
>
> ```text
> I want to set up Liedmotif on a rented server by following this guide. I have never used a server, DNS or SSH. Walk me through it one step at a time. After each step, ask me what I see and compare it with the "You should now see" check. If it does not match, help me fix it before we go on, using the "Common problems" section first. Never ask me to paste a password, my music provider key, the setup link or my .env file into this chat.
> ```

**Keep secrets out of chats.** Never paste a password, your provider key, the setup link or the contents of `.env` into an AI chat, a forum or a screenshot.

## Before you start

You need:

- **About €5 a month for the server,** and a domain, usually a few euros a year.
- **A payment card** for the server provider, and about $5 of credit for the music provider.
- **A computer** with macOS, Windows 10 or 11, or Linux. Setting up your account and inviting friends work on a phone too.

**Words on this page:**

- **VPS:** a small rented computer in a datacenter. It's always on.
- **Domain:** a name like `example.com` that you rent by the year.
- **DNS record:** an entry that tells the internet which server a name belongs to.
- **SSH:** a safe way to type commands on your server from your own computer.
- **Terminal:** the app on your computer where you type those commands.

**In every example,** `203.0.113.10` stands for your server's IP address, `ubuntu` for its username and `music.example.com` for your domain. Replace them with your own each time.

## Pick a provider and a size

You need a 64-bit Debian or Ubuntu server with **2 vCPU and 4 GB of RAM**. That's enough for you and about ten friends. Your disk decides how long the plan lasts, not your memory or processor:

- **Memory.** Liedmotif idles at about 315 MB, with an estimated busy peak of about 1.5 GB. The images are ready-made, so the server never has to build anything.
- **Disk.** A track takes about 5 MB, and music is never removed by itself. A 40 GB plan leaves about 25 GB for music once the system and the app are in place. That's about 5,000 tracks.
- **Traffic.** Listening uses about 81 MB an hour, so ten people at 1.5 hours a day use about 37 GB a month. Choose a plan with traffic included, and this never matters.
- **Location.** One server is right for everyone. Pick the region closest to most of your listeners. Music buffers well over long distances, but delays of 250 to 300 ms are noticeable in page loads, controls and seeking.

These plans fit. Prices include 19% German VAT and were checked on 24 October 2026. They vary by country, term and location, and they change, so check before you order. OVHcloud's US page listed VPS-1 from $4.54 a month on 7 November 2026.

| Plan | Size | Traffic | Price a month | Choose it when |
| --- | --- | --- | --- | --- |
| **OVHcloud VPS-1** | 2 vCore, 4 GB, 40 GB NVMe, daily backup | Unlimited, 500 Mbit/s | About €4.53 paying 12 months up front, about €5.34 month to month | **The default.** Locations in Europe, North America, Singapore and Australia. This guide uses it |
| OVHcloud VPS-2 | 4 vCore, 8 GB, 75 GB NVMe, daily backup | Unlimited, 1 Gbit/s | About €8.58 | You outgrow VPS-1's disk |
| netcup VPS Lite 1 G12.5s | 2 vCore, 4 GB, 80 GB SSD | Included, with reduced bandwidth | €5.86, 6-month minimum | Everyone's in Europe and disk matters most. You get twice the disk, but no choice of location (Nuremberg, Vienna or Amsterdam) and a lower availability commitment |
| netcup VPS 500 G12.5 | 2 vCore, 4 GB, 64 GB SSD | Included, slowed to 200 Mbit/s if your 24-hour average passes 2 TB | €7.03 to €9.50, by term | You want netcup with a choice of location: Nuremberg, Vienna, Amsterdam, Manassas (US) or Singapore |

Any other provider with the same size works too. Read these offers closely first:

- **Hetzner's CX line** has been impossible to order since September 2026, and the plan you can order instead, CPX22, costs about €19.99 before VAT.
- **IONOS VPS M+** costs €4 for three months, then €12, plus €10 setup.
- **Hostinger KVM 2** has a promotional price that renews higher.
- **Contabo Cloud VPS 4** has a price we couldn't confirm, and a weak availability history.
- **Euronodes** is small and new, with no independent track record.

Availability percentages are what providers commit to in their terms, not uptime anyone measured.

### What doesn't fit

- **AWS, Google Cloud and Azure** charge about $0.09 for every GB of music you stream, with nothing in return at this size.
- **Vercel and Netlify** have no lasting disk for your music, and nowhere to run the worker that makes it.
- **RunPod and other GPU clouds** rent out graphics cards. Liedmotif runs no AI models itself, because your providers do that work.
- **Oracle Cloud's free tier** can reclaim servers it finds idle, which makes it fine for an experiment but not for your library.
- **Render, Railway and Fly.io** can work, but they won't run the one-line install. Their disks attach to one service, but Liedmotif's web app and worker share one, so you'd have to use [S3-compatible storage](/docs/email-and-storage) and rebuild the setup in their own configuration. Most also charge for traffic, which adds up for streamed audio.
- **Coolify and Dokploy** can make a server nicer to manage, but you still run the server, and they use up memory on a 4 GB plan.

### Why a domain

Phones need a real HTTPS address to install Liedmotif as an app, keep music offline, and show the lock-screen controls. [On your phone](/docs/install/phone-access) explains why. An address on your own domain also stays yours when you change servers, and every member's browser trusts its certificate without any extra steps.

Don't use the hostname your VPS provider gives you. It's tied to that one server, so moving means a new address for everyone, and a name shared with the provider's other customers can run into certificate limits.

## 1. Rent the server

1. Open [ovhcloud.com/en/vps](https://www.ovhcloud.com/en/vps/) and create an OVHcloud account.
2. Choose **VPS-1**. Paying 12 months up front costs less than paying monthly.
3. Under location, pick the datacenter closest to most of your friends.
4. Under image, the operating system, pick **Ubuntu**, the newest LTS version offered, such as Ubuntu 24.04. Debian 12 or 13 works too. Don't pick Windows.
5. You need no extra options. Finish the order.

**You should now see,** usually within an hour, a delivery email from OVHcloud with:

- your server's **IPv4 address**, four numbers with dots, like `203.0.113.10`;
- the **username**, `ubuntu`, or `debian` if you picked Debian;
- a secure **link to your temporary password**. Open it and keep the password at hand for step 5.

The IP address is also in the OVHcloud Control Panel under **Bare Metal Cloud › Virtual private servers**, on your VPS.

## 2. Buy a domain

Buy any domain you like. The easiest place is the same account, at [ovhcloud.com/en/domains](https://www.ovhcloud.com/en/domains/), but any domain seller works.

Liedmotif will live at a subdomain such as `music.yourdomain.com`, so the domain itself stays free for anything else.

**You should now see** the domain in your account, at OVHcloud under **Web Cloud › Domain names**. A new domain can take a few minutes to show up.

## 3. Point the domain at your server

Do this first, because the installer checks it before it installs anything. You add exactly one record, an **A record**, which says "`music.example.com` lives at `203.0.113.10`":

| Type | Name (subdomain) | Value (target) |
| --- | --- | --- |
| `A` | `music` | `203.0.113.10`, your server's IPv4 address |

At OVHcloud:

1. In the Control Panel, open **Web Cloud › Domain names**, then your domain, then the **DNS zone** tab.
2. Click **Add an entry** and choose **A**.
3. For **Subdomain**, enter `music`. For **Target**, enter your server's IPv4 address. Confirm.
4. If the table already has another `A` or `AAAA` line for the subdomain `music`, delete it with the **…** button next to it. A leftover record makes the certificate fail.

Other domain sellers use the same fields under other names. The name can be called Host, Name or Subdomain, and the value Target, Points to, Value or IPv4 address. To use the bare domain (`example.com`) instead of a subdomain, the name is `@`. At OVHcloud, leave **Subdomain** empty.

The record usually works within minutes, but it can take up to 24 hours. Carry on while you wait, because step 6 checks it for you.

**You should now see** your new line in the DNS zone table: type `A`, subdomain `music`, target your server's IP address.

## 4. Check that ports 80 and 443 are open

Caddy, the HTTPS proxy that comes with Liedmotif, needs both ports open to the internet to get your certificate. OVHcloud leaves them open. On another provider, or if you turned on a firewall, allow them there.

## 5. Connect to your server with SSH

### Open a terminal

- **macOS:** press Cmd+Space, type `Terminal` and press Enter.
- **Windows 10 or 11:** open Start, type `PowerShell` and open **Windows PowerShell**.
- **Linux:** open the **Terminal** app, often with Ctrl+Alt+T.

To paste into the terminal, use Cmd+V on macOS, Ctrl+V or a right-click on Windows, and Ctrl+Shift+V on Linux.

### Log in for the first time

Type this with your own IP address and press Enter:

```bash
ssh ubuntu@203.0.113.10
```

1. The first time, it asks `Are you sure you want to continue connecting (yes/no/[fingerprint])?`. Type `yes` and press Enter.
2. Paste the temporary password and press Enter. **Nothing appears while you type or paste a password.** That's normal.
3. OVHcloud makes you choose your own password now. Enter the temporary password once more, then your new password twice. Save it in your password manager.
4. The connection then closes, which is also normal. Run the same `ssh` command again and log in with your new password.

**You should now see** a line ending in `$`, like `ubuntu@vps-1a2b3c4d:~$`. You're now typing on your server. Type `exit` and press Enter to get back to your own computer.

### Set up an SSH key

An SSH key is a pair of files on your computer that logs you in instead of a password, and nobody can guess it. Run this on **your own computer**. If the line ends in `ubuntu@vps-…:~$`, you're still on the server, so type `exit` first.

```bash
ssh-keygen -t ed25519
```

1. Press Enter to keep the suggested file.
2. It asks for a passphrase. Type one, which protects the key if your computer is stolen, or press Enter twice for none.

Then copy the key to your server. It asks for your server password one last time. On macOS or Linux:

```bash
ssh-copy-id ubuntu@203.0.113.10
```

On Windows, in PowerShell:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh ubuntu@203.0.113.10 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

**You should now see** that `ssh ubuntu@203.0.113.10` logs you in **without asking for the server password**. It may ask for the key's passphrase, if you set one. If it still asks for the server password, stop here and see [Common problems](#common-problems). Don't turn off password login until this works.

### Turn off password login

Now that your key works, turn off logging in with a password, so nobody can guess their way in. **Keep this terminal window open until the check below passes.** It's your way back in if something goes wrong. Logged in to the server, paste:

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/00-no-passwords.conf
sudo sshd -t && sudo systemctl restart ssh
```

If `sudo` asks for a password, type your server password.

**You should now see,** in a **new** terminal window on your computer, that this command is refused without asking for a password:

```bash
ssh -o PubkeyAuthentication=no ubuntu@203.0.113.10
```

It answers `Permission denied (publickey).` That's the goal: passwords no longer work, and your key does. Close that window and keep working in the one that's logged in.

The Liedmotif installer never changes these SSH settings, because a wrong change there can lock you out of your own server.

## 6. Paste the install line

Logged in to your server, paste this with your own domain and press Enter:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | bash -s -- --domain music.example.com
```

**First it checks your domain.** It finds your server's public address through `ipv4.icanhazip.com`, then looks up your domain's records in public DNS through `cloudflare-dns.com`, the way the certificate service Let's Encrypt sees them. Nothing is installed yet at this point, and later updates skip this check. That protects you, because Let's Encrypt allows only a few failed tries an hour, and now Caddy never asks for a certificate it can't get.

| What it finds | What happens |
| --- | --- |
| No record | It stops and shows the `A` record to add, with your server's address |
| A record pointing elsewhere, such as an old server or a parking page | It stops and names both addresses |
| A lookup that fails | It warns you and carries on, so if it later stops while waiting for Liedmotif to answer, check the record by hand |
| Your server's address | It carries on |

If it stops, fix the record, wait a few minutes and paste the same line again.

**Then it installs.** It installs Docker with Docker's official script if it's missing, and turns on automatic security updates unless something has already set them. It downloads Liedmotif into `/opt/liedmotif` and writes a `.env` settings file with fresh secrets, then starts Liedmotif and gets an HTTPS certificate. It also sets `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443` in `.env`, which opens Liedmotif to the internet at your domain. Tailscale is never touched.

This takes about 5 to 15 minutes. If it shows `[sudo] password for ubuntu:`, type your server password. Each step starts with `==>`. If it stops with `Error`, it names what to try. Fix that and run the same line again, which is always safe. The flags it accepts are listed in [Installer options](/docs/install/home-server#installer-options).

**You should now see** this at the end, with your own version number:

```text
Liedmotif 1.4.0 is running at https://music.example.com

Open this link to create your Admin account:

  https://music.example.com/setup?token=…
```

Below it are a reminder to copy `.env` and the command to update later. Copy the setup link into a private note, and treat it as a password until you've used it: anyone who has it can create the admin account before you do.

## 7. Get your music provider key

Liedmotif makes its music with Suno through sunoapi.org, an independent service not run by Suno. **Every track costs real money** on your own sunoapi.org account, at about 4 cents a track, and tracks are made two at a time. Credit is prepaid, so you can never spend more than you've loaded. Rights to the music depend on your provider and plan.

1. Create an account at [sunoapi.org](https://sunoapi.org).
2. Buy a credit pack. $5 is a good first top-up.
3. Open **Dashboard › API Keys**, create a key and copy it.

Keep the key in your password manager or in the private note with your setup link. You paste it into Liedmotif itself in step 9, which stores it encrypted on your server.

**You should now see** your new key listed under **Dashboard › API Keys** on sunoapi.org, and your credit on the dashboard.

## 8. Create your admin account

1. Open the setup link from step 6 in your browser, on your computer or your phone.
2. On **Create your admin login**, fill in **Email**, **Password** and **Confirm password**. Your password needs at least 12 characters, with a number, an uppercase letter and a special character.
3. Press **Create admin**, and save the password in your password manager.

[First-run safety](#first-run-safety) explains what the token in that link does.

## 9. Walk through guided setup

- **Welcome. What should we call you?** Fill in your **First name**. The rest is optional. Press **Continue**.
- **Put people on your Covers.** Optional. Press **Continue**.
- **Connect your music model.** Paste your key from step 7 into the field that says **Paste it here**, then press **Test the key**. It answers `Music provider reachable; … credits available.` Press **Save and continue**.
- **Set a Track limit.** This is your own spending limit, and it's off by default. Turn on **Limit my Tracks**, set **Tracks per day** and **Tracks per month** to what you're happy to pay, and press **Save and continue**.
- **Add a Writing AI.** Optional. It writes better session names and prompts, and it needs its own key. `.env` calls it a text LLM. **Skip for now** is fine.
- **Choose your Cover art.** Optional. An image key paints covers around your session and your people, at about 7 cents each. Without one, covers come from your music provider at no extra cost. Press **Save and continue**.
- On the last screen, press **Start your first Session**.

**You should now see** Liedmotif's home screen. Describe the moment you're in and start a session.

**Where the spending limits are later:** **Settings** is in the account menu, under your picture in the corner.

- **Yours:** **Settings › Cost limits**, under **Usage**. It opens **Cost controls**, with **Limit my Tracks**, **Daily limit** and **Monthly limit**.
- **Your friends':** every invite carries its own budget, and **Settings › Members › Shared budget** caps all your friends together. Set that one to what you actually want to spend.
- **The backstop:** your prepaid sunoapi.org credit.

## 10. Invite friends

1. Open **Settings › Members**.
2. Under **Invite someone**, type your friend's name in **Who is this invite for?**.
3. Pick a budget and adjust the numbers. **One-time** is one total that never renews. **Rolling** is a set of limits that reset daily and at the start of each month.
4. Press **Create invite link**. An **Invite link** box appears. Press **Copy**, because the link is shown once and works once. It expires after 7 days.
5. Send it to your friend in any messenger.

Your friend opens the link and sees a welcome with their name. They fill in **Your name**, **Email**, **Password** and **Confirm password**, then press **Create my account**. That's all: they listen from any browser, anywhere, with nothing to install.

You need no email setup for this. If you'd like Liedmotif to mail invites and password resets itself, see [Email and storage](/docs/email-and-storage).

To take access away, press **Disable account** on your friend's card under **Settings › Members**. You can remove an invite nobody has used yet with **Revoke** under **Open invites**. [Members](/docs/members) has the rest.

**You should now see** your friend's card under **Members** once they've created their account.

## 11. Keep copies off the server

A server can break or be deleted, so keep two things on your own computer.

**The `.env` file, once, now.** It holds keys that can never be recovered. Without it, your saved provider keys and your backups can't be read. On your own computer, run:

```bash
scp ubuntu@203.0.113.10:/opt/liedmotif/.env liedmotif.env
```

That saves `liedmotif.env` in the folder your terminal is in, usually your home folder. Move it to a password manager or a USB stick, never to a shared folder or an email. Copy it again whenever you change `.env`.

**A backup, now and then.** Once a month is a good start. Liedmotif backs itself up every week on its own, on Sundays at 03:00, and keeps the last 4, but those backups sit on the same server. VPS-1's daily backup stays in the same datacenter too, so neither counts as a copy elsewhere. Open **Settings › Backups** and press **Back up now**. Wait for the new entry to appear, then press **Download** next to it. The file is encrypted and opens only with the passphrase in `.env`.

**You should now see** `liedmotif.env` and a `liedmotif-backup-….tar.enc` file on your own computer. Test a restore once, so you know your backup works. [Backups](/docs/backups) covers restoring one.

## First-run safety

Setup creates the only admin, and whoever reaches it first gets it. On the internet, that's a real race: scanners find new hosts within minutes of a new DNS or certificate entry. So the installer puts a `SETUP_TOKEN` in your setup link before Liedmotif can be reached, and setup refuses everyone without it.

**Treat the link as a secret.** It lands in your browser history, and in the logs of any proxy you put in front of Caddy. Caddy's own log hides it. Once the admin exists, setup locks and the token grants nothing. [The setup token](/docs/privacy-and-security#the-setup-token) has the details, including how to set one on an install by hand.

## Keep your server healthy

**Set your storage quota.** Liedmotif stops making new tracks when it reaches its quota, 10 GiB by default, and keeps playing everything it already has. Set it to what your disk can really hold under **Storage quota** in **Settings › Cost limits**. That's about 20 GiB on a 40 GB plan, because the system, the app, the database and your logs need room too. Never set it to the plan's full disk size, and check the disk itself now and then with `df -h`, because the quota doesn't count the database, backups or Docker. [Alerts](/docs/alerts) can warn you as the quota fills.

**When the disk runs short,** move to the next plan up, such as VPS-2, or move your music to [S3-compatible storage](/docs/email-and-storage). Deleted tracks free up room too. netcup also sells extra block storage at €0.012 per GB before VAT, but its snapshots need the server stopped, and they're no replacement for a backup elsewhere.

**Add swap as insurance.** One very large image upload can push memory well past normal. If `free -h` shows no swap, this adds 2 GB, which costs far less than extra RAM you rarely use:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Restart when asked.** The server installs its own security updates. When you log in and see `*** System restart required ***`, run `sudo reboot`. Liedmotif starts again by itself a minute later.

**Update Docker yourself.** Docker never updates on its own, because an upgrade restarts every container and would stop the music at a random moment. When nobody's listening, run `sudo apt update && sudo apt upgrade`.

**Update Liedmotif** by pressing **Back up now** in **Settings › Backups**, then running the install line from step 6 again. Liedmotif is offline for about a minute, and it ends with `Liedmotif <version> is running at https://music.example.com`. [Updates](/docs/updates) has the details.

## Running behind a proxy such as Cloudflare

You don't need a proxy, because Caddy handles HTTPS on its own. Using Cloudflare for **DNS only** is fine and needs no changes. The rest of this section applies if something stands between your visitors and Caddy, such as a cloud load balancer or Cloudflare's proxy.

> **Don't send your music through Cloudflare's free CDN.** Don't proxy or cache `/api/audio`. Cloudflare may act on large-file delivery that's out of proportion to the rest of a site, unless it comes from one of its own hosting services.

**Skip the DNS check.** A proxied domain points at the proxy on purpose, and so does a domain on a floating IP, so the installer would stop. This turns the check off:

```bash
curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh | LIEDMOTIF_SKIP_DNS_CHECK=1 bash -s -- --domain music.example.com
```

Nothing protects you from failed certificate tries now, so make sure the domain really reaches this server first.

**Tell Liedmotif how many proxies there are.** Limits on failed sign-ins and on invite, reset and setup attempts go by each visitor's address, and Liedmotif needs to know which address to believe. Set this in `.env`:

| `TRUSTED_PROXY_HOPS` | When |
| --- | --- |
| `1` | The default: Caddy alone at the edge |
| `2` | Visitor, then a load balancer or proxy, then Caddy |
| `0` | Nothing in front of the app at all. The limits still work, but everyone shares them |

**Tell Caddy too.** In `/opt/liedmotif/Caddyfile`, uncomment the `trusted_proxies` line and name your proxy's address range. Then apply both changes:

```bash
cd /opt/liedmotif
sudo docker compose up -d --force-recreate web caddy
```

The two settings have to agree:

- **Set too low,** every visitor looks like the proxy, and ten failed sign-ins by anyone lock out everybody.
- **Set too high,** a visitor can write their own address, and the limits stop working.
- **Set to something that isn't a number,** Liedmotif refuses to start, which is on purpose.

> **Updates replace the `Caddyfile`.** The installer unpacks each release over the install folder, including this file. Your edit is gone after every update, so make it again and run the command above. `.env` is kept.

**Keep tokens out of your proxy's logs.** Invite, reset and confirm links carry a one-time token in their path, and the setup link carries one too. Exclude `/join/*`, `/reset/*`, `/confirm/*` and `/setup` from request logging on anything in front of Liedmotif. An invite that sits in a log for 7 days is an account someone can claim.

**Run one copy of the web app.** The sign-in limits live in its memory, so two copies would double every limit, and each restart resets them.

A Cloudflare Tunnel is a different setup, with its own steps in [On your phone](/docs/install/phone-access#cloudflare-tunnel).

## Common problems

### Connecting to the server

- **`Connection timed out` or `Connection refused`.** Check the IP address against the delivery email. A brand-new VPS can take a few more minutes to start.
- **`Permission denied (publickey,password)` on your first login.** Check the username: `ubuntu` or `debian`, never `root`. A password stays invisible while you type, so type it slowly, or paste it.
- **The connection closed right after the password change.** That's normal. Log in again with the new password.
- **`ssh` still asks for the server password after you set up a key.** Run the copy command again and watch for errors. On Windows, check that the key file exists: `type $env:USERPROFILE\.ssh\id_ed25519.pub` prints one line starting with `ssh-ed25519`. Don't turn off password login until key login works.
- **`WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!`** This happens after you reinstall the VPS. Run `ssh-keygen -R 203.0.113.10` and connect again.
- **Locked out, or on a new computer.** In the OVHcloud Control Panel, open your VPS and use its **KVM** console, which works in the browser without SSH. Log in with your server password. To add a new computer's key, paste that computer's `id_ed25519.pub` line into `~/.ssh/authorized_keys`. To turn password login back on, run `sudo rm /etc/ssh/sshd_config.d/00-no-passwords.conf && sudo systemctl restart ssh`.

### The domain and the installer

- **The installer stops with `has no DNS record yet`.** The record isn't live yet, or has a typo. Check [step 3](#3-point-the-domain-at-your-server), wait a few minutes and run the same line again. The server may remember the old answer for a while.
- **The installer stops with `points at …, but this server's address is …`.** A record still points elsewhere. Set the `A` record to the address it names, and delete every other `A` and `AAAA` line for that name.
- **`Warning: could not look up this server's public IP address`.** The installer couldn't check the record and carries on. If it later stops at `Waiting for Liedmotif to answer`, check the record by hand.
- **`curl: command not found`.** Run `sudo apt-get update && sudo apt-get install -y curl`, then the install line again.
- **`Liedmotif did not answer within 300 seconds`.** Usually ports 80 and 443 are blocked, or the DNS record changed during the install. Check [step 4](#4-check-that-ports-80-and-443-are-open), then run the same line again. A slow server can [get more time](/docs/install/home-server#give-a-slow-machine-more-time).
- **You lost the setup link.** Run `grep '^SETUP_TOKEN=' /opt/liedmotif/.env` on the server. Your link is `https://music.example.com/setup?token=` followed by the value after the `=`.
- **Docker commands say "permission denied".** Your user isn't in the `docker` group. Put `sudo` in front of `docker compose`.

### The app

- **Pressing Create admin answers `Setup is not available.`** The link is missing its `?token=…` part. Open the full link from step 6.
- **The setup page sends you to the sign-in page.** The admin account already exists. Sign in with it.
- **Save and continue stays grey on the music screen.** Press **Test the key** first. The button turns on once the test answers `Music provider reachable; … credits available.`
- **`The music provider rejected these credentials.`** The key has a typo or was deleted at sunoapi.org. Create a new one, paste it and press **Test the key** again. After setup, change it under **Settings › AI Providers**.
- **Sign-in fails, or your saves are refused.** Check the address bar. Liedmotif accepts only the one address in `APP_PUBLIC_URL`, which here is your domain.
- **You forgot the admin password.** See [Troubleshooting](/docs/troubleshooting).

### Friends

- **The invite says `This link is no longer valid.`** It was already used, expired after 7 days, or was revoked. Create a new invite.
- **The invite says `You are already signed in`.** It was opened in a browser where you're signed in. Send it to your friend to open on their own device.

## Uninstall

> **`docker compose down -v` deletes your music, your database and every backup on this server, and it can't be undone.** Download a backup from **Settings › Backups** first if you might want your library back, and keep your copy of `.env`, because the download opens only with it.

To keep your data in Docker's volumes, leave out `-v`.

```bash
cd /opt/liedmotif
sudo docker compose down -v
sudo rm -rf /opt/liedmotif
```

Docker stays installed, and the automatic security updates stay on. If you're done with the server altogether, cancel it with your provider, and remove the DNS record from step 3.
