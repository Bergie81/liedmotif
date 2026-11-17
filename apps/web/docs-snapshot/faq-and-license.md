---
title: FAQ and license
description: Straight answers on costs, providers, rights, downloads, offline use, moving your install and the license.
checkedOn: 2026-11-17
faq: true
---

These are the questions that come up once the basics are clear. For the basics, such as which services you need or why you can't just sign up somewhere, start with the [home page FAQ](/#faq).

## Costs and providers

### What does it cost?

There's no single number, because you put the bill together yourself. Four things decide it: your music provider and its price, how many new tracks you make, your writing AI (none, a hosted one, or a local one with Ollama), and your covers (generated, or the free ones). Playing a track you already have costs nothing, however often you play it. A rented server, if you go that way, is a separate bill. Today there's one kind of music provider to choose, a Suno-compatible one. [Costs and limits](/docs/costs-and-limits) shows how to keep it all in check.

### Can I use another music provider?

Not yet. Liedmotif works with one kind of music provider today: a Suno-compatible service, sunoapi.org by default. `SUNO_BASE_URL` in `.env` can point it at another service with the same API, but nothing else is supported. Generated covers are the same, with OpenRouter as the one image provider. You do get a choice of writing AI and of storage. See [Providers and keys](/docs/providers-and-keys).

### Can I run music generation on my own hardware?

Not yet. That's the goal once local models sound good enough, but nothing is built, so every new track needs a music provider and an internet connection. Your writing AI can already run locally, with Ollama on the same machine, and the free covers need no extra service.

## Your music

### Who owns the music I make, and can I publish it?

That depends on your music provider and your plan with it, not on Liedmotif. Liedmotif's license covers the app, not your tracks, and Liedmotif gives no guarantee that a track is free of other people's rights or safe to publish. Before you publish, sell or upload a track, read the terms of the service you pay, and of the company behind the model if that's a different one. **Track Data** on a track shows which provider and model made it.

### Can I make music that sounds like a named artist?

No, Liedmotif doesn't offer that. Describe what the music is for instead: moods, moments, genres, sounds. If you name one anyway, a writing AI turns the name into a description of the sound. Without a writing AI, your words go to your music provider as typed, its rules decide what it accepts, and some providers refuse a request that names an artist.

### Can I use Liedmotif commercially?

Not without permission. Liedmotif is free for non-commercial use only, so running it for a business or charging people for access needs separate terms. Write to [liedmotif@gmail.com](mailto:liedmotif@gmail.com). The music is a separate matter: what you may do with it commercially depends on your provider and your plan.

### What happens to my music if I stop paying the provider?

It stays, and it keeps playing. Liedmotif fetches every finished track to your own instance, so your sessions, playlists, downloads and the lounge don't rely on your provider account. From then on, your music is only as safe as your own machine, so keep [backups](/docs/backups).

What stops is new music. A running session shows **Generation paused** and plays its ready tracks until the provider has credits again, and a new session has nothing to play until then. This hits everyone on your instance, because members use your keys.

The optional services fail gently or clearly. A cover that can't be made leaves the session with the cover it has. A writing AI that stops answering gives you an error you can retry when you start a session or use **Change Vibe**, until you top it up or press **Disable Writing AI** in **Settings › AI Providers**. If `.env` configures it, remove those lines too. Lyrics timing is fetched from your music provider the first time someone opens a vocal track's lyrics, so a track nobody opened yet shows plain lyrics instead of synced ones.

### Can I download my music?

Yes. **Download Track** gives you a finished track as an MP3. **Download Session** and **Download Playlist** give you a ZIP of MP3s, numbered in play order. A ZIP holds up to 500 tracks, so a longer session or playlist stops there. Each MP3 carries its title, artist name, cover, lyrics and generation details, so it stays recognizable in any other player.

Only your own finished tracks are included. A track still in progress, a track you disliked and a track someone shared with you in the lounge are left out. There's no button for your whole library at once. A [backup](/docs/backups) holds the whole instance, but only the admin can download one and it opens only with the passphrase from `.env`, so it isn't a way to export your music.

## Using it

### Do I have to type my own name to be in my songs?

