---
title: Join a friend's Liedmotif
description: A friend invited you to their Liedmotif. Here's how to get in, step by step, with no technical know-how and nothing to pay.
checkedOn: 2026-11-07
howTo: true
---

A friend runs Liedmotif, an AI music app, on a small computer at their home, and they've invited you. You describe what the music is for, and it makes the music and keeps playing. Your friend pays for it, so you pay nothing.

Their computer is private, which means it isn't on the open internet. You reach it through Tailscale, a free app that connects your phone or computer to that one box. You don't need to know anything about servers, and you won't need to type any commands.

It takes about 10 minutes, in four steps: install an app, accept a link, create your account, and put an icon on your home screen. If you get stuck, stop and message your friend. There's no rush: an invite link lasts 7 days from when your friend made it, and a share link lasts 30.

> **Let an AI assistant walk you through it.** If you'd like a patient helper, copy this whole page into ChatGPT, Claude, Gemini or another AI assistant, then send it the message below.

```text
A friend invited me to their Liedmotif and I want to join by following this guide. I may never have used Tailscale. Walk me through it one step at a time. After each step, ask me what I see and compare it with the "You should now see" check. If it does not match, help me fix it before we go on, using the "Common problems" section first. Never tell me to click through a certificate warning, and never ask me to paste a link from my friend or a password into this chat.
```

> **Keep your friend's links private.** Each one works once, for you. Never post them in a group chat, an AI chat or a screenshot.

## What you need

- **A phone or a computer.** An iPhone, an Android phone or a computer all work.
- **An account to sign in to Tailscale with,** such as Google, Apple, Microsoft or GitHub. Use a personal account, not a work one.
- **Two links from your friend:**
  - the **share link** from Tailscale, which lets you reach their box;
  - the **invite link** from Liedmotif, which creates your account. If your friend's Liedmotif sends email, this one comes by mail instead of in their message.

In every example, `https://liedmotif.tail1234.ts.net` stands for your friend's Liedmotif address. Your invite link starts with their real one.

### Is this safe for me?

It's a fair question, so here's exactly what happens:

- **Tailscale only carries the traffic to your friend's box.** Everything else you do online goes the normal way, as before.
- **Your friend's box can't connect to your phone or your other devices.**
- **Your friend sees the email address and picture** of the Tailscale account you accept the share with.
- **Your music in Liedmotif is private.** The app shows your friend how much you made and when you were last active, but never what you made. The only music other people can hear is a playlist you choose to share. Your friend does run the machine, so they could reach its files from outside the app. Only join someone you trust.

## 1. Install Tailscale and sign in

On the phone or computer you want to listen on:

