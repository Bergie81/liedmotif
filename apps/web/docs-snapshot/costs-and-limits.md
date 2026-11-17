---
title: Costs and limits
description: What you pay for and to whom, what is free, how each action spends, and every limit Liedmotif offers, counted in tracks.
checkedOn: 2026-11-17
---

Liedmotif is source-available, free for non-commercial use. The money goes straight from you to the providers you connect, and almost all of it pays for new tracks. This page shows how each action spends, which limits you can set, and what happens when one is reached.

## Who you pay

| What | Who you pay | Typical price |
| --- | --- | --- |
| New tracks | Your music provider | About 4 cents per track |
| Tailored covers (optional) | OpenRouter | About 7 cents per cover on the default model |
| Writing AI (optional) | Your text provider, or nobody with Ollama | Small and usage-based. The 4-cent figure already rounds up a little to absorb it |
| Rented server (cloud only) | Your cloud provider | [See the cloud guide](/docs/install/cloud) |

These are the app's own round figures for the default providers. The real price is whatever your provider charges, and your provider's dashboard shows your real bill. [Providers and keys](/docs/providers-and-keys) explains how to set each one up.

## What a session might cost

A track runs about 3.5 minutes, so an hour of new music takes about 17 tracks. At 4 cents per track:

| New music | Tracks | Estimated cost |
| --- | --- | --- |
| A 40-minute session | About 12 | About 50 cents |
| One hour | About 17 | About 70 cents |
| An hour a day for a month | About 510 | About $20 |
| Your first $5 | About 125 | About 7 hours of music |

These are estimates, because track lengths vary and prices are your provider's to change. Only new music counts. A 40-minute session that then repeats for the rest of the day still costs about 50 cents. On the other hand, a session keeps a few tracks ready ahead of you, so the moment you stop you may have paid for tracks you haven't heard yet. They stay in the session for next time.

## What's free

All of this buys nothing:

- Replaying any track, session or playlist you already have
- Repeat, on any session
- **Loop Track** and **Loop a Part**
- Playing a playlist, including one shared with you in the lounge
- Previewing a track, and downloading tracks
- Saving, searching, organizing and renaming
- Resuming a session with **New music** off
- Pressing **Try another** in Surprise Me, as far as music goes. With a writing AI connected, each try uses it a little
- Basic covers from your music provider, the built-in Liedmotif cover, and uploading your own
- Guided setup and the **Test** button

**Skipping** buys nothing by itself, but in a session with **New music** on, it uses up the tracks ready ahead of you sooner, so the next new ones come sooner too.

## How each thing spends

**Tracks come in pairs.** Your music provider makes tracks two at a time, and both are full tracks you keep. That's why daily, monthly and one-time track limits, and **Generating at once**, move in twos and must be even numbers. It's also why a session can run slightly past its target.

### New music on

A session with **New music** on keeps a few tracks ready ahead of you: 3 by default, adjustable from 1 to 10 under **Tracks generated in advance** in **Settings › Generation**. It orders more when the supply drops below that, and only while someone is listening.

### New music off

A session with **New music** off loops what it has and buys nothing more. A session started this way still makes its first pair, since it needs something to play. You can change this from the player at any time. **Off** takes effect at once. Anything that could spend waits for you to press **Save**, so a stray tap doesn't spend anything.

**Generate new Tracks by default**, in **Settings › Generation**, decides how new sessions start.

### Session duration

A duration caps how much new music a session buys. It counts the music made, not your listening time, so skipped tracks count and disliked or deleted ones don't. Past the target, the session loops what it has until you stop it.

- The slider on the start card runs up to 180 minutes, in steps of 5. Sessions accept any whole number from 1 to 600 minutes, so a writing AI can pick up a longer one from your request.
- **Auto** finds a duration in your words when a writing AI is connected. Without one, a session keeps going until you stop it.
- You can change the target while the session plays, and raising it starts new tracks again.
- Setting a target turns **New music** on for that session, since only new tracks can fill it.
- At the target, a change of vibe is refused unless the same change raises or clears the target.

### Change Vibe

