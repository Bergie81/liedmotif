---
title: Help for Members
description: You have an account on a Liedmotif that someone else runs. How to get in, what your budget means, what stays private, and what to do when something fails.
checkedOn: 2026-11-22
howTo: true
---

You're a member when someone runs a Liedmotif and has given you an account on it. That person is your admin: they run the machine, they pay the providers for the music, and they set your budget. You don't install Liedmotif and you never type a command.

This page covers getting in for the first time, your budget, what stays private, and the usual problems. Getting in takes about 10 minutes. If you get stuck, stop and message your admin. There's no rush: an invite link lasts 7 days from when your admin made it.

> **Let an AI assistant walk you through it.** If you'd like a patient helper, copy the message below into ChatGPT, Claude, Gemini or another AI assistant. It tells the assistant where to read this guide. If the assistant can't open the link, open [this page as plain text](/docs/member-help.md), copy it all and paste it in.

```text
Someone gave me an account on their Liedmotif, a self-hosted AI music app, and I want to get in. I may never have used Tailscale. First ask me whether I am on an iPhone, an Android phone or a computer. Then read this guide and walk me through it one step at a time:
https://www.liedmotif.com/docs/member-help.md

Follow the guide exactly and use plain words. After each step, ask me what I see and compare it with the "You should now see" check. If it does not match, help me fix it before we go on, using the "Common problems" section first. If the guide does not cover something, say so before you suggest anything of your own. If you cannot open the guide, tell me and I will paste it in.

Never tell me to click through a certificate warning. Never ask me for a link from my admin or a password, and remind me to leave them out of anything I paste
```

> **Keep your admin's links private.** Each one works once, for you. Never post them in a group chat, an AI chat or a screenshot.

## What You Need

- **A phone or a computer.** An iPhone, an Android phone or a computer all work.
- **The invite link** from your admin, which creates your account. If their Liedmotif sends email, it comes by mail instead of in a message.

Look at the address your invite link starts with:

