# Mail Dashboard — Backend (Phase 1)

Pulls the CEO's (or any connected person's) Outlook mailbox via Microsoft Graph,
classifies each email by department + urgency using DeepSeek, attributes it to a
responsible person via a manually maintained mapping, and stores everything in
Postgres for a dashboard to read instantly (no live processing on page load).

## What this phase includes

- Microsoft login (OAuth2) to connect one mailbox at a time
- Hourly background ingestion (plus one run shortly after server start, for testing)
- LLM classification: department, action-needed vs FYI, escalation flag
- Manual people -> department mapping table
- Role/permission tables seeded with CEO / Department Head / Team Member defaults
- A handful of dashboard API endpoints (buckets, escalations, scores, raw email list)

## What this phase does NOT include yet

- Response-time scoring is wired up structurally (`thread_responses` table, `/scores`
  endpoint) but nothing populates it yet — that needs a small follow-up job that
  detects when a thread gets a reply and computes the time delta. Flag this as the
  next thing to build once ingestion + classification are confirmed working.
- A frontend. This is API-only right now — test with curl/Postman or a browser
  for the GET endpoints once logged in.
- Multi-mailbox / multi-login UI. The login flow supports any number of people
  connecting, but nothing in the UI lets someone choose "view as person X" yet.
- Org-wide / admin-level access. Everything here uses delegated, per-person consent.

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `DATABASE_URL` — from Supabase: Project Settings -> Database -> Connection string
- `AZURE_CLIENT_SECRET` — the secret **Value** (not the Secret ID) from Certificates & secrets
- `DEEPSEEK_API_KEY` — your DeepSeek key
- `SESSION_SECRET` — any random string (e.g. run `openssl rand -hex 32`)

`AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are already filled in from your app registration.

## Run the database migration

```bash
npm run migrate
```

This creates all tables and seeds default roles/permissions/departments. Safe to
run multiple times — it won't duplicate seed data.

## Start the server

```bash
npm start
```

You should see:
```
Mail dashboard backend running on http://localhost:3001
Login at http://localhost:3001/auth/login
```

## Connect your mailbox

1. Open `http://localhost:3001/auth/login` in your browser
2. Sign in with the Microsoft 365 account you want to connect (your own Outlook, for testing)
3. Approve the consent screen (it will ask for Mail.Read and User.Read)
4. You'll be redirected back — since there's no frontend yet, this redirect target
   (`FRONTEND_URL`) won't resolve to anything real yet. That's expected for now;
   the important part (token saved, person record created) already happened.

## Trigger ingestion manually (don't want to wait for the cron or restart)

```bash
npm run ingest
```

Watch the terminal output — it'll show how many new emails were found, classified,
and stored, plus any errors per email (a single bad classification won't crash the
whole batch).

## Check what landed in the database

Easiest way: open your Supabase project -> Table Editor -> `emails` table, and look
at the `department_id`, `urgency`, and `classification_raw` columns to see the
classifier's actual output on your real mail.

## Setting up the people/department mapping for testing

Since we don't have a UI for this yet, insert rows directly via Supabase's Table
Editor (or SQL editor) into the `people` table, e.g.:

```sql
UPDATE people SET department_id = (SELECT id FROM departments WHERE name = 'Sales')
WHERE email = 'someone@yourcompany.com';
```

Your own account (the one you logged in with) gets a `people` row automatically
created on first login — you can set its department/role the same way.

## Next steps (in rough order)

1. Confirm classification quality on real emails — read through `classification_raw`
   and adjust the prompt in `src/services/classifier.js` if categories feel off
2. Build the response-time tracking job (detect replies, populate `thread_responses`)
3. Build a minimal frontend to actually view `/api/dashboard/*` data visually
4. Add role-based filtering to the dashboard routes once more people connect
5. Revisit org-wide access with IT once this is proven on the CEO's own mailbox
