---
title: Providers and keys
description: Which AI services Liedmotif uses, how to get a key for each, where to enter it, and what changes with and without the optional ones.
checkedOn: 2026-11-18
---

Liedmotif doesn't make music itself. It sends your requests to AI services you choose, on your own accounts, and you pay them directly. There's one you need and two you can add later, and you can change any of them at any time. Only the admin can see or change provider keys. Members create music on the admin's keys, within [the budgets the admin sets](/docs/costs-and-limits).

| Service | Required | What it does | Who provides it today |
| --- | --- | --- | --- |
| Music provider | Yes | Makes every track | One Suno-compatible provider, [sunoapi.org](https://sunoapi.org) by default |
| Text AI | No | Turns your words into a musical direction, and writes names and lyric ideas | OpenAI, OpenRouter, any OpenAI-compatible service, or Ollama |
| Cover images | No | Paints covers in your style, with your people on them | OpenRouter |

## Music provider

Nothing plays without one, so it's the only key guided setup insists on.

### Get a key

1. Create an account at [sunoapi.org](https://sunoapi.org).
2. Buy credits. Generation is prepaid, and $5 is plenty to start.
3. Open **Dashboard › API Keys** and create a key.
4. Paste it into Liedmotif, test it, then save it. In guided setup that's **Test the key**, then **Save and continue**. In **Settings › AI Providers** it's **Test**, then **Save**.

sunoapi.org is an independent service, not run by Suno. Expect to pay about 4 cents per track. Liedmotif has no choice of music provider yet. To use another service that speaks the same API, open **Use a different endpoint** in guided setup, or fill in **Base URL** in Settings. The default is `https://api.sunoapi.org`.

### When credits run out

The session doesn't stop. The player shows **Generation paused**, with the message "The music provider is out of credits", and keeps playing the tracks it already has. A session that has no tracks yet says so instead.

Top up your account with the provider. Liedmotif checks again by itself every 15 minutes, so new tracks return without you doing anything else in the app.

A successful **Test** proves the key works, not that it has credit left. Check your balance on the provider's dashboard.

If the provider is busy instead, the player shows **Generation backing off** and tries again by itself within a few minutes.

## Text AI

The text AI is a text service that works on your words. The app calls it the Text AI, while the comments in `.env` say "text LLM".

| | With a text AI | Without one |
| --- | --- | --- |
| Your request | Becomes a stable, detailed musical direction | Reaches the music provider exactly as you wrote it, with your genre, energy, vocals and language picks applied |
| Names | Creative session names and track titles, topped up before a long session runs out | A session name built from your request, and numbered track titles built from your first genre or your request's first words |
| Lyrics | A fresh angle for each new vocal pair when the session has lyric notes, your own About text in every vocal session, and the About text of people you name | No About text and no fresh angles |
| You in a request | Understood from what you mean, such as "With Jonas and Clara on the way back to Berlin": you're in the lyrics and on the cover with them. See [You in your own songs](/docs/features#you-in-your-own-songs) | Only saved names count |
| Session length | Can come from your request's words, like "40 minutes" | Comes only from the slider |
| Cost | A little text usage with your provider, or nothing with Ollama | Nothing extra |

Music works well either way, and you can add a text AI later. It runs once when a session starts and again for a written change of vibe, not for every track. The exceptions are small: Surprise Me, naming a **More Like This** session, a lyric idea for each new vocal pair with lyric notes, new titles when a long session runs out of them, and cover guidance and custom cover styles while **Enhance prompts** is on.

### If it fails

When a text AI is connected, it's always used for your written requests. Liedmotif doesn't quietly fall back to your raw words, because you'd get different music without knowing why. If it fails on a session request or a change of vibe, you see an error, no session is created or changed, no music is bought, and you can simply try again:

- **"The Text AI took too long to respond. Try again, or use a faster model."** The model was slow. Liedmotif waits 30 seconds by default.
- **"Could not turn that description into a music style. Check the Text AI configuration."** Check the key, the model and your credit with that provider.

The small jobs are the exception. If naming fails, the session still starts, with a plain name. If a lyric idea fails, the track still gets made with the session's own lyric notes. If enhancing cover text fails, your own text is used.

To go without it, press **Disable Text AI** in **Settings › AI Providers**. If `.env` sets up the text AI on its own, remove those lines and apply the change as shown under [Where keys go](#where-keys-go), or they keep it on. Until then, the button reads **Delete stored fallback** and removes only the saved key.

### Choose a service

| Option in the app | Key | Base URL | Model |
| --- | --- | --- | --- |
| **OpenAI** | Required | Not needed | Optional, `gpt-6-luna` by default |
| **OpenRouter** | Required | Not needed | Required |
| **OpenAI-compatible** | Required | Required, ending in `/v1` | Required |
| **Ollama** | Not needed | Required, without `/v1` | Required |

For an OpenRouter key: create an account at [openrouter.ai](https://openrouter.ai), add credit under **Settings › Credits**, then open **Keys** and create one. The same key can also paint your covers.

An **OpenAI-compatible** service has to be on a public address. Liedmotif refuses addresses on your own network and Tailscale addresses for every option except the Ollama exception below.

## Ollama on the same machine

Ollama runs a text model on your own hardware, so the text AI costs nothing and your words stay on your machine until the music provider receives the finished direction. It needs no key.

Install Ollama on the machine that runs Liedmotif, then pull a model:

```bash
ollama pull llama3.1
```

In guided setup or **Settings › AI Providers**, choose **Ollama** and enter this base URL:

```text
http://host.docker.internal:11434
```

Press **Test**. A successful test lists your installed models, so you can pick one, and then you save. Don't use `localhost`: inside a container, that means the container itself.

**On a Mac or Windows,** that's all. Docker Desktop connects the containers to Ollama for you.

**On Linux,** Ollama listens only to its own machine by default, and the containers can't reach it. Tell it to listen on all interfaces:

```bash
sudo systemctl edit ollama.service
```

Add these two lines, save, and restart Ollama with `sudo systemctl restart ollama`:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
```

If the machine runs a firewall, allow the Docker subnets through it. Keep the rest of your network out, because Ollama itself doesn't ask for a password.

### Ollama on another machine

This isn't supported. Liedmotif accepts Ollama only on the same machine as the app, through `host.docker.internal`, or on a public address. Another computer on your home network and a Tailscale address are both refused. To use a bigger computer's graphics card, run Liedmotif on that computer too.

### Slow models

Thinking models reason before they answer, which can take minutes per request on home hardware and run past the time limit. Turn that off, and keep structured outputs off too, since they can stall a local model:

```bash
LLM_PROVIDER=ollama
LLM_BASE_URL=http://host.docker.internal:11434
LLM_MODEL=llama3.1
LLM_REASONING_EFFORT=none
LLM_SUPPORTS_STRUCTURED_OUTPUTS=false
```

These settings exist only in `.env`, and they take effect only when `LLM_PROVIDER` is set there as well, which is why this block sets up the whole connection. `LLM_REQUEST_TIMEOUT_MS` raises the time limit under the same rule, for example `120000` for two minutes.

## Cover art

Every session gets a cover, and you never need a key for that. Three sources can make it:

| Source | Needs | Cost | What you get |
| --- | --- | --- | --- |
| Tailored cover art | An OpenRouter key, and **Generate Tailored Cover Art** switched on | About 7 cents per cover on the default model | Art in your chosen style, with your people on it. You can regenerate it, and generate playlist covers too |
| Basic cover art | Your music provider's key | No extra cost | The provider's own art, drawn from the finished music alone, with no style choice and no people |
| Liedmotif cover | Nothing | Free | The built-in placeholder, used when neither source above can paint |

Each session can switch **Use Tailored Cover Art Generation** on or off on the start card, and **Settings › Cover art** sets the default. If tailored art is off, or no image key exists, covers come from the music provider. Uploading your own image is free and works with every source.

Generated covers can be limited, in [the cover budget](/docs/costs-and-limits). That budget counts tailored and basic covers alike. Covers are only decoration, so a failed one never holds up your music: the session just keeps the cover it has.

### Add an image key

Enter the OpenRouter key in the **Cover art** screen of guided setup, or under **Cover images** in **Settings › AI Providers**. It's saved separately from the text AI, even when you paste the same key into both. Once saved, it works right away, and no paid image is made until a session needs one.

### Try another model

The default model is `google/gemini-3.1-flash-image`. To try another, enter its OpenRouter ID in the **Model** field next to the key. It has to support OpenRouter's Images API, and **Test** checks that it does. Save it, and the next new cover uses it, while existing covers stay as they are. Prices differ between models, so update your [estimated price per cover](/docs/costs-and-limits) as well.

Models don't all accept the same settings, so Liedmotif asks OpenRouter what the chosen one takes and sends only that. If OpenRouter can't answer, covers go out with just the model and the prompt, and Liedmotif asks again after five minutes. Until then, covers can lose their resolution, aspect ratio and the photos of your people.

If your network blocks that question for good, set `IMAGE_SUPPORTED_PARAMS` in `.env` to the fields the model's OpenRouter page confirms, separated by commas, chosen from `resolution`, `aspect_ratio`, `quality`, `negative_prompt`, `n`, `seed` and `input_references`. Otherwise leave it blank. It can only narrow what OpenRouter reports, never widen it. A wrong value silently drops your resolution and aspect ratio, and leaving out `input_references` turns off the photos of your people.

## Where keys go

You have three places to enter a key:

| Where | When to use it | What happens |
| --- | --- | --- |
| Guided setup | The first time | The key works right away, with no restart |
| **Settings › AI Providers** | Any time after that | The key works right away, with no restart |
| `.env` | When you prefer keeping everything in one file | **`.env` wins** over anything saved in the app, and needs a restart |

When `.env` provides a key, its field in the app locks, and the card says the value comes from the server environment. A key saved in the app then stays as an unused fallback. Each card shows its **Source**, so you can see which one is running.

These are the lines for `.env`:

```bash
# Music provider. Keep MUSIC_PROVIDER=suno, as shipped: blank means a fake test provider.
MUSIC_PROVIDER=suno
SUNO_API_KEY=your-key
#SUNO_BASE_URL=https://api.sunoapi.org
#SUNO_MODEL=V5

# Text AI: openai, openrouter, openai-compatible or ollama
LLM_PROVIDER=openrouter
LLM_API_KEY=your-key
LLM_MODEL=minimax/minimax-m3
#LLM_BASE_URL=

# Cover images
IMAGE_PROVIDER=openrouter
IMAGE_API_KEY=your-key
#IMAGE_MODEL=google/gemini-3.1-flash-image
```

Three details catch people out:

- **A key needs its provider line.** `LLM_API_KEY` without `LLM_PROVIDER`, or `IMAGE_API_KEY` without `IMAGE_PROVIDER`, does nothing.
- **`IMAGE_MODEL` locks the model field** in the app, the same way a key locks its own.
- **`SUNO_MODEL` exists only in `.env`.** The app has no field for it.

After editing `.env`, run this from the folder that holds it: `/opt/liedmotif` after a one-line install, `liedmotif` on a laptop. `docker compose restart` won't do, because it doesn't read the file again. If your user isn't in the `docker` group, put `sudo` in front:

```bash
docker compose up -d web worker
```

## How keys are stored and tested

**Stored.** A key you save in the app goes into your own database, encrypted with AES-256-GCM using `CREDENTIAL_ENCRYPTION_KEY` from your `.env`. The app shows only a masked version of it, it stays out of the logs, and it never reaches a browser. Only your own server talks to the provider. If you leave a key field blank when editing, the saved key stays.

This makes `CREDENTIAL_ENCRYPTION_KEY` worth protecting. If it's lost or changed, the app says "The stored value cannot be decrypted", and you have to enter your keys again. If it's missing altogether, the app says **Keys can't be stored yet**, and you can only use `.env`. A base URL isn't secret and is stored as plain text, so Liedmotif refuses one with a password or token inside it.

**Tested.** **Test** makes only free, read-only requests: it never makes a track and never spends credit. It doesn't save anything either, so press **Save** afterwards. For music it reads your credit balance. For a text AI or image key it checks the key and then looks up your model. In guided setup, a new music key has to pass before you can continue.

Tests of a text AI or image key name your service and model, so the wording varies a little. Ollama says "Connected" where the others say "Key works".

| Message | What it means |
| --- | --- |
| "Credentials verified.", or "Key works and model "…" found." | All good |
| "Key works. OpenRouter lists no models here, so "…" is unchecked." | The key works, but check the spelling of the model yourself |
| "The provider rejected these credentials. Check the API key.", or "OpenRouter rejected this API key." | Wrong or expired key |
| "Could not reach the provider. Check the base URL and network." | The address is wrong or refused, or your server has no connection |
| "Key works, but OpenRouter has no model "…". Check the model ID for typos." | Wrong model name |
| "The provider returned an unexpected response. Check the configuration." | The endpoint isn't what Liedmotif expected |

## How provider media reaches you

Your browser never talks to a provider. Your server collects every audio file and cover itself, stores them and plays them to you, so provider addresses stay out of your browser.

On the way, it protects itself against a bad address. It refuses private, loopback, Tailscale-range and cloud-metadata addresses, it checks again at every redirect, and it connects only to the address it checked.

Media has to come over HTTPS. If you run your own provider on a network you trust and it can't serve HTTPS, add this to `.env`. Every other check still applies, so a private address stays refused:

```bash
ALLOW_INSECURE_PROVIDER_MEDIA=1
```

## What providers receive

Each provider you connect receives what it needs to do its job, under its own terms. The music provider gets the prompt for each track. A hosted text AI gets your requests and lyric notes. The image provider gets the cover's art direction and, when a person appears on a cover, their reference photos. Choosing Ollama keeps the writing step at home, but your music provider still receives the finished prompt. [Privacy and security](/docs/privacy-and-security) has the full picture.

## Rights to your music

What you may do with your tracks depends on your provider and your plan with them, so read their terms before you publish anything. Liedmotif gives no copyright guarantee. It's software you run yourself, and it neither licenses music nor owns what you make.

Ask for moods, moments and genres, not for a named artist's sound. With a text AI, a named artist, band or song in your request becomes a description of its sound, such as "soulful piano ballad, warm alto vocal", and the name stays out of the style it writes. Without one, your words go to your music provider as typed, and its rules apply. Some providers refuse a request that names an artist.