| The address | What it means | Where to start |
| --- | --- | --- |
| Ends in `.ts.net` | This Liedmotif runs on a private box at your admin's home. It isn't on the open internet, and you reach it through Tailscale, a free app that connects your phone or computer to that one box | [Step 1](#1-install-tailscale-and-sign-in) |
| Anything else | It opens from anywhere | [Step 3](#3-create-your-liedmotif-account) |

For an address ending in `.ts.net`, you need two more things:

- **The share link** from Tailscale, which lets you reach the box. Your admin sends it with the invite. It lasts 30 days.
- **An account to sign in to Tailscale with,** such as Google, Apple, Microsoft or GitHub. Use a personal account, not a work one.

In every example, `https://liedmotif.tail1234.ts.net` stands for the address of the Liedmotif you're joining. Your invite link starts with the real one.

### Is This Safe for Me?

It's a fair question, so here's exactly what happens:

- **Your music in Liedmotif is private.** The app shows your admin how much you made and when you were last active, but never what you made. The only music other people can hear is a playlist you choose to share. Your admin does run the machine, so they could reach its files from outside the app. Only join someone you trust.
- **Tailscale only carries the traffic to your admin's box.** Everything else you do online goes the normal way, as before.
- **Your admin's box can't connect to your phone or your other devices.**
- **Your admin sees the email address and picture** of the Tailscale account you accept the share with.

## 1. Install Tailscale and Sign In

This step and the next are only for an address ending in `.ts.net`. With any other address, go to [step 3](#3-create-your-liedmotif-account).

On the phone or computer you want to listen on:

| Device | What to do |
| --- | --- |
| iPhone or iPad | Install **Tailscale** from the App Store. Open it, tap **Get Started**, and allow the prompts to add a VPN configuration. Then tap **Log in** and sign in with your account. |
| Android | Install **Tailscale** from Google Play. Open it, tap **Get Started**, and allow the prompts to add a VPN configuration. Then tap **Sign in with Google**, or **Sign in with other** for another account. |
| Computer | Download Tailscale from [tailscale.com/download](https://tailscale.com/download), install it and sign in. |

Don't worry about the VPN prompt. VPN is simply what phones call an app like this, and it's how Tailscale connects you to your admin's box.

The first sign-in creates your own free Tailscale network, which is just your devices. If Tailscale asks a few welcome questions, any answer is fine.

**You should now see** Tailscale switched on, with your own device in its list of devices.

## 2. Accept the Share

1. Open the share link from your admin. Any browser works, and using the same device is easiest.
2. Sign in with **the same account** you used in step 1.
3. The page shows who is sharing which machine with you. Press **Accept invite**.

**You should now see** your admin's machine in the Tailscale app's list of devices, next to your own. Its name is the first part of the Liedmotif address: `liedmotif` in `liedmotif.tail1234.ts.net`.

## 3. Create Your Liedmotif Account

1. If the address ends in `.ts.net`, check that Tailscale is switched on.
2. Open the invite link from your admin. It looks like `https://liedmotif.tail1234.ts.net/join/…`.
3. The page says **Welcome,** and your name. Fill in:
   - **Your name:** how the player greets you;
   - **Email:** what you sign in with. It can be any address you use. Liedmotif only sends you email if your admin has turned that on;
   - **Password:** at least 12 characters, with a number, an uppercase letter and a special character. The list under the field ticks off each one;
   - **Confirm password:** the same password again.
4. Press **Create My Account**. Save the email and password in your password manager, or somewhere else safe.
5. A short first-time setup follows:
   - **Welcome. What Should We Call You?** Fill in your **First name**. The rest is optional, including a **Short description** (up to 80 characters) for your profile card in the Lounge. Press **Continue**.
   - **Put People on Your Covers** is optional, so you can skip it for now. Press **Continue**.
   - **You're on the Air!** shows the budget your admin gave you, which is how much new music you can make. Press **Start Your First Session**.

If the **Email** field is already filled in and greyed out, your admin sent the invite by email, and that address is your sign-in.

**You should now see** Liedmotif's home screen, with no certificate warning: the browser shows the normal padlock (or nothing at all) next to the address. Describe what the music is for and start a session. The first track can take a few minutes, and the player tells you what's happening.

## 4. Add Liedmotif to Your Home Screen

This makes Liedmotif one tap away, like any other app. With Liedmotif open:

| Device | What to do |
| --- | --- |
| iPhone or iPad (Safari) | Tap **⋯** (More), then **Share**. If you see the Share button (a square with an arrow) right away, tap that instead. Scroll down the list, tap **Add to Home Screen**, keep **Open as Web App** on if it's shown, and tap **Add**. |
| Android (Chrome) | Tap **⋮** (More) to the right of the address bar, then **Install and create shortcut**, then **Install**. Older Chrome versions call it **Add to Home screen**. |
| Computer | Bookmark the page. |

**You should now see** a Liedmotif icon on your home screen. Tapping it opens Liedmotif like an app. If it asks you to sign in (**Welcome Back**), use your email and password and press **Sign In**.

That's it. You're in.

## Every Time You Listen

1. If the address ends in `.ts.net`, make sure Tailscale is switched on. You can leave it on all the time.
2. Tap the Liedmotif icon.

A box at your admin's home has to be on as well. If it's off, Liedmotif won't load until they switch it back on.

## Your Budget

Your admin pays the providers for every new track and cover you make, so your account comes with a budget. **Settings › My Budget** shows what's left. You can read it, and only your admin can change it.

| | **One-Time** | **Rolling** |
| --- | --- | --- |
| What it is | One total, used at your own pace | Caps per day and per calendar month |
| When it renews | Never. Your admin raises the number to top it up | Daily at midnight and monthly on the 1st, in the instance's timezone |

All members together also share a second budget, and a new track or cover has to fit both. So new music can pause even when your own budget has room.

**A new session makes about 30 minutes of new music, then repeats for free,** unless you choose another length. That keeps a session you forgot playing from using up your budget. You pick your own default under **New music per Session** in **Settings › Generation**: **5 min**, **15 min**, **30 min**, **1 h**, **2 h** or **No limit**. On **Home**, the **Session duration** slider's **Auto** shows it, such as "Auto · 30 min", and a card from Roadie for a new session has the same slider, so you set the length there before you press **Start Session**. To make one session longer once it has reached its length, tap the player's **New Music** status, choose **Up to a Duration** with a longer length or **No Limit**, and press **Save**. [Session duration](/docs/features#session-duration) has the details.

**When a budget runs out,** a session that's playing doesn't stop. It repeats the tracks it already has, and the player tells you which budget ran out. Everything you already made keeps playing: your library, your playlists and anything you kept offline. New tracks come back when the day or month rolls over, or, on a one-time budget, when your admin raises the total.

Starting a new session needs a few tracks left in both budgets: 5, unless your admin set another number. Below that, you see **Not Enough Tracks Left to Start**, with what a new session needs, what is left and when more come back. If your budget is smaller than what a session needs, waiting won't help, and the message tells you to ask your admin. You can still resume a session or play your library. [Costs and limits](/docs/costs-and-limits#when-a-limit-is-reached) lists each message you might see.

## What's Yours Here

- **Your own music.** Sessions, tracks, playlists, Favorites, covers and People are yours, and you can download your own tracks. [Features](/docs/features) covers everything the app can do.
- **The Lounge.** It's where people on this Liedmotif share playlists with each other. You choose what you share and with whom. [The Lounge](/docs/members#the-lounge) explains it.
- **Not the admin's side.** Provider keys, cost limits, backups and other members belong to your admin, so those screens are left out of your app. You can change your password, but not your sign-in email.

## Common Problems

None of these mean you did anything wrong. Most take a moment to fix.

### Liedmotif Does Not Load

The browser says the site can't be reached, can't find the server, or keeps loading. With an address that doesn't end in `.ts.net`, check your own internet connection, then ask your admin whether their Liedmotif is running. With a `.ts.net` address, check these in order:

1. **Tailscale is switched off.** Open the Tailscale app and switch it on.
2. **Another VPN is on.** A phone runs one VPN at a time. Turn the other VPN off, then switch Tailscale on again.
3. **Tailscale is signed in with another account.** The app has to use the account that accepted the share in step 2. Check the account in the Tailscale app and switch to the right one. If you accepted the share with a different account, ask your admin for a new share link and accept it with the account the app uses.
4. **The share isn't accepted yet.** Your admin's machine is missing from your Tailscale device list. Open the share link again and accept it. If the link has expired or was used, ask your admin for a new one.
5. **The machine is in your list, but the address still doesn't open.** If your Tailscale account is older than October 2022, a setting called MagicDNS may be off in it. Open the **DNS** page of your Tailscale admin console, [console.tailscale.com/admin/dns](https://console.tailscale.com/admin/dns), and press **Enable MagicDNS**.
6. **None of these.** Your admin's box may be off, or they took the share back. Ask them.

### You Can't Accept the Share

Only the person who manages a Tailscale network can accept a share. If you signed in with a work account and your employer uses Tailscale, you joined their network instead of making your own. Sign out of Tailscale, sign in again with a personal account, and open the share link again.

### The Invite Link

| What it says | What to do |
| --- | --- |
| `This link is no longer valid.` | The invite was already used, is older than 7 days, or was taken back. Ask your admin for a new invite link. |
| `You are already signed in` | This browser is already signed in to Liedmotif. Open the invite on your own device, or sign out first. |
| `Open your invite link again` | Open the original link from your admin again. It still works. |
| `Too many attempts. Wait a few minutes, then try again.` | Do exactly that. |
| `That email is already in use. Pick another.` | Someone on this Liedmotif already signs in with that address. Use a different one. |
| `Someone already signs in with this invite's address. Ask your admin for a new invite.` | Your invite came by email for an address someone else now signs in with. You can't change it on this form, so ask your admin for a new invite. |

### Anything Else

- **A certificate warning,** such as "Your connection is not private". You opened an address like `100.x.y.z` instead of the name ending in `.ts.net`. Never continue past the warning. Open the invite link or your Liedmotif icon instead.
- **`This account is disabled`.** Your admin turned your account off. Your music is kept, so ask them to turn it back on. Music you kept offline on this device stays and keeps playing in the Offline Library; to free that space, clear this site's data in your browser.
- **You forgot your password.** Ask your admin: they can make you a password reset link. If **Forgot Password?** appears on the sign-in page, try that first. It mails you a link if your email is confirmed.
- **Your music stops changing and starts to repeat.** If the player says "New Music Finished · 30 min", or "Done · 30 min" on a phone, the session reached its length: tap it to make it longer. Otherwise a budget has probably run out. See [your budget](#your-budget).

## Sources

We checked these on 3 November 2026:

- [Tailscale: Install on iOS](https://tailscale.com/docs/install/ios) and [Install on Android](https://tailscale.com/docs/install/android)
- [Tailscale: Share your machines with other users](https://tailscale.com/docs/features/sharing): accepting a share, quarantine, and reaching a shared machine by its `.ts.net` name
- [Tailscale: MagicDNS](https://tailscale.com/docs/features/magicdns): on by default since 20 October 2022
- [Tailscale: Exit nodes](https://tailscale.com/docs/features/exit-nodes): Tailscale leaves your normal internet traffic alone
- [Apple: Turn a website into an app in Safari on iPhone](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- [Google: Use web apps in Chrome on Android](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid)

Your admin's side of this is in [Members, invites and the Lounge](/docs/members) and, for a box at home, [Share a home server with a friend](/docs/share-with-a-friend).
