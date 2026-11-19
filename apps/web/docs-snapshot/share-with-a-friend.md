---
title: Share a home server with a friend
description: Let a friend anywhere in the world listen on your Liedmotif at home, with two private links and nothing opened to the internet.
checkedOn: 2026-11-19
howTo: true
---

A friend anywhere in the world can listen on your Liedmotif, while your home stays private. Nothing at home opens to the internet, and you change nothing on your router. You send your friend two links, and it takes about 10 minutes.

This guide is for a box at home in Tailscale mode, which is the installer's default: your Liedmotif address ends in `.ts.net`. If yours runs on a cloud provider or your own domain, you don't need any of this. Just [invite them](/docs/members).

> **Let an AI assistant walk you through it.** Copy the message below into ChatGPT, Claude, Gemini or another AI assistant. It tells the assistant where to read this guide. If the assistant can't open the link, open [this page as plain text](/docs/share-with-a-friend.md), copy it all and paste it in.

```text
I run Liedmotif, a self-hosted AI music app, at home in Tailscale mode, and I want to let a friend in. Read this guide and walk me through it one step at a time:
https://www.liedmotif.com/docs/share-with-a-friend.md

Follow the guide exactly and use plain words. After each step, ask me what I see and compare it with the "You should now see" check. If it does not match, help me fix it before we go on, using the "Common problems" section first. If the guide does not cover something, say so before you suggest anything of your own. If you cannot open the guide, tell me and I will paste it in.

Never suggest inviting my friend into my tailnet, and never suggest making my home box reachable from the internet (no Tailscale Funnel, no port forwarding, no router changes). Never ask me for the share link, the invite link or a password, and remind me to leave them out of anything I paste
```

> **Treat both links like passwords.** Whoever accepts the share link can reach your Liedmotif box, and whoever creates an account with the invite link first gets it. Send them only to your friend, in a private message. Never put them in a group chat, an AI chat or a screenshot.

## What you need

- **Liedmotif from the one-line installer, without `--domain`.** At the end it printed `Liedmotif … is running at https://….ts.net`.
- **The admin account.** That's the one you created with the setup link.
- **Control of your Tailscale network.** You have it if you created the network.
- **A friend with a phone or a computer.** They need a free Tailscale account, and [Help for members](/docs/member-help) covers it.

Three words come up on this page:

| Word | What it means |
| --- | --- |
| Tailnet | Your private Tailscale network: every device signed in to your Tailscale account |
| Share link | A Tailscale link that lets one friend reach one machine |
| Invite link | A Liedmotif link that lets one friend create their Liedmotif account |

In every example, `https://liedmotif.tail1234.ts.net` stands for your Liedmotif address. The first part, `liedmotif`, is your box's machine name in Tailscale. Replace both with your own.

## The one rule: share the machine, never invite your friend into the tailnet

Tailscale has two ways to let someone in, and they look alike:

| | Where | What your friend gets |
| --- | --- | --- |
| **Sharing a machine** | The **Machines** page, then **Share** | This one machine and nothing else. Use this one |
| **Inviting a user** | The **Users** page | By default, every device in your tailnet: your laptop, your phone, your NAS. Never do this for a friend |

Sharing is free on every Tailscale plan, and a friend you share with doesn't count as a user of your tailnet.

