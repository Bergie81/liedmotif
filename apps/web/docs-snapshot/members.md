---
title: Members, invites and the lounge
description: Bring people onto your Liedmotif, set what they can spend, share playlists with them, and take access back when you need to.
checkedOn: 2026-11-20
---

Your instance can hold your whole household or a group of friends. Each person you invite becomes a member with their own account. Their music is paid from your provider keys, inside a budget you choose, so you always know the most they can cost. As the admin, you run all of this from **Settings › Members**, which only you can see.

## Check they can reach your instance

An invite link starts with your instance's address, the one set as `APP_PUBLIC_URL`. Liedmotif uses that address as it is and doesn't check who can open it, so make sure your guest can.

| Where Liedmotif runs | What your guest needs |
| --- | --- |
| Your laptop | The link starts with `localhost`, so it only works on that computer. Move to a [home server](/docs/install/home-server) or a [cloud provider](/docs/install/cloud) first. |
| A home server in Tailscale mode | Access to the machine first, through Tailscale. [Share a home server with a friend](/docs/share-with-a-friend) walks you through both links. |
| A cloud provider or your own domain | Nothing extra. The link opens from anywhere. |

## Invite someone

1. Select your picture in the corner (the **Account menu**), then **Settings › Members**.
2. Under **Invite Someone**, type a name in **Who is this invite for?**. The invite page greets them with it. They choose the name they use in the app themselves.
3. Pick a [budget](#budgets-and-the-shared-budget). A new invite starts on **One-time**, with 50 tracks and 25 covers.
4. Press the button. What it does depends on whether you've set up [account email](/docs/email-and-storage).

| | Account email off (the default) | Account email on |
| --- | --- | --- |
| Extra field | None | **Their email** |
| Button | **Create invite link** | **Send invite** |
| How it reaches them | You press **Copy** in the **Invite link** box and send it yourself, in a private message | Liedmotif mails it, and you never see the link |
| Their sign-in address | Any address they type. Liedmotif sends them no mail | The address you entered. They can't change it |
| A mistake | Press **Revoke** and create a new one | Press **Revoke** on the mistyped address and send a new one |

Every invite follows the same rules:

- **It works once and lasts 7 days.** Opening it uses nothing, so a refresh is safe. Creating the account uses it.
- **Treat it like a password.** Whoever finishes the form first gets the account and the budget that comes with it.
- **A copied link is shown only once.** If you lose it, press **Revoke** under **Open invites** and create a new invite.
- **Open invites** lists everything nobody has used yet, with the date and time it expires in your instance's timezone, such as `Expires Nov 24, 2026, 11:00 Europe/Berlin`. A used, expired or revoked link says `This link is no longer valid.`

With account email on, Liedmotif refuses an address that already signs in or already has an open invite. If the mail can't be sent, the invite is cancelled and you can try again. While the invite is open, you can't move your own sign-in email to that address either: **Settings › Profile** says `That address has an open invite. Revoke the invite first.`

Someone already signed in to your instance in that browser sees `You are already signed in`. They need to open the link on their own device, or sign out first.

## What happens when they join

Your guest fills in **Your name**, **Email** and a password of 12 to 128 characters, with a number, an uppercase letter and a special character. Then they press **Create my account**. If they pick an address someone else already uses, the form says `That email is already in use. Pick another.` A mailed invite fixes the address, so if someone took it in the meantime the form says `Someone already signs in with this invite's address. Ask your admin for a new invite.` Revoke that invite and send a new one to an address that's free.

A shorter welcome follows. It skips everything to do with keys and limits, because those are yours:

| Screen | What it asks |
| --- | --- |
| **Welcome. What should we call you?** | Their first name. The rest is optional |
| **Put people on your Covers** | People with photos for their covers. Optional |
| **You're on the air!** | Nothing. It shows their budget, the shared budget and who pays, then offers **Start your first Session** |

They can check what's left at any time in **Settings › My budget**, which they can read but not change. [Help for members](/docs/member-help) is the page to send them: getting in, their budget and the usual problems.

## What a member gets

| A member gets | A member doesn't get |
| --- | --- |
| Their own sessions, tracks, playlists, Favorites, covers and People | Your provider keys. Their music runs on them, but they never see, test or manage them |
| Every listening feature, with your text AI and cover key if you've set them up | **AI Providers**, **Cost limits**, **Diagnostics & worker**, **Backups**, **Members**, or the instance's storage settings |
| Downloads of their own tracks, and their own **Your Stats** | A way to change their sign-in email. They can change their password |
| **Profile**, **People**, **Generation**, **Playback**, **Cover art**, **My budget**, and **Storage** for offline music on their device | Anyone else's private music |
| The lounge | |

Things a member can't use are left out of their screens, not greyed out, so they never face a button that goes nowhere.

## What you can see as the admin

You pay for the music, so you see the numbers. You don't see the music. Each member's card shows their name, budget, when they joined and when their sign-in was last active (or `No active sign-in` while they are signed out), dated in your instance's timezone, their track count, their storage and an estimated cost, and **Your Stats › Costs** compares members. Their tracks, requests, listening, People and unshared playlists stay out of your view. [Privacy and security](/docs/privacy-and-security#what-an-admin-can-and-cant-see) has the full list.

There's no admin override behind these screens. Ownership decides who controls a track, so you can't open, rename or remove a single track of a member's in the app. Your only way to remove their music is to delete their account.

> **This line is drawn in the app.** Whoever has shell access to the machine can reach its database, music files and backups, so your members are trusting you, or whoever runs the box. Member requests also go to your providers under your keys, and what a provider's own dashboard shows is up to that provider.

## Budgets and the shared budget

Every member has one budget, and all members together share a second one. A new track or cover has to fit both. Budgets count tracks and covers, and uploading your own cover doesn't count.

### The two kinds

| | **One-time** | **Rolling** |
| --- | --- | --- |
| What it is | One total, used at their own pace | Caps per day and per calendar month |
| When it renews | Never. Raise the number to top it up | Daily at midnight and monthly on the 1st, in your instance's timezone |
| Starting numbers | 50 tracks and 25 covers in total | 20 tracks a day and 100 a month, 10 covers a day and 25 a month |
| Good for | Someone trying it out | Someone who's staying |

Press **Edit budget** on a member's card to change it. A new budget applies at their next generation. Switching to **One-time** starts the count from that moment, so someone with a long history doesn't begin at zero, and the form keeps the other kind's numbers for a switch back.

Your provider makes tracks in pairs, so the track steppers land on even numbers and a one-time total rounds up to an even number. A monthly cap can't be lower than the daily one.

### The shared budget

This is the ceiling over all your members together, set under **Shared Budget** on the same page. It starts at 50 tracks a day and 250 a month, and 25 covers a day and 125 a month.

- **It always applies.** A member on a one-time budget is still held to its daily and monthly limits.
- **Your own listening stays outside it.** The most your instance can spend is your own caps plus this budget, and neither side can use up the other's. Your own caps are off on a new install, so see [costs and limits](/docs/costs-and-limits) if you want them.
- **Rolling budgets can add up to more than it.** You get a warning, not an error. One-time totals aren't part of that check, though their tracks still have to fit. Inside it, it's first come, first served.
- **Deleted members still count.** Their tracks stay in the total until that day or month is over, so deleting and re-inviting someone doesn't reset it.

Two limits aren't on this page. Each member makes one batch of new tracks at a time, with up to 6 tracks ready ahead, and all members together make two batches at a time. Anything more waits its turn.

### When a budget runs out

A session that's playing doesn't stop. It repeats the tracks it already has, at no cost. The member sees which budget ran out, their own or the shared one, and a used-up one-time budget names you as the person to ask. [Costs and limits](/docs/costs-and-limits#when-a-limit-is-reached) lists each message.

New tracks come back when the day or month rolls over. On a one-time budget, that only happens when you raise the total.

Starting a new session needs at least 5 tracks left in both budgets, or whatever you've set for your instance in **Cost limits**. Below that, members can still resume a session or play their library. A change of vibe is only refused when not one more batch fits. So a track budget set below that number, say 4 tracks a day, means the member can never start a new session. The budget forms and the shared budget warn you when a track figure is that low ("Below 5 Tracks, no new Session can start."), but still save it.

### What it costs you

The card shows each number with an estimated price: the count multiplied by today's price, by default $0.04 per track and, per cover, your image provider's price ($0.07 until you choose one). Change those under **Settings › AI Providers › Unit Costs**, or set both to 0 to hide every estimate. Only you see these. They're estimates, not a bill: you pay your providers directly, so their dashboards have the real figures.

Two costs sit outside every budget. Your text AI (the text LLM in `.env`) and the fetch that syncs lyrics to the music aren't counted. Questions to Roadie use the text AI too, and each member's daily allowance keeps that small. If you want the estimates to cover them, round your unit costs up a little.

Storage has no per-member limit either. Each track takes about 5 MB and stays until someone deletes it, so more members fill your disk faster. The card shows what each member uses.

## Who may ask Roadie

Roadie, the AI assistant, answers questions about your Liedmotif and runs on your text AI. Every member has it until you say otherwise, with 30 messages a day. You change both under **Settings › Members**.

- **For everyone:** the **Assistant** section sets the default. **Assistant for Members** switches Roadie on or off, and **Messages per day** is each member's daily allowance, from 1 to 1,000.
- **For one member:** their card has its own **Assistant** switch and **Messages per day**. Under each you see `Default` or `Set for this Member`, and **Use default** takes that value back to the default.

A change saves as soon as you make it: flip a switch, or type a number and press Enter or leave the field. Members on the default follow it at once when you change it. A member with a value of their own keeps it.

A member whose Assistant is off doesn't see the **Ask Roadie** button. One who has used up the day's messages is told when they can ask again. The allowance resets at midnight in your instance's timezone. As the admin you have no daily allowance. Without a text AI there is no Roadie, and the page says so in place of these controls.

## Password help

You never see or set a member's password. You hand them a one-shot link and they choose a new one.

| Situation | What to do | Link lasts |
| --- | --- | --- |
| Account email off | Press **Reset password** on their card, then copy the **Password reset link** and send it | 24 hours |
| Account email on, their address confirmed | Press **Reset password**, and Liedmotif mails them the link. They can also use **Forgot password?** on the sign-in page | 1 hour |
| Account email on, but the mail can't go out | **Reset password** gives you a link to copy, with the reason: their address isn't confirmed, their account is disabled, or the send failed | 24 hours |

- **The link is used when they set the password,** not when they open it. A new link cancels any older one.
- **Every device gets signed out** within a minute, and they sign in again with the new password.
- **Confirming an address:** with account email on, a member from an emailed invite starts confirmed. Anyone else presses **Send confirm link** in **Settings › Profile**, and that link lasts 24 hours.
- **Changing a password they know:** **Settings › Profile › Change password**. With account email off, it asks for the current and new password. With it on, it mails a reset link to a confirmed address, and asks them to confirm first if it isn't.

**Forgot password?** only appears with account email on. It gives the same answer for every address, so nobody can test who has an account, and it sends at most 3 mails an hour to one address.

## Disable or delete a member

| | **Disable account** | **Delete** |
| --- | --- | --- |
| What they see | `This account is disabled`, as soon as you press it | They have no account any more |
| New music | Stops | Stops |
| Their music | Kept | Removed for good from your instance: tracks, sessions, playlists, People and files |
| Their devices | Tracks they kept offline stay and keep playing | Tracks they kept offline stay and keep playing |
| Their lounge playlists | Stay shared | Leave the lounge, and the tracks other people saved from them go too |
| Way back | **Enable account** | None |

To delete, type their name and press **Delete forever**, or press **Keep the account** to back out. If a deleted member was the last person a playlist was shared with, that playlist returns to Private.

Neither one reaches into their phone or computer. Tracks they made and kept **Available offline** stay on that device and keep playing in its Offline Library, which needs no sign-in, and Liedmotif can't remove them from there. Copies of other people's lounge tracks are different: they stop playing 7 days after that device's last successful sync. To free the space, they clear the site's data for your Liedmotif in their browser.

Deleted music can live on in your [backups](/docs/backups) until they rotate out. In **Your Stats › Costs**, its cost moves to **Former members**.

## The lounge

The lounge is where people on your instance share playlists with each other, and it has its own place in the main navigation. Nothing in it leaves your instance, and there are no public links. Admins and members share the same way.

### Share a playlist

1. Open **Library**, then **Playlists**.
2. Select the **⋮** menu on a playlist's card, then **Share Playlist in the Lounge**.
3. Press **All**, or tick the people you want. **All** includes anyone who joins later. Ticking everyone by hand doesn't. To find someone fast, type part of their name or artist name in the search box above the list.
4. Press **Share**. The card now says **In the Lounge**.

If you're the only one on your instance, **Share** reaches everyone, including people you invite later.

To change your mind, open the same menu, now called **Edit Sharing**. Your own cards in the lounge have it too, in their **⋮** menu next to **Play** and **Pin in the Lounge**. Change the ticks and press **Save**, or press **None** and then **Return to Private**. If you're the only one on your instance, the button is simply **Return to Private**.

To stop sharing in one step, pick **Remove from Lounge** in the same **⋮** menu, on the playlist's card or on your own card in the lounge, and press **Remove**. The playlist is Private again.

A shared playlist is the real one, not a copy, so people hear it as you keep curating it. Adding a track makes it audible right away, and the **Add to Playlists** picker marks shared playlists with **In the Lounge** to remind you. Favorites works the same way: while it's shared, a track you star is heard right away. An empty playlist stays out of sight until it has tracks.

### What others can do

| They can | They can't |
| --- | --- |
| Play it and read the lyrics | Download a track or the playlist |
| Open **Track Data** for any track | Rename, reorder, edit or delete anything |
| Save tracks into their own playlists, Favorites included | Leave feedback on your tracks |
| Pin it, so it comes first in their own lounge | See it at all, if you didn't share it with them |
| Keep it **Available offline** on their device | Take a copy out of the app |
| Start **More Like This**, as a new session on their own budget | Use your People in that session |

A saved track is a pointer to yours, not a copy. It uses none of their storage, and it never stops you deleting the track. You can put tracks saved from someone else into a playlist you share. Only people who can already hear those tracks will see them there, so you can't widen anyone else's audience.

### What stays private

> **Sharing shows more than the music.** Anyone you share with can read each track's lyrics and **Track Data**, which includes your prompt, the style prompts and the session's name. If a request or a lyric holds something personal, leave that track out of the playlist.

Everything outside your shared playlists stays yours: your other playlists, your sessions, your history, your People and your stats.

Nobody gets told who's listening. You see no play counts, no names and no pins, and listening to someone else's playlist doesn't appear in anyone's stats.

The lounge shows your artist name if you've set one, otherwise your first name, with your picture. You can add a **Short description** of up to 80 characters in **Settings › Profile** for your profile card. It's only shown there, and never reaches the text AI.

### Find something in the lounge

Your pins come first, then whatever was shared most recently. The search box looks through playlist names, track titles, genres and sharers' names, but not lyrics. The cards above the list narrow it to one person, and **All** shows everyone again.

### Take it back

Returning a playlist to Private works straight away. Anyone listening hears the current track finish, and nothing plays after it. Dropping someone from the ticks does the same, for them only. Removing a track from your last shared playlist, or deleting it, does the same for that track.

- **Saved tracks and pins disappear.** A saved track stays only if another playlist of yours still shares it with that person. What's gone doesn't come back if you share again, so people have to save and pin it again.
- **Offline copies go too.** A device deletes them at its next sync. One that stays offline stops playing them 7 days after its last successful sync.

### The admin's one extra power

On someone else's playlist in your lounge, the **⋮** menu on its card or its page has **Return to Private**. It's the only thing an admin can change on another person's content, and it's for when something shouldn't be shared. The owner keeps the playlist and can share it again, but other people's pins and saved tracks don't come back.

You only have this for playlists in your own lounge. If someone shares with selected people and leaves you out, you won't see that playlist at all.

## If you forget the admin password

With account email on and your address confirmed, use **Forgot password?** on the sign-in page, which mails you a link that lasts 1 hour.

For anything else, such as email off, an unconfirmed address or a lost mailbox, you reset it on the machine itself. [Troubleshooting](/docs/troubleshooting#you-forgot-the-admin-password) has the commands.
