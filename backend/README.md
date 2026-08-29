# Watmach Beacon — Backend

This file used to describe a much earlier "phase 1" of this project (single
mailbox, DeepSeek-only, no frontend). All of that is long superseded — see the
root docs instead:

- **[`../README.md`](../README.md)** — setup, the `.env`/`TOKEN_ENCRYPTION_KEY`
  warning if you're moving machines, and the current production state.
- **[`../AGENTS.md`](../AGENTS.md)** — full architecture, schema, and gotchas.

## Backend-specific commands

```bash
npm install
npm run migrate    # replays every migrations/*.sql file — see AGENTS.md's
                    # migration-replay gotcha before writing a new one
npm start           # or: npm run dev
npm run ingest       # trigger ingestion manually instead of waiting for the
                     # hourly cron — prints per-mailbox counts and per-email
                     # errors without crashing the batch
```

`CLASSIFIER_PROVIDER` selects the LLM used for classification/thread-summaries
(DeepSeek/Groq/Gemini/Ollama are all supported — see AGENTS.md); it is **not**
hardcoded to DeepSeek anymore.

Login is at `/auth/login` (Microsoft) or `/auth/zoho/login` (Zoho) — both
redirect back into the real frontend (`FRONTEND_URL`), which has existed for a
while now.
