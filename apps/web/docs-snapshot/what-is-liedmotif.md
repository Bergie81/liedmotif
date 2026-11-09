---
title: What Liedmotif is
description: How Liedmotif works from your first request to the music you keep, what an instance is made of, and what the app's words mean.
checkedOn: 2026-11-09
---

Liedmotif is an app you run yourself. You ask for music in your own words, your music provider makes it, and Liedmotif keeps making more while you listen. This page explains how that works, what you're installing, and what the app's words mean.

## How it works

### You ask

Type what the music is for: a mood, a moment, a place, a sound. For example, `Late train home, soft piano, nothing too sad`. Next to your request, you can pick a genre, an energy, vocals or instrumental, a singer and a language. Music is instrumental unless you choose vocals.

### A session starts

Your request becomes a session: one continuous listen with its own style, queue, name and cover.

With a writing AI connected, your request turns into a steady style for the whole session, and the session and its tracks get proper names. Without one, your words go to the music model as you wrote them, and the names are built from your request.

You have one session running at a time. Starting a new one stops the old one, which stays in your sessions, ready to resume.

The first track takes a while, because your provider has to make it. The player tells you what's happening at each stage.

### Tracks are made ahead of you

While you listen, the session keeps a few tracks ready, three by default, so there's little or no wait between them. They crossfade into each other.

New tracks are only ordered while someone is listening. Starting or resuming a session counts, because it has to fill its queue first, and when playback stops, new orders end within about two minutes. A session nobody plays stops itself, after 15 minutes by default, and you can resume it later.

### You steer

- **Change Vibe** changes the direction of the session you're in. Say what should change, or change your picks. The tracks already in the queue play out first, unless you ask to switch as soon as the first new track is ready. This is the only action that changes the direction.
- **Dislike** removes a track and brings a different take on the same vibe. The button says **Reroll Track**. It often costs nothing, because your provider makes tracks in pairs, and Liedmotif plays the unplayed partner first. With no partner left, it orders a new take only while the session is making new tracks, within your limits, and only if the track belongs to the current vibe. Otherwise the track is just removed.
- **Skip** moves on to the next track, and nothing else changes.
- **More Like This** starts a new session from a track you love.

There's no like button. If you let a track play, the session simply carries on.

### You keep what you love

Add a track to a playlist, or star it to put it in your favorites, a playlist every account has. The rest stays too: your history lists every track made for you, and a session stays until you delete it. The one exception is a track you disliked, which is deleted after about 24 hours.

### Spending stops when you say

- **Give a session a duration.** It makes about that much new music, then replays its tracks at no cost. The music keeps playing until you stop it.
- **Turn off New music.** The session replays what it has. No more new tracks, and work your provider has already started still finishes. The exception is **Change Vibe**, which still makes a first batch in the new direction.
- **Set limits, counted in tracks.** At a limit, a running session loops its own tracks instead of stopping, and you can't start a new one. On a new install, the admin's own daily and monthly limits stay off until you set them, for example in guided setup.
- **Stop listening.** New orders end within about two minutes, and work your provider has already started still finishes.

[Costs and limits](/docs/costs-and-limits) has the details.

## What's in an instance

An instance is one install of Liedmotif. It belongs to whoever set it up, and it's made of these parts:

| Part | What it does |
| --- | --- |
| The app | The website you open. It signs people in, runs the player and serves your music. |
| The worker | The part that works in the background. It orders tracks from your provider, fetches the finished files and sorts out covers. |
| The database | Postgres. It holds accounts, sessions, playlists, history and your provider keys, encrypted. |
| Music storage | Where the audio and covers live: the machine's own disk, or an S3-compatible bucket. |
| Your providers | Outside services you sign up for and pay directly. A music provider is required, and a writing AI and a cover image provider are optional. |

Two helpers run beside them: a backup service, and Caddy, which gives a server its HTTPS address.

Your provider keys stay on the server, and browsers never see them. Your requests do go to the providers you connect, because they make the music. [Providers and keys](/docs/providers-and-keys) covers your choices.

## Who's who

**The admin** is the person who set up the instance, and there's exactly one. Only the admin manages provider keys, instance limits, instance storage, backups and the list of members, and the admin pays the providers. In the app, the admin sees usage and storage totals, not other people's music, unless it's shared with them in the lounge.

**A member** joins through an invite link from the admin, and gets their own private sessions, library, people and settings. Their music is made with the admin's keys, within a budget of tracks and covers that the admin sets. Members never see the keys. [Members, invites and the lounge](/docs/members) has the rest.

## The app's words

| Word | What it means |
| --- | --- |
| Session | One continuous listen, born from one request. It has its own style, queue, place in the queue, name and cover. It stays until you delete it, and you can resume it. |
| Track | One song. Limits and budgets are counted in tracks. |
| New music | Your choice of whether a session makes new tracks while you listen, within your limits: **Off**, **Up to a duration** or **No limit**. |
| Repeat | What a session does when it isn't making new music: it loops the tracks it already has, at no cost, and orders no more on its own. Only a session's start and **Change Vibe** still make a first batch. |
| Change Vibe | Changes the direction of the running session, while keeping the same session, queue and place. It's the only action that steers. |
| More Like This | Starts a new session from one or more tracks, and stops the one that's running. |
| Dislike | Means "not this track". It hides the track, deletes it after about 24 hours and, when it can, brings a different take on the same vibe, without changing the direction. The button says **Reroll Track**. |
| Playlist | Tracks you picked, in the order you want. A playlist never makes new music. For more of the same, use **More Like This** on it, which starts a new session. |
| Lounge | Where people on one instance share playlists, with everyone there or with people they pick. A share is live, nothing leaves the instance, and there are no public links. |
| Admin | The one person who runs the instance, holds the provider keys and invites people. |
| Member | An invited person with their own private space and a budget, using the admin's keys. |
| Writing AI | An optional service that turns your request into a style and names your sessions and tracks. It works per session and on **Change Vibe**, and tries to add a fresh lyric angle to new tracks in vocal sessions. If that fails, the tracks are still made. `.env` calls it the text LLM. |
| Music model | The service that turns a prompt into audio, for every new track. It's the one required provider, and today it's a Suno-compatible one. |
| Cover | The square artwork of a session, shared by all its tracks. An image provider can paint one to suit the session. Otherwise your music provider draws one at no extra cost. Every session starts on a built-in placeholder, and keeps it if no cover can be made. Generated covers count toward the cover limits, whichever provider made them. You can also upload your own, and **Change Vibe** never replaces it. A session keeps up to ten covers. |

## What it isn't

**It isn't a hosted service.** There's no Liedmotif account to sign up for and no subscription. Each instance runs on its owner's own machine or rented server, with their own provider keys, and they pay those providers directly.

**It isn't a catalog of existing music.** You can't search for a song or an artist and play it. Your library starts empty, and holds what's been made on your instance for you, plus what people share with you in the lounge.

Ready to try it? [Pick where to install it](/docs).
