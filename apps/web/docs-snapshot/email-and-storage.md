---
title: Email and storage
description: Let Liedmotif send invites and password resets, decide whether your library belongs on disk or in a bucket, and see how much room your music takes.
checkedOn: 2026-11-19
---

Both of these are optional, and Liedmotif works fine without them. Add account email when other people use your instance, or when you want a way back in if you forget your password. Most people should leave storage on the server's own disk, the default.

## Account email

With email on, Liedmotif mails its one-time links for you. Without it, you copy each link and hand it over yourself.

| | Email on | Email off |
| --- | --- | --- |
| Inviting someone | You type their address, and the invite arrives by mail. That address becomes their login | You copy the invite link and send it yourself |
| Forgot password | **Forgot password?** on the sign-in page mails a link | The sign-in page doesn't offer it |
| Changing your password | **Change password** in **Settings › Profile** mails a link | The same button asks for your current password |
| Resetting a member's password | **Reset password** on their card mails a link | You copy the link and send it yourself |
| [Instance alerts](/docs/alerts) by email | Possible | Webhook only |

Everything else, music included, works the same either way. An admin locked out with email off can still [reset the password on the server](/docs/troubleshooting).

### Set it up

Account email has no settings page. Add these two lines to `.env`, in the folder that holds your Liedmotif files (`/opt/liedmotif` after a one-line install, `liedmotif` on a laptop):

```bash
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=Liedmotif <you@example.com>
```

Then apply them. `docker compose restart` won't do, because it doesn't read `.env` again. If your user isn't in the `docker` group, put `sudo` in front:

```bash
docker compose up -d web
```

Set both lines or neither. If only one is set, or `SMTP_URL` can't be read, Liedmotif refuses to start and tells you which line to fix. Links in the mail are built from `APP_PUBLIC_URL`, so that line needs to be the address you actually use.

- **Special characters.** Encode them in the user name and password: `@` as `%40`, `/` as `%2F`, `#` as `%23`.
- **Secure connection.** `smtps://` is encrypted from the start, on port 465, and it's what we recommend. `smtp://` upgrades to encryption only if the server offers it, and otherwise sends your password in the clear. Use it only with a server that offers STARTTLS, or a relay on a network you trust.
- **Your mail password stays private.** It never reaches a log. A failed send logs only a short code, such as `EAUTH` or `ECONNECTION`, which you can read with `docker compose logs web`.

### Example: Gmail

1. Turn on 2-Step Verification for the account.
2. Create an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. Remove the spaces from its 16 characters, and write the `@` in your address as `%40`:

```bash
SMTP_URL=smtps://you%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465
MAIL_FROM=Liedmotif <you@gmail.com>
```

Keep `MAIL_FROM` on the same Gmail address, because Gmail replaces any sender it hasn't verified with the account's own address.

### Where to send from

Use a mailbox you already have, as above, or a mail service. At this volume, both are free, and your own domain delivers best. Sending directly from a home server isn't supported, because mail from a residential address lands in spam or gets refused.

### Confirm your address

A reset mail only goes to a confirmed address on an account that isn't disabled. A member who joined through a mailed invite is confirmed from the start. Everyone else, the admin included, confirms like this:

1. Open **Settings › Profile** and press **Send confirm link**.
2. Open the mail, follow the link, and press **Confirm email**.

Until then, **Forgot password?** sends that address nothing, and its reply reads the same either way, so nobody can use it to test which addresses exist. **Reset password** on a member's card shows a link to copy instead and says why. Instance alerts by email also go only to the admin's confirmed address.

**Do this now if you're the admin.** It's what gets you back in when you forget your password.

### If you set up with a placeholder address

A reset mail can only reach you at a real inbox. To replace the address you used during setup, open **Settings › Profile** and change the email. It asks for your current password and signs out your other devices. With email on, a confirm link goes to the new address straight away, and **Send confirm link** sends another if it doesn't arrive. Moving away from a confirmed address also mails that old address a notice of the change. An address that an open invite was mailed to is refused with `That address has an open invite. Revoke the invite first.` Revoke it under **Open invites** in **Settings › Members**, then save again.