A change of vibe buys the first new tracks in the new direction, even with **New music** off. It also uses your writing AI once, if you wrote a new direction. It needs room for one more pair within your limits. Tracks you already have stay paid for and remain in your history.

### Dislike

Pressing **Reroll Track** is often free. Since tracks come in pairs, Liedmotif first looks for the unplayed second track from the same pair, which you've already paid for. It buys a new pair only when there isn't one, and only if **New music** is on and your limits have room. With **New music** off, or on a track from a vibe you've since changed, it serves the second track if there is one and otherwise buys nothing. A reroll doesn't use the writing AI for direction or lyrics. If it buys a new pair in a session that's out of titles, the writing AI may write a few more.

### Covers

With tailored art, a new session buys one cover. Each regeneration buys another, and a generated playlist cover buys one too. A session holds up to 10 covers in its history. A change of vibe never makes a new cover by itself.

### Asking Roadie

Each question to Roadie, the AI assistant, is a small request to your writing AI. It buys no music and counts against no track or cover limit. Two things keep it small. Nobody can send more than 20 questions in 5 minutes. And each member has a daily allowance, 30 messages unless you change it, which resets at midnight in the **Instance timezone**. Under **Settings › Members** you set the allowance for everyone or for one member, from 1 to 1,000 a day, or switch Roadie off for a member. As the admin you have no daily allowance, since the key is yours.

Roadie never buys music or covers by itself. Asked for new music, a Surprise Me, a change of vibe, more like a track, New music on or a new cover, it shows a card in the chat, and nothing is generated until you press the button on it. What that starts counts against your track or cover limits like the same button in the app; a cover card shows the cover budget line the cover dialog shows. Roadie can resume a session for you without a card, because resuming is not a new purchase: the session carries on with the New music setting you gave it, as when you press **Resume** yourself. With New music on it generates again, inside your limits. Preparing a Surprise Me card uses your writing AI a little, as **Try another** does, and buys no music; the question still counts as one message.

### When nobody is listening

New tracks need a listener. Pause or close the player, and spending stops within about 2 minutes, though work already underway finishes. Playing a playlist, or having **Loop a Part** running, holds new tracks back as well.

A session with no listener then stops itself after **Idle auto-stop**, 15 minutes by default. It keeps its direction and tracks, and you can resume it whenever you like.

**Manual generation only**, in **Settings › Generation**, is the emergency brake. It stops all new music on the instance, even a new session's first tracks.

## Your own limits

As the admin, you can leave your own spending open, since you're paying for it. A new install starts that way, and guided setup lets you turn limits on. Everything here is under **Cost controls** in **Settings › Generation**, and the **Cost limits** row in Settings leads to the same place.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| **Limit my Tracks** | Off | | Turns the two limits below on for your own listening. Members keep their own budgets |
| **Daily limit** | 50 tracks | 0–2,000 | New tracks per day, about 3 hours of music |
| **Monthly limit** | 250 tracks | 0–62,000 | New tracks per month |
| **Limit my Covers** | Off | | Turns the two cover limits below on |
| **Covers per day** | 25 | 0–1,000 | Generated covers per day |
| **Covers per month** | 100 | 0–31,000 | Generated covers per month |

These apply whether or not your own limits are switched on:

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| **Generating at once** | 2 tracks | 2–40 | Higher fills the queue faster and spends faster |
| **Max queued Tracks** | 6 tracks | 1–100 | The most a session can keep ready ahead, even if **Tracks generated in advance** asks for more |
| **Headroom to start** | 5 tracks | 0–100 | The room you need left to start a session |
| **Idle auto-stop** | 15 minutes | 1–10,080 | How long a session without a listener stays active |
| **Storage quota** | 10 GiB | | [Room for your whole library](/docs/email-and-storage), about 2,000 tracks |
| **Manual generation only** | Off | | Stops all new music |
| **Generate Tailored Cover Art** | On | | Needs an image key. Off, covers come from your music provider |

Zero is a valid limit where the range allows it, and it deliberately blocks that kind of generation. Daily limits reset at midnight and monthly limits on the 1st, in the **Instance timezone** at the top of **Cost controls**. It starts from guided setup, or from `INSTANCE_TIMEZONE` in `.env`, and it applies to members as well.