> **Your friend can reach all of this machine, not only Liedmotif.** Tailscale's default policy opens every port on a shared machine to them. Liedmotif only publishes its web ports there, but SSH can be reached if it's on, and so can anything else you run on the box, such as a file share or a dashboard. SSH still asks for your password or key, so give the box a strong password or an SSH key, and put a password on anything else running there. Tailscale can limit shared friends to the web ports with an [access rule](https://tailscale.com/docs/features/sharing#sharing-and-access-control-policies). We haven't tested a rule for Liedmotif yet, so we don't give you one here.

## 1. Share the Liedmotif machine in Tailscale

1. On a computer, open the **Machines** page of the Tailscale admin console, [console.tailscale.com/admin/machines](https://console.tailscale.com/admin/machines), and sign in with your Tailscale account.
2. Find the row of your Liedmotif box. Its name is the first part of your Liedmotif address: `liedmotif` in `liedmotif.tail1234.ts.net`.
3. Select the **⋯** menu at the end of that row, then select **Share**.
4. In the **Share** dialog, select the **Copy invite link** tab.
5. Leave **Reusable link** off. One link per friend lets you see each friend's access, and take it back, on its own.
6. Select **Copy share link**, and paste the link into a private note for now.

**You should now see** the share link in your note. It works once, and it expires after 30 days if your friend hasn't accepted it by then.

## 2. Create the Liedmotif invite

1. Open Liedmotif. Select your picture in the corner (the **Account menu**), then **Settings › Members**.
2. Under **Invite someone**, type your friend's name in **Who is this invite for?**. Liedmotif greets them with it.
3. Pick a budget. **One-time** is one total that never renews. **Rolling** is caps that reset daily and at the start of each month. Adjust the numbers. Every track your friend makes is paid from your music provider account. [Budgets and the shared budget](/docs/members) has the details.
4. Press **Create invite link**. An **Invite link** box appears. Press **Copy**, and paste the link into your note under the share link. It's shown once, works once and expires after 7 days.

If you've set up [account email](/docs/email-and-storage), this form also asks for **Their email**, and the button says **Send invite**. Liedmotif mails the invite to your friend itself, and you have no invite link to copy.

**You should now see** your friend's name under **Open invites**, with **Expires** and a date. The invite link starts with your Liedmotif address: `https://liedmotif.tail1234.ts.net/join/…`.

## 3. Send both links to your friend

Send your friend one private message with both links and the guide for members. Copy this, paste your two links in, and send it. If Liedmotif mailed the invite, replace the third line with a note to look for the mail.

```text
I'd like you to listen on my Liedmotif. It runs on a box at my home and stays private, so you get in with Tailscale (a free app).

1. Follow this guide: https://www.liedmotif.com/docs/member-help
2. Tailscale share link: <paste the share link>
3. Liedmotif invite link: <paste the invite link>

The invite link works for 7 days.
```

**You should now see,** once your friend has followed the guide:

- in Tailscale, on the **Machines** page, an indicator on your Liedmotif box that it's shared with someone outside your tailnet;
- in Liedmotif, under **Settings › Members**, a card with the name your friend chose, and their invite gone from **Open invites**.

## 4. See who has access

- **In Tailscale:** **Machines**, then the **⋯** menu on your Liedmotif box, then **Share**. The dialog lists everyone who accepted a share, with their picture and email address.
- **In Liedmotif:** **Settings › Members**. Every friend who joined has a card that shows when they joined, when they were last active and how many tracks they made. **Open invites** lists the invites nobody has used yet.

## 5. Take access away

Do both of these. The share is the door to your box, and the Liedmotif account is the key to the app.

1. **In Tailscale:** **Machines**, then the **⋯** menu on your Liedmotif box, then **Share**. Next to your friend, select the **⋯** menu, then **Revoke invite**. From now on they can't reach your box at all. To let them back in later, send a new share link.
2. **In Liedmotif:** **Settings › Members**, then **Disable account** on your friend's card. The card now shows **Disabled**: they can't sign in or make music, and everything they made is kept. **Enable account** undoes it. **Delete** removes the account and their music for good: type their name and press **Delete forever**. Either way, music they kept offline on their phone stays there and keeps playing. Only clearing the site's data in their browser frees that space.

To take back links nobody has used yet, press **Revoke** next to the invite under **Open invites** in Liedmotif, and **Revoke invite** in the Tailscale **Share** dialog.

**You should now see** your friend gone from the Tailscale **Share** dialog, and **Disabled** on their card in Liedmotif.

## Good to know

- **Your box must be on.** Your friend listens straight from your box, so it has to be switched on and online.
- **Your friend gets this machine only.** Not your other devices, and not your home network.
- **Your box can't reach your friend's devices.** Tailscale keeps a shared machine in quarantine: it answers your friend, but it can never start a connection into their tailnet.
- **There's no limit you'll hit.** Tailscale states no cap on how many people you can share a machine with. Make one share link and one invite per friend.

## Common problems

- **Your friend's browser says the site can't be reached.** First check your box: on the **Machines** page it has to show as connected, not "last seen" a while ago. If it does, send your friend to [common problems in Help for members](/docs/member-help#common-problems).
- **There's no Share option.** Only an Owner, Admin or IT admin of the tailnet can share. If someone else set up your tailnet, ask them to share the box.
- **Your friend accepted the share, everything else is right, and it still doesn't load.** If you ever edited your tailnet's access controls, your policy has to let shared users reach the box. Tailscale's default policy does. See [Sharing and access control policies](https://tailscale.com/docs/features/sharing#sharing-and-access-control-policies).
- **The share link expired, or your friend accepted it with the wrong account.** Revoke it in the **Share** dialog and send a new one.
- **You lost the invite link.** It's shown only once. Press **Revoke** next to it under **Open invites** and create a new invite.
- **The invite says `This link is no longer valid.`** It was already used, expired after 7 days, or was revoked. Create a new invite.
- **Your friend sees a certificate warning.** They opened an address like `100.x.y.z` instead of your Liedmotif name. Send them the link that ends in `.ts.net`, which never shows a warning.

## Checked in Tailscale's docs

We checked these against Tailscale's documentation on 3 November 2026:

- **Your friend's device finds your box by its `.ts.net` name and trusts its certificate.** A shared machine is reached by its full name, `<machine>.<tailnet>.ts.net`, through MagicDNS ([Sharing and MagicDNS](https://tailscale.com/docs/features/sharing#sharing-and-magicdns)). MagicDNS is on by default in every tailnet created since 20 October 2022, so in your friend's new one too ([MagicDNS](https://tailscale.com/docs/features/magicdns)). The certificate comes from Let's Encrypt, a public certificate authority every browser trusts ([Enabling HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates)).
- **Friends reach the address Liedmotif listens on.** The installer lets Liedmotif answer on your box's Tailscale IPv4 address only. A shared machine keeps that address in your friend's tailnet, unless it's already taken there ([Share a machine](https://tailscale.com/docs/features/sharing#share-a-machine-with-another-user)). Then your friend gets another one, which Tailscale on your box translates back before the traffic arrives ([Tailscale source, `mapDstIP`](https://github.com/tailscale/tailscale/blob/main/net/tstun/wrap.go)).
- **A shared box can't reach into your friend's tailnet.** Shared machines are quarantined: they "can receive incoming connections … but cannot start connections" ([Quarantine](https://tailscale.com/docs/features/sharing#quarantine)).
- **Shared friends don't count against your plan.** Sharing a device "doesn't increase the user count of your tailnet" ([Inviting users vs sharing a device](https://tailscale.com/docs/reference/inviting-vs-sharing)). The free Personal plan allows 6 users ([Free plans](https://tailscale.com/docs/account/manage-plans/free-plans-discounts), [Pricing](https://tailscale.com/pricing)), and sharing works on every plan.
- **How many people a machine can be shared with.** The docs state no cap. A reusable share link can be accepted up to 1,000 times, and any unused share link expires after 30 days ([Share using a link](https://tailscale.com/docs/features/sharing#share-using-a-link)).

The admin console steps come from [Share your machines with other users](https://tailscale.com/docs/features/sharing) and [Share a private game server with friends](https://tailscale.com/docs/use-cases/personal-or-at-home-use/share-private-game-server). For what the installer sets up in Tailscale mode, see [install on a home server](/docs/install/home-server).
