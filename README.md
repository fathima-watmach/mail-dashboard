# Watmach Beacon

A mail-visibility dashboard: connects a mailbox (Microsoft 365 or Zoho), classifies
every email by department/urgency/escalation via an LLM, and serves a dashboard for
triage — plus, as of 2026-08-29, an Analytics tab (KPIs, volume trends, top senders,
response-time trend, activity heatmap). Originally built for a single company; now
serves **multiple clients** from one deployment (see "Current production state"
below).

**New here? Start with [HOW_IT_WORKS.md](HOW_IT_WORKS.md)** — a plain-English,
diagram-led walkthrough of what this dashboard does end to end, no technical
background assumed.

For the full technical architecture, gotchas, and repo layout, see **[AGENTS.md](AGENTS.md)**
— that's the primary reference for working in this codebase (written for an AI
coding agent, but a human will get just as much out of it). This file is the
"what's the current state of the world, and how do I get running again" doc.

## ⚠️ Moving to a new machine? Read this first

This repo was developed on one machine against a **real, live production database**
(Supabase-hosted Postgres) serving real client data. Moving to a new system:

1. **Clone/copy the repo as normal** — everything version-controlled comes with it.
2. **`backend/.env` is gitignored and will NOT come with the repo.** You must copy
   that file directly (not retype it from memory) from the old machine to the new
   one — via a password manager secure note, encrypted transfer, whatever your own
   security practice is. See `backend/.env.example` for what each key is *for*, but
   copy the **actual working file**, not a freshly-filled-in template.
3. **Do NOT regenerate `TOKEN_ENCRYPTION_KEY`.** It must be the exact same value as
   what's already in use — it's what decrypts every already-stored OAuth token in
   the real database (`oauth_tokens.access_token`/`refresh_token`, encrypted via
   `pgcrypto`). Change this value and every existing mailbox connection becomes
   permanently undecryptable — everyone would need to reconnect from scratch.
4. Everything else (`DATABASE_URL`, `AZURE_*`, `ZOHO_*`, `SESSION_SECRET`,
   `CLASSIFIER_PROVIDER` + its key) should also just be copied as-is unless you
   specifically intend to point at a different database/app registration/LLM
   provider going forward.
5. If you plan to keep using a local LLM for classification/thread-summaries
   (`CLASSIFIER_PROVIDER=ollama`), you'll need Ollama installed and the model
   pulled fresh on the new machine (`ollama pull llama3`, or whatever
   `OLLAMA_MODEL` is set to) — that's not something a file copy carries over.

## Local setup

```bash
# backend
cd backend
npm install
# copy your real .env here (see above) — do not run `cp .env.example .env`
# and start filling in fresh secrets, that only makes sense for a genuinely new deployment
npm run migrate     # safe to run repeatedly; see AGENTS.md's migration-replay gotcha first
npm start           # or: npm run dev

# frontend
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Backend runs on `http://localhost:3001` by default (`PORT` in `.env`). Login at
`/auth/login` (Microsoft) or `/auth/zoho/login` (Zoho).

## Current production state (as of 2026-08-29)

The real database currently has **3 clients** (tenants of this dashboard, each
with their own department taxonomy and pooled mailbox visibility — see AGENTS.md's
multi-tenancy section):

| Client | Mailboxes | Status |
|---|---|---|
| **Watmach** (client id 1) | `fathima@watmachtech.com` (Microsoft) | Token likely expired from an earlier extended pause — needs a fresh `/auth/login` before ingestion works again. |
| **POSBank** (client id 7) | `ihsan@posbank.in`, `hrd@posbank.in` (both Zoho) | Ihsan's token is working. **Hrd's Zoho token is dead** (`invalid_code` on refresh) — needs to reconnect via `/auth/zoho/login`. |
| **Sariah Facilities Management** (client id 8) | `admin@sariahfm.com` (Microsoft, CEO role — pools the whole client), `contactus@sariahfm.com` + `maintenance@sariahfm.com` (shared inboxes, delegated via Admin's token, read-only per client agreement) | **Pilot in progress** — see below. |

### Sariah pilot — where it's at

This is the active pilot, mid-setup as of today:

- ✅ Client, 9 departments (MEP/Civil/ELV/FLS/HVAC/Soft Services/Garbage
  System/CCTV/Elevators), and both shared-inbox rows (with coordinator rosters
  for signature-based attribution) are provisioned in the real DB.
- ✅ `admin@sariahfm.com` has a `people` row: `client_id` = Sariah, `role_id` = CEO,
  and both shared inboxes' `delegate_via_person_id` point at it.
- ✅ `admin@sariahfm.com` was assigned a Microsoft 365 Business Premium license
  today (their tenant's Exchange Online Plan 2 pool had zero spare seats; Business
  Premium had spares) — should have a working mailbox now.
  ⚠️ **That whole Business Premium license pool is a trial expiring 2026-09-05** —
  worth confirming with Sariah whether it's been converted to paid, since letting
  it lapse would break more than just this pilot account.
- ✅ Full Access delegation was granted today, on **both** `contactus@sariahfm.com`
  and `maintenance@sariahfm.com`, to `admin@sariahfm.com` (Exchange Admin Center →
  Recipients → Mailboxes → each shared inbox → Delegation → Full Access only — no
  Send As/Send on Behalf, per the read-only agreement).
- ⏳ **Still needed**: `admin@sariahfm.com` needs to complete a real login through
  this app's own `/auth/login` (not just Outlook) — that's what actually saves a
  working OAuth token for Beacon to use. Once that happens, the next hourly
  ingestion cron (or a manual `npm run ingest`) should start pulling both shared
  inboxes. Worth checking the backend logs after that first login to confirm
  ingestion actually reaches `contactus@`/`maintenance@sariahfm.com` and that the
  Full Access delegation is really in effect (Graph will error clearly if not).
- 🔜 Not yet done, queued from earlier findings: scaling the historical
  ingestion window to Sariah's requested "last 1 month" (the *mechanism* for this
  already exists generally — see AGENTS.md's historical-window gotcha — just needs
  confirming it behaves as expected once real ingestion starts for these two
  mailboxes), and wiring the imported `properties` table (Sariah's own
  customer/site register) into anything user-facing (currently just a reference
  table, per AGENTS.md).

### Known bugs / gaps (see AGENTS.md for full detail on each)

- `routes/auth.js`/`zohoAuth.js`'s OAuth callbacks don't set `client_id` for a
  brand-new login — anyone not pre-provisioned will fail to log in for the first
  time. Every new person needs manual SQL provisioning (client_id + role_id)
  *before* their first login, until this is fixed.
- `people.zoho_account_id` is used by the app but no migration creates it — it
  exists on the real DB from a manual fix, but a from-scratch schema rebuild would
  be missing it.
- `contact_mappings`/`domain_mappings` aren't client-scoped yet.
- No automated tests anywhere in this repo — verification has been entirely manual
  (direct SQL checks, curl, and browser verification via Claude in Chrome) this
  whole build.