## Budgets for members

Every member has a budget, and every member's music also draws from one shared budget. Members can't change either one. They see both under **Settings › My budget**. You set them under **Settings › Members**, and [Members, invites and the lounge](/docs/members) walks through inviting people. Your budget for each member is one of two kinds:

- **One-time** is a total to use at their own pace, and it never renews. It's what a new invite starts with. When it's used up, they ask you for more.
- **Rolling** renews with new tracks and covers every day and month.

| | One-time | Rolling, per member | Shared budget, all members |
| --- | --- | --- | --- |
| Tracks | 50 in total | 20 a day, 100 a month | 50 a day, 250 a month |
| Covers | 25 in total | 10 a day, 25 a month | 25 a day, 125 a month |
| Generating at once | 2 tracks | 2 tracks | 4 tracks |
| Queued ahead | 6 tracks | 6 tracks | |

A monthly figure can't be lower than its daily one. The budgets you hand out can add up to more than the shared budget. The app warns you but allows it, and inside the shared budget it's first come, first served. The numbers for at-once and queued tracks are fixed, and the app has no field for them.

Your own limits sit outside the shared budget, and your listening never draws from it. So the most you can spend in a month is your own limits plus the shared budget. At the default prices, the default shared budget comes to at most about $19 a month for all members together: $10 for 250 tracks and $8.75 for 125 covers.

A deleted member's spending still counts until its day or month rolls over.

## When a limit is reached

Reaching a limit never ends a session. It stays active and replays what it has, and new tracks return by themselves when there's room again, with nothing for you to press.

| What ran out | What you see | How it comes back |
| --- | --- | --- |
| Your own limit | "Generation limit reached — replaying this session until it resets." | At reset, or when you raise it |
| A member's rolling budget | "You have used your tracks for now — replaying this session until your budget resets." | At reset, or when the admin raises it |
| The shared budget | "The shared budget is used up — replaying this session until it resets." | At reset, or when the admin raises it |
| A one-time budget | "Your budget is used up. Ask the Admin for more.", or the admin's name if they've set one | Only when the admin adds more |
| The cover budget | Regenerating is refused, and sessions keep the cover they have | At reset, or when the budget is raised |
| The storage quota | New tracks and uploads stop, with a message naming the quota. Playing and deleting still work | When you raise it or delete tracks |
| Provider credit | **Generation paused**, and the session plays what it has | When you [top up with the provider](/docs/providers-and-keys) |

On the player, a banner above the cover says what is holding new music. If it happens while you're on another page, the same message shows once as a notification at the top of the screen. For a reached limit it links to **Settings › Cost limits**, or for a member to **Settings › My budget**.

### Starting something new

New sessions and **More Like This** need more room than a running session, so that a new one has enough tracks to loop. With less room than **Headroom to start**, you see **No generation headroom right now** and no session is created. You're offered **Resume a Session** or your library instead. A member with 4 tracks left in a one-time budget can't start something new, but can resume a session and use them there.

Resuming is never blocked, and **Change Vibe** needs room for just one more pair. Only one session can start at a time. Cancelling a start before it's created buys no music, though your writing AI may already have been paid for its part.

## What the estimated costs show

Enter your own prices under **Unit costs** in **Settings › AI Providers**, as **Per Track** and **Per Cover** in US dollars, to the cent: `0.04` for four cents, not `4`. They start at $0.04 and $0.07, the default providers' prices rounded up. On other providers or models, change them to match. Set both to zero, and every dollar figure disappears.

The admin then sees dollar figures next to the counts:

- In **Settings**, on the usage meters
- In **Settings › Generation**, on the track and cover limits
- In **Settings › Members**, on every budget, with a total of what you've committed and used
- In **Your Stats**, on the **Costs** tab, comparing your own spending with your members', and each member's

These are estimates, not an invoice. They multiply your counts by today's prices, so changing a price also changes the figures for the past. Every attempt that may have been billed counts, including uncertain ones. Your provider's dashboard has the real number.
