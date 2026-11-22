---
title: Costs and Limits
description: What you pay for and to whom, what is free, how each action spends, and every limit Liedmotif offers, counted in tracks.
checkedOn: 2026-11-22
---

Liedmotif is source-available, free for non-commercial use. The money goes straight from you to the providers you connect, and almost all of it pays for new tracks. This page shows how each action spends, which limits you can set, and what happens when one is reached.

## Who You Pay

| What | Who you pay | Typical price |
| --- | --- | --- |
| New tracks | Your music provider | About 4 cents per track |
| Tailored covers (optional) | OpenAI, Gemini or OpenRouter | About 6, 4 or 7 cents per cover on their default models |
| Text AI (optional) | Your text provider, or nobody with Ollama | Small and usage-based. The 4-cent figure already rounds up a little to absorb it |
| Rented server (cloud only) | Your cloud provider | [See the cloud guide](/docs/install/cloud) |

These are the app's own round figures for the default providers. The real price is whatever your provider charges, and your provider's dashboard shows your real bill. [Providers and keys](/docs/providers-and-keys) explains how to set each one up.

## What a Session Might Cost

A track runs about 3.5 minutes, so an hour of new music takes about 17 tracks. At 4 cents per track:

| New music | Tracks | Estimated cost |
| --- | --- | --- |
| A new session on the default 30 minutes | About 10 | About 40 cents |
| A 40-minute session | About 12 | About 50 cents |
| One hour | About 17 | About 70 cents |
| An hour a day for a month | About 510 | About $20 |
| Your first $5 | About 125 | About 7 hours of music |

These are estimates, because track lengths vary and prices are your provider's to change. Only new music counts. A 40-minute session that then repeats for the rest of the day still costs about 50 cents. On the other hand, a session keeps a few tracks ready ahead of you, so the moment you stop you may have paid for tracks you haven't heard yet. They stay in the session for next time.

## What's Free

All of this buys nothing:

- Replaying any track, session or playlist you already have
- Repeat, on any session
- **Loop Track** and **Loop a Part**
- Playing a playlist, including one shared with you in the Lounge
- Previewing a track, and downloading tracks
- Saving, searching, organizing and renaming
- Resuming a session with **New Music** off
- Pressing **Try Another** in Surprise Me, as far as music goes. With a text AI connected, each try uses it a little
- Basic covers from your music provider, the built-in Liedmotif cover, and uploading your own. Basic covers cost nothing extra, but they still count toward your cover limits
- Guided setup and the **Test** button

**Skipping** buys nothing by itself, but in a session with **New Music** on, it uses up the tracks ready ahead of you sooner, so the next new ones come sooner too.

## How Each Thing Spends

**Tracks come in pairs.** Your music provider makes tracks two at a time, and both are full tracks you keep. That's why daily, monthly and one-time track limits, and **Generating at once**, move in twos and must be even numbers. It's also why a session can run slightly past its target.

### New Music On

A session with **New Music** on keeps a few tracks ready ahead of you: 3 by default, adjustable from 1 to 10 under **Tracks generated in advance** in **Settings › Generation**. It orders more when the supply drops below that, and only while someone is listening.

### New Music Off

A session with **New Music** off loops what it has and buys nothing more. Every new session starts with **New Music** on, and you switch it off from the player at any time. **Off** takes effect at once. Anything that could spend waits for you to press **Save**, so a stray tap doesn't spend anything.

### Session Duration

A duration caps how much new music a session buys. It counts the music made, not your listening time, so skipped tracks count and disliked or deleted ones don't. Past the target, the session loops what it has until you stop it, and that costs nothing more.

Every new session gets a duration. When you don't pick one, it takes your default, **New music per Session** in **Settings › Generation**: **5 min**, **15 min**, **30 min**, **1 h**, **2 h** or **No limit**. It's **30 min** until you change it, and **Save New Music** saves it. Because tracks come in pairs, **5 min** usually buys one pair, about 6 minutes, and **30 min** about five pairs. **No limit** keeps buying while you listen, until you stop or a limit is reached. Each member sets their own.