### How long links last

| Link | Lasts |
| --- | --- |
| Reset link by mail | 1 hour |
| Reset link you copied | 24 hours |
| Confirm link | 24 hours |
| Invite | 7 days |

A new reset link cancels any older ones for that account.

## Where your data lives

By default, everything stays in Docker volumes on the machine running Liedmotif, separate from the app itself. Updates and restarts leave them alone.

| Volume | What it holds |
| --- | --- |
| `liedmotif-pg` | The database: accounts, sessions, playlists, settings, your saved keys in encrypted form |
| `liedmotif-data` | Track audio, covers, avatars and photos of your people |
| `liedmotif-backups` | [Your backups](/docs/backups) |
| `caddy-data`, `caddy-config` | HTTPS certificates, proxy state and the access log |

`docker compose down` keeps all of these. **`docker compose down -v` deletes all of them, backups included.**

**The database and the music belong together.** A track is an audio file plus a database row, and one without the other won't play. Keep them together when you move things around.

### Using your own folder

To keep music in a folder you can see, rather than a Docker volume, replace `liedmotif-data` with `./data` in `docker-compose.yml`, on the `/data` line of `web`, `worker` and `backup`. The folder has to exist and belong to user 1000, or the app can't write to it:

```bash
mkdir -p ./data
sudo chown -R 1000:1000 ./data
```

That's all a new install needs. An instance that already has music needs its files moved as well. With Liedmotif stopped, copy everything in the `liedmotif_liedmotif-data` volume into `./data` before you start again, or your existing tracks won't play.

Liedmotif checks its storage folder at every start and refuses to start if it can't write there. The error names the setting without showing the path.

**Using a separate disk?** Give Liedmotif a folder of its own on it, such as `/mnt/music/liedmotif`, and mount that folder at `/data`, never the disk's top level. The top level of a freshly formatted disk holds a `lost+found` folder that the app can't read, so it refuses to start. Running from source, point `DATA_DIR` at that folder.

> **The one-line installer replaces `docker-compose.yml` on every update.** Your edit would be lost and the app would be back on the empty volume, so stay with the volume on an installer setup.

## How much room you need

A track takes about 5 MB, so 1,000 tracks need about 5 GB, and that's about 58 hours of music. Backups share unchanged files with each other, so they add little on top. A 64 GB disk is plenty to start.

**Settings › Storage** shows what you've used. Two limits keep a growing library from causing harm:

**The storage quota** is 10 GiB by default, about 2,000 tracks. It counts track audio, covers and photos of your people, but not avatars. Change it under **Storage quota** in **Settings › Cost limits**. At the quota:

- Sessions stop making new tracks, and uploads are refused, with a message that names the quota.
- Playing, deleting and work already underway carry on.
- Nothing is ever deleted to make room. Raising the quota or deleting tracks is what gets things moving again.

Room you free up shows after the next measurement, which happens hourly and whenever the worker starts. A write that would cross the quota is refused even while the total is still under it, because Liedmotif reserves room for the largest possible file first.

**The free-space floor** sits underneath the quota. With less than 256 MB left on the disk, uploads are refused and downloads of finished tracks wait and retry, so a full disk can't take your database down with it.

## S3-compatible object storage

Instead of the server's disk, Liedmotif can keep all its files in a bucket on a storage service. Sessions, playback and everything else behave the same.

**It's worth it when:**

- The library should survive a server rebuild.
- You want cheap, durable storage for a big library.
- The web app and worker run as separate services, with no disk to share.

**Stay on disk when** Liedmotif runs on one machine and has room. It's simpler, plays slightly faster and [backs up in one place](/docs/backups).

**The trade-offs:**

- The first play or a seek can be slightly slower, because each file has to come from the bucket first.
- Some services charge for data going out, and every play reads from the bucket. Check your service's prices.
- Liedmotif's backups then hold only the database, and the list says so. Turn on versioning for your bucket. If you also snapshot it, do that at or after the database backup, never before, because a snapshot taken earlier misses files the backup points to, and those tracks won't play.
- The quota still applies, but the free-space floor doesn't, because a bucket has no disk to measure.

