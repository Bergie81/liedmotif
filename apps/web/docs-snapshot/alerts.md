---
title: Instance alerts
description: Get a message when Liedmotif's worker stops, background jobs fail for good or storage fills up, by webhook, email or both.
checkedOn: 2026-11-11
howTo: true
---

`docker compose ps` can say everything is healthy while no new music gets made. Alerts tell you before you find out by pressing play. They're off until you turn them on, and you set them up in `.env` and a scheduled check on the machine. There's no settings page and no extra container, and only the admin receives them.

## What you get alerted about

| Alert | Severity | What it means |
| --- | --- | --- |
| Worker heartbeat | Critical | The worker never reported, or last reported over 5 minutes ago. Tracks you've paid for won't finish. An ordinary restart or update stays under that window. |
| Failed jobs | Warning | At least one background job ran out of attempts and won't retry by itself. A failed track doesn't count: this is a job that kept crashing. It clears once those jobs are retried or deleted. See [What to do about an alert](#what-to-do-about-an-alert). |
| Storage quota | Warning, then critical | A warning from 80% of your storage quota. Critical once there's no room for the next generation (two tracks with Suno), the moment new tracks are refused. Stored bytes are measured hourly, so this can lag by up to an hour. |

Each problem sends one message when it starts or changes severity, and one when it's fixed. The recovery says how long the whole problem lasted: three days at warning and then ten minutes at critical reads as about three days. A bad week doesn't turn into a flood.

If Liedmotif can't read a source, for example because storage hasn't been measured yet, it alerts about nothing. A problem it already announced stays announced, so it never reads as fixed by accident.

Messages carry only the problem's name, severity, counts, percentages and durations, never your prompts or keys. The one identifying detail is your instance's host name, taken from `APP_PUBLIC_URL`. That's what a webhook receiver or a mail service sees of your instance.

> **This can't report the machine itself being down.** If the machine, Docker, the web container or Postgres is dead, nothing sends. For that you need an uptime check from another machine, and `https://<your address>/api/health` is there for it. A failing scheduled check is the local sign that the alert path itself is broken.

## 1. Choose where alerts go

You can use a webhook, email or both. With both set up, both are used.

**Webhook.** Set `ALERT_WEBHOOK_URL` to the address of a service that takes a JSON POST. Plain `http` to a receiver on your own network is fine. The address is never logged, so it may carry the receiver's own token in its path or query. A user name or password in the address (`user:token@`) can't be sent, so the app refuses to start with one. [The webhook message](#the-webhook-message) lists what's sent. No receiver has been tried with it yet, so test yours by hand before you rely on it.

**Email.** Alerts go to the admin's confirmed address and nowhere else. This needs [account email](/docs/email-and-storage) turned on, and your address confirmed in **Settings › Profile**.

## 2. Turn it on

Create a token. This is what switches alerts on, so turning on account email for invites starts no alerts by itself.

```bash
openssl rand -hex 32
```

Add it to `.env` in your install folder, with your webhook if you have one:

```bash
ALERT_CHECK_TOKEN=your-token
ALERT_WEBHOOK_URL=http://192.168.1.20:2586/liedmotif
```

Then load the new settings. `docker compose restart` doesn't re-read `.env`, so use this:

```bash
docker compose up -d web
```

If the settings don't fit together, the app refuses to start and `docker compose logs web` says why:

| The log says | What to do |
| --- | --- |
| `ALERT_WEBHOOK_URL is set but ALERT_CHECK_TOKEN is not` | Set the token, or clear the webhook. |
| `ALERT_CHECK_TOKEN is set but alerts have nowhere to go` | Set a webhook, turn on account email, or clear the token. |
| `ALERT_WEBHOOK_URL must be an absolute http:// or https:// URL.` | Fix the address. |
| `ALERT_WEBHOOK_URL must not carry a user name or password` | Move the receiver's token into the address's path or query, the way the receiver accepts it. |

## 3. Schedule the check

The machine calls Liedmotif every five minutes and Liedmotif does the rest. Your token goes into a file only root can read, because any user on the machine can read a crontab entry or a command line while it runs. Run this from the folder that holds `.env`:

```bash
sudo touch /etc/liedmotif-alert-header
sudo chmod 600 /etc/liedmotif-alert-header
sed -n 's/^ALERT_CHECK_TOKEN=/x-alert-token: /p' .env | tr -d "\"'" | sudo tee /etc/liedmotif-alert-header > /dev/null
```

Open root's crontab with `sudo crontab -e` and add this line:

```text
*/5 * * * * curl -fsS --max-time 60 -o /dev/null -H @/etc/liedmotif-alert-header http://127.0.0.1:2206/api/alerts/check
```

It needs curl 7.55 or newer. If you changed `WEB_PORT`, use your port instead of 2206. At this rhythm, a dead worker is announced within about ten minutes. `--max-time 60` leaves room for a slow mail server.

If a check fails, cron reports it the way your machine is set up to, usually as local mail.

## 4. Test it

Run the check by hand and read the report. It holds no secret and not your address.

```bash
sudo curl -s -H @/etc/liedmotif-alert-header http://127.0.0.1:2206/api/alerts/check
```

A working setup with nothing wrong looks like this:

```json
{"ok":true,"checkedAt":"...","firing":[],"dispatched":[],"dispatchFailures":0,
 "destinations":{"webhook":"on","email":"no-confirmed-address"}}
```

`webhook` says `on` or `off`. `email` says `on`, `off` or `no-confirmed-address`. `firing` lists what's wrong right now, and `dispatched` lists what this run sent.

| Status | What it means |
| --- | --- |
| 200 | The check ran and every message it needed to send went out, or there was nothing to send. |
| 403 | The token is missing or wrong. |
| 404 | `ALERT_CHECK_TOKEN` isn't set, as far as the app can see. Run `docker compose up -d web`. |
| 502 | A send failed, or nothing can deliver. An email-only setup with no confirmed address answers this on every run. |
| 503 | The database couldn't be read or written. |

To see a real alert arrive, stop the worker when nobody is listening:

```bash
docker compose stop worker
```

Wait more than five minutes, then run the check by hand. You should get the worker message. Start the worker again and run the check once more for the recovery. No new music is made in between.

```bash
docker compose start worker
```

## If a message gets lost or repeated

- **It reached none of your destinations:** the next run sends everything again, so a short outage can repeat a message.
- **It reached one destination and the other failed:** the run answers 502, but the failed destination gets no second try.
- **Sending worked, but saving that fact failed:** the run answers 503 and the next run sends again.

## The webhook message

Each problem that changes sends one JSON POST, with a 5-second timeout. A redirect is refused and counts as a failed send, so use the receiver's final address.

```json
{
  "instance": "music.example.com",
  "condition": "worker-heartbeat",
  "severity": "critical",
  "state": "firing",
  "title": "Liedmotif worker is not reporting",
  "message": "Worker heartbeat: the worker last reported 12 minutes ago. Generations will not finish.",
  "text": "Worker heartbeat: the worker last reported 12 minutes ago. Generations will not finish.",
  "content": "Worker heartbeat: the worker last reported 12 minutes ago. Generations will not finish.",
  "at": "2026-11-04T12:00:00.000Z"
}
```

| Field | What it holds |
| --- | --- |
| `instance` | The host of `APP_PUBLIC_URL`. |
| `condition` | `worker-heartbeat`, `failed-jobs` or `storage-quota`. |
| `severity` | `warning` or `critical`. |
| `state` | `firing` or `recovered`. A recovery also has `since`, when the problem first started. |
| `title` | A short headline. |
| `message`, `text`, `content` | The same sentence three times, because receivers look for it under different names. |
| `at` | When it was sent. |

Each POST also has two request headers: `Title`, with the headline, and `Priority`, which is `urgent` for critical, `high` for warning and `default` for a recovery.

Which part each receiver reads:

| Receiver | What it reads |
| --- | --- |
| Slack | `text` |
| Discord | `content` |
| Gotify | `message` and `title` |
| ntfy | The `Title` and `Priority` headers. On a topic address, the whole JSON body becomes the message text. |

Receivers differ, and no single shape fits them all. Send yours this test first, and check that it shows up the way you want. Use your own address.

```bash
curl -i -X POST "http://192.168.1.20:2586/liedmotif" \
  -H 'content-type: application/json' -H 'Title: Liedmotif test' -H 'Priority: default' \
  -d '{"title":"Liedmotif test","message":"Test alert","text":"Test alert","content":"Test alert"}'
```

## What to do about an alert

**Worker heartbeat.** Run `docker compose ps -a` and `docker compose logs worker --tail 50`. [Troubleshooting](/docs/troubleshooting) covers the usual causes.

**Failed jobs.** Open **Settings › Diagnostics & worker**. **Queued jobs** shows how many have failed. Look for the reason with `docker compose logs worker --tail 50`. The alert clears at the next check after those jobs are retried or deleted, but Liedmotif has no button or documented command for that yet. Until then it stays announced without sending more messages.

**Storage quota.** Delete music you no longer keep, or raise **Storage quota** in **Settings › Cost limits**. The freed space shows at the next hourly measurement. **Settings › Storage** shows what's stored.