- At the target, the session repeats its tracks for free, and the player's status shows "New Music Finished", or "Done" on a phone, with the minutes generated: "Done · 35 min" for a 30 min target, since tracks come in pairs.
- To keep going, tap that status or **New Music** in the options menu. Choose **Up to a Duration** and move the slider higher, or choose **No Limit**, then press **Save**. That changes this session only, not your default.
- The slider on the start card runs up to 180 minutes, in steps of 5. Its **Auto** stop names the default it stands for, such as "Auto · 30 min". Sessions accept any whole number from 1 to 600 minutes, so a text AI can pick up a longer one from your request.
- **Auto** uses a duration from your words when a text AI is connected, otherwise your default. A length you pick on the slider wins over both. The start card has no **No limit** stop: for a session without a limit, choose **No Limit** in the player, or make it your default.
- **More Like This** starts with your default. **Surprise Me** uses its suggestion's own length when it has one, and your default when it doesn't.
- A card from Roadie for a new session has the same slider. It starts at the length you named, or at your default, and the card says what you'll buy, such as "Generates up to 30 min of new music." Roadie can't change your default.
- You can change the target while the session plays, and raising it starts new tracks again.
- Setting a target turns **New Music** on for that session, since only new tracks can fill it.
- At the target, a change of vibe is refused unless the same change raises or clears the target.

**After an update** from a version without this setting, new sessions get **30 min**. If you had switched off the old **Generate new tracks by default**, your default is **5 min** instead, so new sessions still buy about one pair and then repeat. Sessions you already have keep the duration they had, or none.

### Change Vibe

A change of vibe buys the first new tracks in the new direction, even with **New Music** off. It also uses your text AI once, whether you wrote a new direction or only changed a setting. The one exception is an older session that was started from settings alone, with no words: changing only a setting there applies it without asking the text AI for a new direction. It needs room for one more pair within your limits. Tracks you already have stay paid for and remain in your history.

### Try Again

When a session's first tracks fail and it has nothing to play, its banner offers **Try Again**. One tap buys one batch, the number of tracks shown on the button, within your limits like any other generation, and it counts toward them. More tracks follow only once music plays. Nothing tries again on its own: a session with nothing to play never spends without your tap.

### Dislike

Pressing **Reroll Track** is often free. Since tracks come in pairs, Liedmotif first looks for the second track from the same pair, which you've already paid for, if it's still waiting in the queue. A track you skipped doesn't count. It buys a new pair only when there isn't one, and only if **New Music** is on and your limits have room. With **New Music** off, or on a track from a vibe you've since changed, it serves the second track if there is one and otherwise buys nothing. A dislike in a stopped session, for example from the Library, buys nothing either, also not after you resume it. A reroll doesn't use the text AI for direction or lyrics. If it buys a new pair in a session that's out of titles, the text AI may write a few more.

### Covers

With tailored art, a new session buys one cover. Each regeneration buys another, and a generated playlist cover buys one too. A session or a playlist holds up to 10 covers in its history, uploads included; delete one to make room. A change of vibe never makes a new cover by itself.

### Asking Roadie

Each question to Roadie, the AI assistant, is a small request to your text AI. It buys no music and counts against no track or cover limit. Two things keep it small. Nobody can send more than 20 questions in 5 minutes. And each member has a daily allowance, 30 messages unless you change it, which resets at midnight in the **Instance timezone**. Under **Settings › Members** you set the allowance for everyone or for one member, from 1 to 1,000 a day, or switch Roadie off for a member. As the admin you have no daily allowance, since the key is yours.

Roadie never buys music or covers by itself. Asked for new music, a Surprise Me, a change of vibe, more like a track, New Music on or a new cover, it shows a card in the chat, and nothing is generated until you press the button on it. What that starts counts against your track or cover limits like the same button in the app; a cover card shows the cover budget line the cover sheet shows. Roadie can resume a session for you without a card, because resuming is not a new purchase: the session carries on with the New Music setting you gave it, as when you press **Resume** yourself. With New Music on it generates again, inside your limits. Preparing a Surprise Me card uses your text AI a little, as **Try Another** does, and buys no music; the question still counts as one message.