### Set it up

Any service that speaks the S3 API works: AWS S3, Cloudflare R2, Backblaze B2, Hetzner Object Storage or a MinIO you run yourself. Liedmotif doesn't include MinIO. Create a private bucket and a key for it, then add this to `.env`:

```bash
STORAGE_PROVIDER=s3
S3_REGION=us-east-1
S3_BUCKET=liedmotif
S3_ACCESS_KEY_ID=your-key-id
S3_SECRET_ACCESS_KEY=your-secret
S3_ENDPOINT=https://your-service.example
#S3_FORCE_PATH_STYLE=true
#S3_KEY_PREFIX=liedmotif
```

| Setting | What to put |
| --- | --- |
| `S3_REGION` | Required. S3-compatible services accept any value |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Required |
| `S3_ENDPOINT` | Your service's address. Leave it blank for AWS itself |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO and other services that need path-style addresses |
| `S3_KEY_PREFIX` | Optional. A folder name, for sharing a bucket with other data |

Start Liedmotif with `docker compose up -d`. If a required line is missing, it refuses to start and names that line, so a half-finished setup never writes files into nowhere. With `STORAGE_PROVIDER` blank or missing, Liedmotif uses the disk.

**On AWS,** a key with the fewest rights needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:AbortMultipartUpload` on the objects, and `s3:ListBucket` on the bucket. Without `s3:ListBucket`, AWS answers a missing file with "forbidden" instead of "not found", and the app reports an error where it expects a simple miss.

**Add a rule that clears unfinished uploads.** If Liedmotif stops in the middle of an upload, the parts already sent stay in the bucket. They never show up as files, and the service bills them until they are aborted. Add a lifecycle rule to the bucket that aborts incomplete multipart uploads, for example after one day; Liedmotif doesn't clean these up itself. If the bucket also holds other data, limit the rule to Liedmotif's folder (`S3_KEY_PREFIX`). Services other than AWS differ, so check that yours supports this rule. On AWS, see [aborting incomplete multipart uploads with a lifecycle rule](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html).

**How your media is served.** Your bucket can stay fully private, and it should. Your server reads the files and passes them to the browser, after checking that the listener is allowed to have them. No bucket address ever reaches a browser.

### Move an existing library

Copy the library across before you switch, or your existing tracks won't play. The folders on disk match the names in the bucket, so a plain sync is all it takes, with nothing to change in the database. Copy everything in your data folder or volume to the top of the bucket, or into your `S3_KEY_PREFIX` folder if you use one.

Stop Liedmotif first, so that nothing writes during the copy:

```bash
docker compose down
```

Then sync with any S3 tool, using the key you created for Liedmotif. With the AWS CLI:

```bash
aws s3 sync /path/to/data s3://liedmotif --endpoint-url https://your-service.example
```

On AWS itself, leave out `--endpoint-url`. If you use `S3_KEY_PREFIX`, sync into that folder: `s3://liedmotif/liedmotif`.

`/path/to/data` is where your files are, and that's the one part Liedmotif has no ready-made step for:

- **Your own folder:** the path to that folder.
- **The Docker volume on Linux:** the volume is `liedmotif_liedmotif-data`, and `docker volume inspect` shows its folder as `Mountpoint`. Only root can read it, so run the sync as root, with your key set up for root.
- **The Docker volume on a Mac or Windows:** Docker Desktop keeps the volume inside its own virtual machine, out of reach of tools on your computer. Run your S3 tool in a container that mounts the volume.

Then add the `STORAGE_PROVIDER=s3` and `S3_*` lines to `.env` and start again:

```bash
docker compose up -d
```

To move back to disk, stop Liedmotif and run the same sync in the other direction, with the two locations swapped. Then clear `STORAGE_PROVIDER`, remove the `S3_*` lines, and fix the ownership of the copied files before you start:

```bash
docker compose run --rm --user root --cap-add CHOWN worker chown -R 1000:1000 /data
docker compose up -d
```
