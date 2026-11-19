---
title: Use Liedmotif on your phone
description: How to reach your Liedmotif from a phone or tablet for each kind of install, why it needs HTTPS, and every way to get it.
checkedOn: 2026-11-19
---

Liedmotif is a web app, so your phone needs a browser and an address, and there's no native app to find in a store. If you used the one-line installer, your phone is nearly there already. The rest of this page is for anyone who set things up by hand.

## Reach it from your phone

| Where it runs | What to do on the phone | Who else can reach it |
| --- | --- | --- |
| [Home server](/docs/install/home-server) | Install [Tailscale](https://tailscale.com/download), sign in to the same tailnet, keep it switched on, and open your `https://….ts.net` address | Only devices in your tailnet |
| [Cloud provider](/docs/install/cloud) | Open your domain in any browser | Anyone can load the sign-in page, and only people you invited can sign in |
| [Laptop](/docs/install/local) | Your phone can't reach it as it stands, because the laptop's address, `localhost`, means "this device". Move to a home server, or use a by-hand path below | Only that laptop |
| [Someone else's Liedmotif](/docs/member-help), as a member | Follow your admin's links | Whoever the admin lets in |

A tablet works the same way.

## Why it needs HTTPS

Browsers keep some features for pages they can trust. Such a page is called a secure context: it arrived over HTTPS with a certificate the browser accepts, or it's on the device itself as `localhost`. Your phone isn't the machine running Liedmotif, so for your phone, only HTTPS with a trusted certificate counts.

Without it, you can't:

- **Keep music offline.** The **Available offline** switch disappears, and **Settings › Storage** says **Offline music needs HTTPS.** If your instance has an HTTPS address, it offers **Open the secure address**.
- **Add Liedmotif to your home screen** as a proper app.
- **Rely on background playback.** Music can stop when the phone locks, and the lock-screen controls may not work.

Your sign-in also depends on it. Liedmotif marks its cookies as secure only when `APP_PUBLIC_URL` starts with `https://`.

**Liedmotif has one address.** Sign-in and every save check the browser's address against `APP_PUBLIC_URL`: scheme, host and port. Setup checks host and port, so the first account is made at that address too. Anything else is refused, even when it's the same machine, so you can't use both `https://music.example.com` and a home network address for one install. Pick one and use it everywhere.

## Add it to your home screen

Once Liedmotif opens over HTTPS, you can give it its own icon. Liedmotif has no install button of its own, so you do this from your browser, and its menu wording can vary by version:

- **iPhone or iPad:** in Safari, press the Share button, then **Add to Home Screen**.
- **Android:** in Chrome, open the menu, then **Install and create shortcut**, **Add to Home screen** or **Install app**.

It then opens full-screen, without the browser's address bar, and stays in portrait. Android Chrome is the first phone browser Liedmotif is validated on.

**On an iPhone or iPad, do this if you keep music offline.** iOS may clear a browser's stored music after a few days without use, and a home screen app keeps it. Liedmotif reminds you in **Settings › Storage**.

It's still your server's app, not a copy on your phone. Every page loads from your server, so on a home server, Tailscale has to be on. With no connection at all, it opens the offline library, where you can play whatever you've marked **Available offline**. New music needs a connection.

## Ways to get HTTPS on a phone

The one-line installer sets up the first two for you, so you only need the others for a by-hand setup.

| Path | Best for | On the phone | Reachable from |
| --- | --- | --- | --- |
| [Tailscale](#tailscale) | A home server. **The default, and our recommendation** | The Tailscale app | Your tailnet |
| [Your own domain](#your-own-domain) | A rented server | Nothing | The internet |
| [Cloudflare Tunnel](#cloudflare-tunnel) | A rented server with no open ports. Never a home server | Nothing | The internet |
| [A domain with a DNS challenge](#a-domain-with-a-dns-challenge) | Your own domain on a box that keeps its ports closed | Nothing | Wherever the address reaches |
| [A home network address with an installed certificate](#a-home-network-address-with-an-installed-certificate) | Fully local, with nothing outside your home involved | One certificate to install | Your home network |

### What every by-hand setup needs

For a new instance, start with [steps 1 and 2 of the laptop guide](/docs/install/local) to get the code and your secrets, on a machine with Docker Engine 28+ and Docker Compose 2.24+ (the `docker compose` command, not `docker-compose`). If Liedmotif already runs on this machine, keep its folder and its `.env`: don't create the secrets again, and leave out the `PG_PASSWORD` and `printf` lines below, because the database keeps the password it started with.

**A plain `docker compose up -d` publishes Liedmotif to that machine alone.** Nothing else can reach it until you open it. These are the settings to add to `.env`:

```bash
cat >> .env <<'EOF'
APP_DOMAIN=music.example.com
APP_PUBLIC_URL=https://music.example.com
CADDY_HTTP_PORT=80
CADDY_HTTPS_PORT=443
EOF
echo "SETUP_TOKEN=$(openssl rand -hex 32)" >> .env
PG_PASSWORD=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nDOCKER_DATABASE_URL=postgres://liedmotif:%s@postgres:5432/liedmotif\n' "$PG_PASSWORD" "$PG_PASSWORD" >> .env
```

| Setting | Why |
| --- | --- |
| `APP_DOMAIN` | The name or address Caddy, the HTTPS proxy, serves. Use your own in place of the example |
| `APP_PUBLIC_URL` | `https://` plus the same name. Left at its default, cookies lose their secure flag even though the phone talks HTTPS. A plain `http://` address on anything but this machine stops Liedmotif from starting |
| `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` | Plain port numbers open Caddy to other devices. Without them, Caddy answers only on this machine |
| `SETUP_TOKEN` | **Set it before the internet can reach the machine,** because whoever opens setup first becomes the admin. [The setup token](/docs/privacy-and-security#the-setup-token) explains the risk. On a home network that only you use, you can leave it out |
| `POSTGRES_PASSWORD` and `DOCKER_DATABASE_URL` | The default database password is published along with the code, so replace it before you open the instance. Set these before the first start, because the database keeps the password it starts with |

Then start everything, and open setup with your token:

```bash
docker compose up -d --build
grep '^SETUP_TOKEN=' .env
```

Your setup address is `https://<APP_DOMAIN>/setup?token=<the value>`. It lands in your browser history, so treat it as a secret until you've used it.

> **Editing the `Caddyfile`?** Only the [DNS challenge](#a-domain-with-a-dns-challenge) path needs it. If you installed with the installer, each update replaces that file, so make your edit again afterwards. Settings in `.env` stay.

Your provider keys can go in `.env` too, but it's easier to save them in guided setup, as the other install guides do. If you change `.env` later, run `docker compose up -d` to apply it.

## Tailscale

This is the least painful path, because the phone gets a trusted certificate with nothing to install beyond Tailscale itself. The installer sets it all up, including one firewall step that a by-hand setup would miss, so **use [the home server guide](/docs/install/home-server) if you can.**

By hand, install Tailscale on the machine and the phone, and join them to the same tailnet. In the [Tailscale admin console](https://console.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates**. You need Docker Compose 2.24.4 or newer. `tailscale ip -4` prints the address for the settings below.

Setting `APP_DOMAIN` alone isn't enough, because Caddy gets its certificate through the machine's Tailscale connection, and only `docker-compose.tailscale.yml` gives it access. That file also publishes Liedmotif on the Tailscale address alone, so leave `CADDY_HTTP_PORT` and `CADDY_HTTPS_PORT` out.

```bash
cat >> .env <<'EOF'
APP_DOMAIN=my-host.tailnet-name.ts.net
APP_PUBLIC_URL=https://my-host.tailnet-name.ts.net
COMPOSE_FILE=docker-compose.yml:docker-compose.tailscale.yml
TAILSCALE_IP=100.x.y.z
EOF
```

Then add the system settings that keep Liedmotif up after a reboot or a Tailscale update, and start it:

```bash
printf 'net.ipv4.ip_nonlocal_bind = 1\n' | sudo tee /etc/sysctl.d/99-liedmotif-tailscale.conf
sudo sysctl -q -p /etc/sysctl.d/99-liedmotif-tailscale.conf
sudo mkdir -p /etc/systemd/system/tailscaled.service.d
printf '[Service]\nRuntimeDirectoryPreserve=yes\n' | sudo tee /etc/systemd/system/tailscaled.service.d/liedmotif.conf
sudo systemctl daemon-reload
docker compose up -d --build
```

> **This leaves out the installer's firewall rules.** Without them, a device on your home network could reach Liedmotif by deliberately routing the Tailscale address through this machine. The `prepare_tailnet_host` function in the app's `docker/install.sh` writes those rules.

This doesn't work with Docker Desktop on a Mac, which has no Tailscale connection for Caddy to use.

## Your own domain

Point a domain at a server with ports 80 and 443 open, and Caddy gets a public certificate by itself. Phones trust it automatically. [Install on a cloud provider](/docs/install/cloud) does this for you with `--domain`, and it's the way to go on a rented server.

By hand, it's the settings above with your domain.

## Cloudflare Tunnel

A tunnel gives your domain a publicly trusted certificate from Cloudflare, with ports 80 and 443 closed on the server. The phone just opens the address.

> **Rented servers only, never a home server.** A tunnel puts Liedmotif on the public internet, so a break-in through the app would land inside your home network. At home, use Tailscale.
>
> **Your music would run through Cloudflare.** Cloudflare may act on large-file delivery that's out of proportion to the rest of a site, so read its current terms before you stream through a tunnel.

Follow [what every by-hand setup needs](#what-every-by-hand-setup-needs), with a hostname in a domain Cloudflare manages, but don't start it yet. Use `CADDY_HTTP_PORT=127.0.0.1:80` and `CADDY_HTTPS_PORT=127.0.0.1:443` instead of the plain port numbers, and add one more line:

```bash
echo "TRUSTED_PROXY_HOPS=2" >> .env
echo "CADDY_TRUSTED_PROXIES=private_ranges" >> .env
echo "CADDY_TLS=internal" >> .env
```

The two port values keep Caddy on this machine, because the tunnel is the only way in, and they tell Liedmotif that's your choice. The other three lines are there because `cloudflared` stands in front of Caddy:

- `TRUSTED_PROXY_HOPS=2` counts it, and [Running behind a proxy](/docs/install/cloud#running-behind-a-proxy-such-as-cloudflare) explains what it does.
- `CADDY_TRUSTED_PROXIES=private_ranges` tells Caddy to believe the visitor address `cloudflared` passes on from this machine's private network. If `cloudflared` reaches Caddy from somewhere else, name that address range instead.
- `CADDY_TLS=internal` makes Caddy sign its own certificate. With its ports closed, Caddy can't get a public one for your hostname. Cloudflare's connection to it never leaves the server.

Updates keep all three, because they live in `.env`.

Point `cloudflared` at Caddy, never at `web:3000`. Caddy carries the security headers, the upload limit and the log redaction that hides invite tokens. In the dashboard, these settings are under **Public Hostname › Additional settings › TLS**. In a config file:

```yaml
ingress:
  - hostname: music.example.com
    service: https://caddy:443 # https://localhost:443 when cloudflared runs on the server itself
    originRequest:
      originServerName: music.example.com # the same as APP_DOMAIN, so Caddy picks this site
      noTLSVerify: true
  - service: http_status:404
```

Without `originServerName`, `cloudflared` asks Caddy for a certificate for `caddy` or `localhost`, which Caddy doesn't have. `https://caddy:443` works only when `cloudflared` runs in a container on Liedmotif's own Docker network.

Exclude `/join/*`, `/reset/*`, `/confirm/*` and `/setup` from request logging in Cloudflare, so your one-time links don't sit in a log. Then start it with `docker compose up -d --build`.

## A domain with a DNS challenge

If you own a domain and your DNS provider has a Caddy plugin, Caddy can get a publicly trusted Let's Encrypt certificate without ports 80 and 443 being reachable from the internet. Phones trust it automatically.

1. Point a DNS record, or a wildcard, at the machine. A home network address is fine for this.
2. Use a Caddy build with your DNS provider's plugin, and add a `tls { dns <provider> ... }` block to the `Caddyfile`.
3. Set `APP_DOMAIN`, `APP_PUBLIC_URL`, `CADDY_HTTP_PORT=80` and `CADDY_HTTPS_PORT=443` as [above](#what-every-by-hand-setup-needs), and start it.

If the record holds a home network address, the instance works only where that address does.

## A home network address with an installed certificate

This is fully local, with nothing outside your home involved. The price is installing a certificate once on every device, and Liedmotif works only on your home network. The steps below are for Android, the one phone these docs cover for this path.

**Give the machine a fixed address,** and use it in `.env`. A name works instead only if Caddy treats it as internal: `localhost`, or a name ending in `.localhost`, `.local`, `.internal` or `.home.arpa`, and the phone must resolve it to the machine. For any other name, such as `nas.fritz.box`, Caddy asks a public certificate authority for a certificate, which fails on a home network.

```bash
cat >> .env <<'EOF'
APP_DOMAIN=192.168.1.20
APP_PUBLIC_URL=https://192.168.1.20
CADDY_HTTP_PORT=80
CADDY_HTTPS_PORT=443
EOF
docker compose up -d --build
```

Caddy now serves that address with its own internal certificate authority.

**Copy its root certificate out:**

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

**On Android,** transfer `caddy-root.crt` to the phone and install it under **Settings › Security › Encryption & credentials › Install a certificate › CA certificate**. Android warns that a third party can monitor your traffic. That's expected when you run your own certificate authority.

**On a computer,** import it among the certificate authorities of your browser or your system.

Then open `https://192.168.1.20` on the phone. The root certificate lasts ten years, and you don't need to reinstall it if the address changes.

**Away from home,** a WireGuard tunnel that routes your home network reaches the same address, so one bookmark works in both places.

## Plain HTTP

A plain `http://` address isn't a secure context, so it's no use on a phone. Liedmotif's direct port, 2206, also listens only on the machine itself. If you deliberately want plain HTTP as the public address on a trusted network, `ALLOW_INSECURE_PUBLIC_URL=1` lets Liedmotif start, with a warning, and its cookies lose their secure flag.