### When Nobody Is Listening

New tracks need a listener. Pause or close the player, and spending stops within about 2 minutes, though work already underway finishes. Playing a playlist, or having **Loop a Part** running, holds new tracks back as well.

A session with no listener then stops itself after **Idle auto-stop**, 15 minutes by default. It keeps its direction and tracks, and you can resume it whenever you like.

**Pause all new music**, in **Settings › Generation**, is the emergency brake. It stops all new music on the instance, even a new session's first tracks. While it is on, a new session, More Like This, Surprise Me and Change Vibe are refused before anything is spent, your text AI included, with the message "New music is paused in Settings › Generation." A member is told, by name, that you paused it. Resume, the Library, playlists and the Lounge keep working.

## Your Own Limits

As the admin, you can leave your own spending open, since you're paying for it. A new install starts that way, and guided setup lets you turn limits on. Everything here is under **Cost Controls** in **Settings › Generation**, and the **Cost Limits** row in Settings leads to the same place.

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| **Limit my tracks** | Off | | Turns the two limits below on for your own listening. Members keep their own budgets |
| **Daily limit** | 50 tracks | 0–2,000 | New tracks per day, about 3 hours of music |
| **Monthly limit** | 250 tracks | 0–62,000 | New tracks per month |
| **Limit my covers** | Off | | Turns the two cover limits below on |
| **Covers per day** | 25 | 0–1,000 | Generated covers per day |
| **Covers per month** | 100 | 0–31,000 | Generated covers per month |

These apply whether or not your own limits are switched on:

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| **Generating at once** | 2 tracks | 2–40 | Higher fills the queue faster and spends faster |
| **Max queued tracks** | 6 tracks | 1–100 | The most a session can keep ready ahead, even if **Tracks generated in advance** asks for more |
| **Headroom to start** | 5 tracks | 0–100 | The room you need left to start a session |
| **Idle auto-stop** | 15 minutes | 1–10,080 | How long a session without a listener stays active |
| **Storage quota** | 10 GiB | | [Room for your whole library](/docs/email-and-storage), about 2,000 tracks |
| **Pause all new music** | Off | | Stops all new music. New sessions, More Like This, Surprise Me and Change Vibe are refused; Resume and the Library keep working |
| **Generate Tailored Cover Art** | On | | Needs an image provider with a key, its own or your text AI's. Off, covers come from your music provider |

Zero is a valid limit where the range allows it, and it deliberately blocks that kind of generation. A daily or monthly limit above zero but below **Headroom to start** means no new session can ever start, so the form warns you, for example "Below 5 tracks, no new session can start." It still saves, and nothing else changes to make it fit. A monthly limit lower than the daily one is allowed; then the monthly one runs out first. Guided setup doesn't let your track limits go below **Headroom to start**, rounded up to a whole pair. Daily limits reset at midnight and monthly limits on the 1st, in the **Instance timezone** at the top of **Cost Controls**. It starts from guided setup, or from `INSTANCE_TIMEZONE` in `.env`, and it applies to members as well.

## Budgets for Members

Every member has a budget, and every member's music also draws from one shared budget. Members can't change either one. They see both under **Settings › My Budget**. You set them under **Settings › Members**, and [Members, invites and the Lounge](/docs/members) walks through inviting people. Your budget for each member is one of two kinds:

- **One-Time** is a total to use at their own pace, and it never renews. It's what a new invite starts with. When it's used up, they ask you for more.
- **Rolling** renews with new tracks and covers every day and month.

| | One-time | Rolling, per member | Shared budget, all members |
| --- | --- | --- | --- |
| Tracks | 50 in total | 20 a day, 100 a month | 50 a day, 250 a month |
| Covers | 25 in total | 10 a day, 25 a month | 25 a day, 125 a month |
| Generating at once | 2 tracks | 2 tracks | 4 tracks |
| Queued ahead | 6 tracks | 6 tracks | |

