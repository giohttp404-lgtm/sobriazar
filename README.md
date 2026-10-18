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

Ask things like "find the cheapest hotel near Albuquerque next weekend", "what are the hours for the MVD on Montgomery", or paste a link and say "summarize this page". Auto sends these to **Research**: Sobriazar searches the web itself (DuckDuckGo, then Mojeek, no key needed), opens the best pages, and has G write the answer with sources. That's free on your Gemini key. If free search finds nothing or G is busy, C does the research instead (a few cents) and the note above the answer says so. Works by voice too.

**Free search key (recommended):** create a free account at tavily.com (1,000 searches a month, no credit card, so it can never bill you), copy the API key, and add it in Cloudflare → sobriazar → Settings → Variables and Secrets as a **Secret** named `TAVILY_API_KEY`. With it, research is free and much more reliable. Without it, Sobriazar scrapes DuckDuckGo and Bing, which often returns weak results from Cloudflare's servers.

## Web helper — step 2: Mini browser

Start a message with **browse**, **go to** or **open**, or say **use the browser** — for example "browse Kayak for the cheapest hotel in Albuquerque Oct 23–25" or "go to abqlibrary.org and find this week's events". A live card shows the page the cloud browser is on, updating every second or two, with each step listed underneath and a **Stop** button. It keeps working on the server even if you lock your phone or close the page; the answer lands in the conversation with a picture of the last screen and the pages it visited.

This step only looks (open, scroll, follow links, read). It never types into forms, signs in, books or submits anything. It's free: G decides each step, and Cloudflare's free plan includes 10 minutes of browser time a day (a run takes about 1–3 minutes; it stops itself after 5).

## Web helper — step 3: Clicking, typing and "Your turn"

The mini browser can now click buttons, tabs and filters, type into search boxes, pick dates and options, and press Enter. Before clicking through forms it tries shortcuts: the site's **llms.txt** guide for AI, the page's **structured data** (hours, prices, events), and **search links** with the details already filled in.

It never signs in, enters personal details, pays, books, sends or submits anything. When a step needs you — a sign-in, a final "Book" or "Submit", or an "are you a robot?" check — the card turns into **Your turn**: tap and type on the live picture (taps go straight to the cloud browser; typing isn't saved), then tap **Continue**. If you don't respond in about 3 minutes it skips that site and keeps going. Waiting still uses a little of the 10 free browser minutes a day.
