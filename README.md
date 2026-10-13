# Sobriazar

Personal search and command center. Answers come from two sources (G and C) through a small Cloudflare server that keeps the keys and syncs history, tasks and notes across devices.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/giohttp404-lgtm/sobriazar)

## Secrets (set in Cloudflare, never in this repo)

- `APP_PASSWORD` – the password used to sign in
- `GEMINI_API_KEY` – G key
- `ANTHROPIC_API_KEY` – C key

Model names can be changed under `vars` in `wrangler.jsonc`.