A monthly figure can't be lower than its daily one. A track figure above zero but below your **Headroom to start**, in a member's daily or monthly budget, a one-time total or the shared budget, means that member can never start a new session. The form warns you, for example "Below 5 tracks, no new session can start.", but still saves it. The budgets you hand out can add up to more than the shared budget. The app warns you but allows it, and inside the shared budget it's first come, first served. The numbers for at-once and queued tracks are fixed, and the app has no field for them.

Your own limits sit outside the shared budget, and your listening never draws from it. So the most you can spend in a month is your own limits plus the shared budget. At the default prices, the default shared budget comes to at most about $19 a month for all members together: $10 for 250 tracks and $8.75 for 125 covers.

A deleted member's spending still counts until its day or month rolls over.

## When a Limit Is Reached

Reaching a limit never ends a session. It stays active and replays what it has, and new tracks return by themselves when there's room again, with nothing for you to press.

| What ran out | What you see | How it comes back |
| --- | --- | --- |
| Your own limit | "Generation limit reached — replaying this session until it resets." | At reset, or when you raise it |
| A member's rolling budget | "You have used your tracks for now — replaying this session until your budget resets." | At reset, or when the admin raises it |
| The shared budget | "The shared budget is used up — replaying this session until it resets." | At reset, or when the admin raises it |
| A one-time budget | "Your budget is used up. Ask the admin for more.", or the admin's name if they've set one | Only when the admin adds more |
| The cover budget | Regenerating is refused, and sessions keep the cover they have | At reset, or when the budget is raised |
| The storage quota | New tracks and uploads stop, with a message naming the quota. Playing and deleting still work | When you raise it or delete tracks |
| Provider credit | **Generation paused**, and the session plays what it has | When you [top up with the provider](/docs/providers-and-keys) |

On the player, a banner above the cover says what is holding new music. If it happens while you're on another page, the same message shows once as a notification at the top of the screen. For a reached limit it links to **Settings › Cost Limits**, or for a member to **Settings › My Budget**.

### Starting Something New

New sessions and **More Like This** need more room than a running session, so that a new one has enough tracks to loop. With less room than **Headroom to start**, you see **Not Enough Tracks Left to Start** and no session is created, wherever you started it: Home, Surprise Me, the player, the Library, a playlist or the Lounge. The message says what a new session needs and what is left, for example "A new session needs 5 tracks; you have 4 left today.", and when more come back: at midnight for a daily limit, on the 1st for a monthly one, both in the instance timezone. When the monthly limit would still fall short after midnight, it names the 1st; when a one-time budget would, it says that budget doesn't reset. If the limit itself is lower than **Headroom to start**, waiting won't help, and it says so: the admin raises the limit or lowers **Headroom to start**, and a member is told to ask the admin. You're offered **Resume a Session** or your library instead. A member with 4 tracks left in a one-time budget can't start something new, but can resume a session and use them there.

Resuming is never blocked, and **Change Vibe** needs room for just one more pair. Only one session can start at a time. Cancelling a start before it's created buys no music, though your text AI may already have been paid for its part.

## What the Estimated Costs Show

Enter your own prices under **Unit Costs** in **Settings › AI Providers**, as **Per track** and **Per cover** in US dollars, to the cent: `0.04` for four cents, not `4`. They start at $0.04 and $0.07, the default providers' prices rounded up. On another music provider or model, change them to match. Set both to zero, and every dollar figure disappears.

**Per cover** follows the image provider you save: $0.06 for OpenAI, $0.04 for Gemini and $0.07 for OpenRouter, the default models' prices rounded up. It follows only while it holds one of those three prices. Any other price, zero included, is your own, and changing provider leaves it alone. If you paint with a model that costs more or less, enter its price yourself.

The admin then sees dollar figures next to the counts:

- In **Settings**, on the usage meters
- In **Settings › Generation**, on the track and cover limits
- In **Settings › Members**, on every budget, with a total of what you've committed and used
- In **Your Stats**, on the **Costs** tab, comparing your own spending with your members', and each member's

These are estimates, not an invoice. They multiply your counts by today's prices, so changing a price also changes the figures for the past. Every attempt that may have been billed counts, including uncertain ones. Your provider's dashboard has the real number.