| Device | What to do |
| --- | --- |
| iPhone or iPad | Install **Tailscale** from the App Store. Open it, tap **Get Started**, and allow the prompts to add a VPN configuration. Then tap **Log in** and sign in with your account. |
| Android | Install **Tailscale** from Google Play. Open it, tap **Get Started**, and allow the prompts to add a VPN configuration. Then tap **Sign in with Google**, or **Sign in with other** for another account. |
| Computer | Download Tailscale from [tailscale.com/download](https://tailscale.com/download), install it and sign in. |

Don't worry about the VPN prompt. VPN is simply what phones call an app like this, and it's how Tailscale connects you to your friend's box.

The first sign-in creates your own free Tailscale network, which is just your devices. If Tailscale asks a few welcome questions, any answer is fine.

**You should now see** Tailscale switched on, with your own device in its list of devices.

## 2. Accept the share

1. Open the share link from your friend. Any browser works, and using the same device is easiest.
2. Sign in with **the same account** you used in step 1.
3. The page shows who is sharing which machine with you. Press **Accept invite**.

**You should now see** your friend's machine in the Tailscale app's list of devices, next to your own. Its name is the first part of their Liedmotif address: `liedmotif` in `liedmotif.tail1234.ts.net`.

## 3. Create your Liedmotif account

1. Check that Tailscale is switched on.
2. Open the invite link from your friend. It looks like `https://liedmotif.tail1234.ts.net/join/…`.
3. The page says **Welcome,** and your name. Fill in:
   - **Your name:** how the player greets you;
   - **Email:** what you sign in with. It can be any address you use. Liedmotif only sends you email if your friend has turned that on;
   - **Password:** at least 12 characters, with a number, an uppercase letter and a special character. The list under the field ticks off each one;
   - **Confirm password:** the same password again.
4. Press **Create my account**. Save the email and password in your password manager, or somewhere else safe.
5. A short first-time setup follows:
   - **Welcome. What should we call you?** Fill in your **First name**. The rest is optional. Press **Continue**.
   - **Put people on your Covers** is optional, so you can skip it for now. Press **Continue**.
   - **You're on the air!** shows the budget your friend gave you, which is how much new music you can make. Press **Start your first Session**.

If the **Email** field is already filled in and greyed out, your friend sent the invite by email, and that address is your sign-in.

**You should now see** Liedmotif's home screen, with no certificate warning: the browser shows the normal padlock (or nothing at all) next to the address. Describe what the music is for and start a session. The first track can take a few minutes, and the player tells you what's happening.

## 4. Add Liedmotif to your home screen

This makes Liedmotif one tap away, like any other app. With Liedmotif open:

| Device | What to do |
| --- | --- |
| iPhone or iPad (Safari) | Tap **⋯** (More), then **Share**. If you see the Share button (a square with an arrow) right away, tap that instead. Scroll down the list, tap **Add to Home Screen**, keep **Open as Web App** on if it's shown, and tap **Add**. |
| Android (Chrome) | Tap **⋮** (More) to the right of the address bar, then **Install and create shortcut**, then **Install**. Older Chrome versions call it **Add to Home screen**. |
| Computer | Bookmark the page. |

**You should now see** a Liedmotif icon on your home screen. Tapping it opens Liedmotif like an app. If it asks you to sign in (**Welcome back**), use your email and password and press **Sign in**.

That's it. You're in.

## Every time you listen

1. Make sure Tailscale is switched on. You can leave it on all the time.
2. Tap the Liedmotif icon.

Your friend's box has to be on as well. If it's off, Liedmotif won't load until they switch it back on.

## Common problems

None of these mean you did anything wrong. Most take a moment to fix.

### Liedmotif does not load

The browser says the site can't be reached, can't find the server, or keeps loading. Check these in order:

1. **Tailscale is switched off.** Open the Tailscale app and switch it on.
2. **Another VPN is on.** A phone runs one VPN at a time. Turn the other VPN off, then switch Tailscale on again.
3. **Tailscale is signed in with another account.** The app has to use the account that accepted the share in step 2. Check the account in the Tailscale app and switch to the right one. If you accepted the share with a different account, ask your friend for a new share link and accept it with the account the app uses.
4. **The share isn't accepted yet.** Your friend's machine is missing from your Tailscale device list. Open the share link again and accept it. If the link has expired or was used, ask your friend for a new one.
5. **The machine is in your list, but the address still doesn't open.** If your Tailscale account is older than October 2022, a setting called MagicDNS may be off in it. Open the **DNS** page of your Tailscale admin console, [console.tailscale.com/admin/dns](https://console.tailscale.com/admin/dns), and press **Enable MagicDNS**.
6. **None of these.** Your friend's box may be off, or they took the share back. Ask them.

### You can't accept the share

Only the person who manages a Tailscale network can accept a share. If you signed in with a work account and your employer uses Tailscale, you joined their network instead of making your own. Sign out of Tailscale, sign in again with a personal account, and open the share link again.

### The invite link

| What it says | What to do |
| --- | --- |
| `This link is no longer valid.` | The invite was already used, is older than 7 days, or was taken back. Ask your friend for a new invite link. |
| `You are already signed in` | This browser is already signed in to Liedmotif. Open the invite on your own device, or sign out first. |
| `Open your invite link again` | Open the original link from your friend again. It still works. |
| `Too many attempts. Wait a few minutes, then try again.` | Do exactly that. |
| `That email is already in use. Pick another.` | Someone on this Liedmotif already signs in with that address. Use a different one. |

### Anything else

- **A certificate warning,** such as "Your connection is not private". You opened an address like `100.x.y.z` instead of the name ending in `.ts.net`. Never continue past the warning. Open the invite link or your Liedmotif icon instead.
- **`This account is disabled`.** Your friend turned your account off. Your music is kept, so ask them to turn it back on.
- **You forgot your password.** Ask your friend: they can make you a password reset link. If **Forgot password?** appears on the sign-in page, try that first. It mails you a link if your email is confirmed.
- **Your music stops changing and starts to repeat.** Your budget has probably run out. The session keeps playing what it already made. **Settings › My budget** shows what's left, and your friend can give you more.

## Sources

We checked these on 3 November 2026:

- [Tailscale: Install on iOS](https://tailscale.com/docs/install/ios) and [Install on Android](https://tailscale.com/docs/install/android)
- [Tailscale: Share your machines with other users](https://tailscale.com/docs/features/sharing): accepting a share, quarantine, and reaching a shared machine by its `.ts.net` name
- [Tailscale: MagicDNS](https://tailscale.com/docs/features/magicdns): on by default since 20 October 2022
- [Tailscale: Exit nodes](https://tailscale.com/docs/features/exit-nodes): Tailscale leaves your normal internet traffic alone
- [Apple: Turn a website into an app in Safari on iPhone](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- [Google: Use web apps in Chrome on Android](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid)

The person running the box has [their own guide](/docs/share-with-a-friend).