No. With a text LLM, your **About you** shapes the lyrics of every vocal session, and a request that puts you in the scene names you in the lyrics and puts you on the cover. It goes by what you mean: "With Jonas and Clara on the way back to Berlin" includes you, and so does "Auf dem Weg mit Jonas und Clara nach Berlin". Other people need their saved name. [You in your own songs](/docs/features#you-in-your-own-songs) has examples, and **Run without my profile details** on **Home** leaves you out of one session.

### Does it work offline?

Listening does, making music doesn't. New tracks need your instance to reach your provider over the internet.

To listen without a signal, open the options menu of a playlist or session while you're online and turn on **Available offline**. This device then keeps its tracks. The download only runs while the app is open, so keep it open until the menu says **Ready offline**. With no connection, Liedmotif opens the **Offline Library** and plays them in the normal player. It's listen-only, so you can't make, save or edit anything there.

The mark is per device, needs HTTPS or `localhost`, and holds up to 5 GB by default. [Available offline](/docs/features#available-offline) has every limit, including what iPhones need.

### Which browsers and devices does it work on?

Liedmotif is a web app, so it runs in a browser on your phone, tablet or computer, and there's no native app to install. Phones get bottom navigation, and wide screens get a sidebar. On a phone, you can add it to your home screen to open it like an app.

Chrome on Android is the first target for phone testing, and there's no official list of supported browsers or versions. When a browser can't run the blending engine, tracks play one after another without the crossfades. **Loop a Part** is refused on a device that reports under 4 GB of memory.

A phone needs an HTTPS address to get the most out of it. [Phone access](/docs/install/phone-access) shows the ways to set that up.

### How many people can share one instance?

One admin, and as many members as you invite: the app sets no fixed number. What limits you is money, disk space and how many listen at once.

- **Money.** All members together share one budget, by default 50 tracks a day and 250 a month. A new invite starts with a one-time budget of 50 tracks. The admin can change all of these.
- **Disk.** A track takes about 5 MB, and the instance has a storage quota of 10 GiB by default. At the quota, sessions stop making new tracks until you raise it or delete tracks.
- **Server.** The app's hosting notes size a server with 2 cores and 4 GB of RAM for you plus up to ten members, and the disk fills up before the memory does. Members' tracks are made a few at a time, so when many people listen at once, new ones can take longer.

Everyone has their own one running session. See [Members, invites and the lounge](/docs/members).

### Can I move to a different install later?

Yes. A backup carries your whole instance: accounts, sessions, playlists, history and, when the backup includes them, music and covers. Download one from **Settings › Backups**, install Liedmotif in the new place, then restore it there with one command. [Backups and restore](/docs/backups) has the steps.

Four things to get right:

- **Secrets.** Copy `CREDENTIAL_ENCRYPTION_KEY`, `APP_SECRET`, `BETTER_AUTH_SECRET` and `BACKUP_ENCRYPTION_PASSPHRASE` from the old `.env` to the new one first. Without them, your saved keys stay unreadable, everyone has to sign in again and the backup won't open. Provider keys and other settings you keep only in `.env` aren't in the backup, so copy those lines too.
- **Version.** Restore into the same Liedmotif version or a newer one, never an older one.
- **Address.** A domain of your own keeps the same address when you move. If the address does change, tell your members. Each device then marks its offline music again and adds the new address to its home screen.
- **The old install.** Shut it down once the new one works. Both copies hold the same provider keys, so both can spend your money.

If your music is in an S3-compatible bucket, the backup holds only the database, and the bucket stays where it is. Copy `STORAGE_PROVIDER` and the `S3_` lines from the old `.env` before you start the new install, or it looks for your music on its own disk.

## License

Liedmotif is source-available under PolyForm Noncommercial 1.0.0. It isn't open source, because the license restricts commercial use. The full text is in the app's `LICENSE.md`, and that text is what counts.

- **What's free.** Running your own instance for yourself, your family and your friends, as long as no business or payment is involved. You can also change the code and share it for non-commercial purposes. Charities, schools, public research bodies and government institutions can use it too.
- **Commercial use.** The author, Thomas Bergmann (Bergie81), holds the copyright and can grant separate terms. Write to [liedmotif@gmail.com](mailto:liedmotif@gmail.com).
- **What it doesn't cover.** Third-party parts keep their own licenses: the app's `NOTICE.md` and every image's `THIRD_PARTY_NOTICES.txt` list them. The Liedmotif name and logo may only appear in unchanged copies of the app and in what it produces. Music you make falls under your provider's terms.
- **Contributions.** Bug reports and ideas are welcome. Outside code isn't accepted for now. To report a security problem, write to [liedmotif@gmail.com](mailto:liedmotif@gmail.com) instead of opening a public issue.
