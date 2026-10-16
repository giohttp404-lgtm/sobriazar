# Sobriazar

Personal search and command center. Answers come from two sources (G and C) through a small Cloudflare server that keeps the keys and syncs history, tasks and notes across devices.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/giohttp404-lgtm/sobriazar)

Live at https://sobriazar.giohttp404.workers.dev

## Secrets (set in Cloudflare, never in this repo)

- `APP_PASSWORD` – the password used to sign in
- `GEMINI_API_KEY` – G key
- `ANTHROPIC_API_KEY` – C key

Model names can be changed under `vars` in `wrangler.jsonc`.

## Voice email

Tap the mic (or your glasses) and say something like "find the email from Maria".

1. Sobriazar searches every connected account and gives you a short summary. Say "read all of it" to hear the whole email.
2. Say what to reply ("tell her I'll be there at 3"), or "write a reply for me". Replies match how you write, based on your recent sent emails.
3. It reads the reply back, says who it goes to and which address it sends from, then asks: **send it, change it, or cancel?**
4. On "send it" it says "Sending in 5 seconds, say cancel to stop". Saying "cancel", tapping the mic, or tapping Stop cancels it.

Emails always send from one account, set under **Accounts → Send emails from** (giohttp404@gmail.com by default). Nothing is ever sent without your "send it". On screen, every prepared email has **Send** and **Don't send** buttons with the same 5-second countdown.

## Web helper — step 1: Research

Ask things like "find the cheapest hotel near Albuquerque next weekend", "what are the hours for the MVD on Montgomery", or paste a link and say "summarize this page". Auto sends these to **Research**: G searches Google, opens the actual pages to check prices and details, and answers with a short comparison and sources. It's free on your Gemini key. If G is out of free requests for the day, C does the research instead (a few cents). Works by voice too.
