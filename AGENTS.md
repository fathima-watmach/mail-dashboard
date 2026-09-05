# mail-dashboard (product name: **Watmach Beacon**)

CEO mail-visibility dashboard: ingests a connected mailbox (Microsoft 365 or Zoho),
classifies each email with an LLM (department, urgency, escalation), attributes it
to a responsible person, and serves a React dashboard for triage. Deployed to
Render (`render.yaml`); the backend serves the built frontend as static files in
production. The repo/folder is still named `mail-dashboard`; the product itself
is branded **Watmach Beacon** in the actual UI (browser tab title, header) as of
2026-08-29 — logo at `frontend/src/assets/watmach-logo.png`, brand colors sourced
from it in `frontend/tailwind.config.js` (`navy`/`brand` tokens — read the actual
hex values there rather than assuming, they were sampled directly from the logo
file, not picked arbitrarily).

**For where things currently stand (real production DB state, an in-progress
client pilot, known live issues) see `README.md` — that's the fast-changing
snapshot; this file stays about lasting architecture.**

## Stack

- **Backend**: Node/Express (CommonJS), Postgres via `pg` (no ORM — raw SQL
  migrations in `backend/migrations/`), sessions stored in Postgres
  (`connect-pg-simple`), `node-cron` for scheduled jobs.
- **Frontend**: React 18 + Vite + Tailwind, in `frontend/`.
- **LLM**: Gemini 3.5 Flash-Lite only (`backend/src/services/classifier.js`,
  `services/llm.js`) — DeepSeek/Groq/Ollama support was deliberately removed, not
  just switched off. Calls are serialized through `services/llmQueue.js` (rate
  limits) and gated by `services/llmBudget.js`, a hard monthly USD spend cap
  persisted in Postgres (survives restarts/redeploys) that every classifier and
  thread-summary/reply-suggestion call checks before calling out.

## Repo layout

```
backend/
  migrations/*.sql        # run in order via `npm run migrate`, idempotent
  src/server.js            # express app, sessions, cron schedules, serves frontend/dist
  src/routes/               auth.js, zohoAuth.js, dashboard.js, people.js, calendar.js
  src/services/
    msAuth.js / graphMail.js     # Microsoft 365 OAuth + Graph mail fetch
    zohoAuth.js / zohoMail.js    # Zoho OAuth + mail fetch
    ingest.js                    # pulls mail, drives classification + attribution
    classifier.js                # LLM email classification (department/urgency/escalation)
    attribution.js               # sender -> responsible person mapping
    signatureParser.js           # extracts info from email signatures; extractHandler()
                                  #   identifies which of several staff sent one specific
                                  #   email from a shared inbox (see below)
    mailboxAccess.js             # resolveMailboxAccess(mailboxOwnerId) -> {accessToken,
                                  #   mailboxTarget} — the one place that knows how to reach
                                  #   ANY mailbox (self-owned or delegated shared inbox).
                                  #   Everything touching Graph/Zoho on behalf of a mailbox
                                  #   (ingest, reply, thread-summary) goes through this.
    visibility.js                # getVisibleMailboxOwnerIds(personId) — which mailbox_owner_id
                                  #   values a session can see, via roles/permissions/role_permissions
    llm.js / llmQueue.js         # provider-agnostic LLM call + serialized queue
frontend/
  src/pages/       Dashboard, Calendar, People, Scores, LoginPage
  src/components/  DepartmentGrid, EmailTable, EscalationList, ReplyCompose, StatCard, ThreadSummary
render.yaml        # Render deploy config (env vars, build/start commands)
```

## Dev commands

```bash
# backend
cd backend
npm install
cp .env.example .env        # fill in real values, see below
npm run migrate              # creates tables, seeds roles/departments — safe to rerun
npm start                    # or: npm run dev (auto-restart)
npm run ingest                # trigger ingestion manually instead of waiting for cron

# frontend
cd frontend
npm install
npm run dev                  # vite dev server (localhost:5173)
npm run build                # outputs to frontend/dist, which backend serves in prod
```

Login flow for local testing: `http://localhost:3001/auth/login` (Microsoft) or
`http://localhost:3001/auth/zoho/login` (Zoho).

## Environment variables

See `backend/.env.example` for the full list. Key groups: `DATABASE_URL`
(Supabase/Postgres), `AZURE_*` (Microsoft OAuth), `ZOHO_*` (Zoho OAuth),
`CLASSIFIER_PROVIDER` + matching `*_API_KEY`/`*_MODEL` (LLM), `SESSION_SECRET`,
`FRONTEND_URL`.

## Gotchas / things that look stale — verify before relying on them

- **Every migration file re-runs on every `npm run migrate` invocation** —
  `db/migrate.js` has no applied-migrations ledger, it just replays every
  `.sql` file in order, every time. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  patterns are naturally idempotent, but a seed `INSERT ... ON CONFLICT (col)`
  is NOT safe if a *later* migration ever changes what unique constraint
  backs `col` — the earlier migration will start failing on every subsequent
  run once the later one has executed once. (Hit this for real: migration
  009 dropping `departments`' plain `UNIQUE(name)` broke migration 001's seed
  insert on replay; fixed by guarding 001's insert with an
  `information_schema.columns` check so it's a no-op once `client_id` exists.)
  Test any new migration by running `npm run migrate` **three times in a
  row** against a real DB, not just once or twice — a second real incident
  here (migration 008 recreating `oauth_tokens`' scratch `_enc` columns via
  `ADD COLUMN IF NOT EXISTS` on every replay, which then fooled 011's
  finalize-guard into re-running and nearly dropping the *real* renamed
  columns in favor of freshly-recreated *empty* ones) only surfaced on the
  **second** rerun, and would have destroyed live production OAuth tokens had
  Postgres not rolled back the whole multi-statement file as one implicit
  transaction when the later `SET NOT NULL` failed. Fixed by making 008
  self-aware of whether 011 already finalized it (checks `access_token`'s
  data type) instead of unconditionally recreating scratch columns.
- **`people.zoho_account_id` is referenced by `routes/zohoAuth.js` and
  `services/ingest.js` but no migration file ever creates that column** —
  discovered by rebuilding the schema from scratch on a clean DB (startup
  ingestion failed with `column "zoho_account_id" does not exist"`). Likely
  added manually via Supabase's SQL editor at some point on the real
  deployed DB, matching this repo's "manual SQL, no migration" convention for
  ungoverned changes — but that means a fresh environment built purely from
  `migrations/` is missing it. Not yet fixed as of this note.

- **`backend/README.md` is out of date.** It says "no frontend yet" and describes
  DeepSeek as the classifier. Neither is current — there's a full React frontend,
  and the classifier provider has moved on (see below). Don't trust that file for
  current setup steps; this file supersedes it.
- **Gemini is the only classifier provider** as of the `llmBudget.js` migration —
  `backend/.env.example` and `render.yaml` both set `CLASSIFIER_PROVIDER=gemini`
  with `GEMINI_CLASSIFY_MODEL=gemini-3.5-flash-lite`; `classifier.js`/`llm.js` no
  longer contain code paths for any other provider, so changing
  `CLASSIFIER_PROVIDER` to anything else does nothing. A hard monthly spend cap
  (`LLM_MONTHLY_CAP_USD`, default 10) is enforced in `services/llmBudget.js` —
  persisted in a `llm_spend` Postgres table (migration `014_llm_budget.sql`), not
  in-memory, specifically so it survives Render redeploys. Once the cap is hit for
  the current UTC month, `assertBudgetAvailable()` throws and the call fails the
  same way any other classifier error already does (email saved unclassified,
  picked up later by `reclassifyUnclassified`). For a second layer of protection,
  use a Gemini API key from a Google AI Studio project with **no billing account
  attached** — free-tier overages then hard-fail (429) instead of ever costing
  money, regardless of what the in-app counter says.
- **`thread_responses` table (migration `001_init.sql`) appears unused.** The
  `/api/dashboard/scores` route does NOT read from it — it computes response times
  ad hoc via SQL by matching threads on normalized subject line + time window.
  Grep before assuming this table is the source of truth for response scoring.
- **No automated tests** exist in this repo yet — manual verification only
  (`npm run ingest`, hitting endpoints directly, checking Supabase's table editor).
- **Multi-provider mail support** (Microsoft + Zoho) was added later
  (migration `005_zoho_provider.sql`) — `emails.mail_provider` and
  `oauth_tokens.provider` distinguish which mailbox a record came from; keep both
  paths in mind when touching ingestion or reply-sending code.
- **Admin visibility across delegated shared mailboxes** (migration
  `007_delegated_shared_inboxes.sql`) — a `people` row can represent a shared
  inbox (`is_shared_inbox = true`) reached via Microsoft 365 Full Access
  delegation rather than its own OAuth login; `delegate_via_person_id` points at
  whose token grants that access. `mailbox_owner_id` on `emails` still means
  "which inbox this came from" either way — only *token resolution*
  (`services/mailboxAccess.js`) branches on whether a mailbox is delegated.
  A role with the `view_all_departments` permission (e.g. CEO, already
  seeded in `001_init.sql` but never wired up before this) sees every
  connected/delegated mailbox pooled together; everyone else still sees only
  their own, exactly as before. Provisioning (who's admin, which mailboxes are
  delegated) is a manual SQL step for now — no admin UI yet, same convention as
  department/people mapping in `backend/README.md`.
- **`oauth_tokens.access_token`/`refresh_token` are encrypted at rest**
  (migration `008_encrypt_oauth_tokens.sql`, pgcrypto) using `TOKEN_ENCRYPTION_KEY`
  — set it in `.env` or nothing in `oauth_tokens` will decrypt.
- **`emails.handled_by_name`/`handled_by_role`** are populated only for outgoing
  mail from a shared inbox. Preferred path: `people.coordinator_roster` (JSONB
  array of `{name, role}`) matched via `signatureParser.js`'s `matchRoster` —
  a direct substring match against a known, closed list of staff, with no
  dependency on the email actually having a "Regards"/"Thanks" closing line
  (real samples show some staff signatures don't). Falls back to the generic
  `extractHandler` (delimiter + line-scanning heuristics) only when no roster
  is configured for that mailbox or no roster name matches.
- **Shared/delegated inboxes are READ-ONLY by design** — `msAuth.js` does not
  request `Mail.Send.Shared`, and `POST /api/dashboard/emails/:id/reply`
  returns 403 for any email whose mailbox has `people.is_shared_inbox = true`.
  This matches an explicit client access agreement (read email content/threads
  only — no send/modify/delete/move); don't add send-from-shared-inbox
  capability back without confirming the access grant actually covers it.
- **Historical ingestion window differs by provider default**: a brand-new
  Microsoft mailbox with zero emails pulls the last 30 days on first run
  (`ingestAll`'s MS loop in `ingest.js`, using Graph's `$filter=receivedDateTime
  ge ...` via `graphMail.js`'s `since` param) — client-requested default for an
  initial pilot; an already-ingested MS mailbox just gets the same 7-day
  catch-up as the regular hourly cron. Zoho's new-mailbox default is still the
  financial-year window (`getFinancialYearStart()`) — intentionally left
  untouched, a different existing client relies on it.
- **`properties`** (migration `012_properties.sql`) holds a client's own
  customer/property register (imported from e.g. Sariah's `Client_List.xlsx`
  — one sheet per customer they manage sites for). Deliberately NOT reusing
  the word "client" for the column name: `properties.customer_name` is one of
  a *client's own customers* (e.g. Sariah's customer "Colliers (Asteco)"),
  which is a different concept from the `clients` table (tenants of this
  dashboard — Watmach, POSBank, Sariah). Not yet wired into ingestion/dashboard
  routes — imported as a reference table only, for a future "match this email
  to a property" feature the requirements doc anticipates.
- **This deployment serves multiple clients** (migration
  `009_client_scoped_departments.sql`) — a `clients` table, with `departments`
  and `people` (mailboxes) each belonging to one client via `client_id`.
  Department/category taxonomy is entirely per-client (e.g. one client runs
  Sales/Pre-sales/Operations & Procurement/Finance/Projects, another —
  Sariah Facilities Management — runs MEP/Civil/ELV/FLS/HVAC/Soft
  Services/Garbage System/CCTV/Elevators); `classifier.js` takes the list as a
  `departmentNames` parameter rather than hardcoding one, resolved per-mailbox
  in `ingest.js` from the `departments` table. `visibility.js`'s admin pooling
  (`view_all_departments`) is scoped to the viewer's own client — it does NOT
  mean "every mailbox in the system." No admin UI for managing clients yet;
  provisioning (new client + its departments + attaching mailboxes) is manual
  SQL, same convention as everything else undocumented-UI in this repo.
  `contact_mappings`/`domain_mappings` are NOT yet client-scoped — known gap,
  not addressed as of this migration.
- **Every Overview/Analytics read route takes optional `from`/`to` query params**
  (`YYYY-MM-DD`), applied via `routes/dashboard.js`'s shared `dateRangeFilter(req,
  params, column)` helper — inclusive both ends, no-op (all-time) if omitted.
  `pages/Dashboard.jsx` holds one `range` state shared by every tab that uses it
  (Overview's stat cards/buckets/escalations/trends AND the Analytics tab) —
  there's deliberately no second/separate date picker for Analytics.
- **`GET /api/dashboard/analytics`** (added with the Analytics tab) is the
  heaviest route in this file — 6 queries in one `Promise.all`, including two
  thread-gap CTEs (current period vs. a computed previous-equal-length period,
  for the KPI deltas) copied from `/scores`' pattern. **It's wrapped in its own
  try/catch that the older routes don't have, for a real reason**: an early
  version of this route had 4 queries bound to the full 5-param array when
  their SQL only referenced 3 of them — Postgres's bind protocol rejects that
  exact-count mismatch, and because this is Express 4 (no built-in async error
  catching) the unhandled rejection **crashed the entire Node process**, taking
  every route down until manually restarted. Fixed by only passing
  `currentPeriodParams` (`params.slice(0,3)`) to the 4 queries that don't need
  the previous-period pair. The other routes in this file have no equivalent
  try/catch and are equally exposed to this class of crash on any future
  unhandled query error — not fixed everywhere, just here.
- **`components/TrendsChart.jsx` is generic**, not Overview-specific — it takes
  `series` (stacked bars, bottom-to-top) and an optional `lineSeries` (same
  count axis, never a second y-scale) as props. Overview's Trends and the
  Analytics tab's "Volume by category" chart both render through it with
  different series/colors; don't fork a second copy for a future chart, extend
  the props instead. Its chart colors (and the Analytics heatmap's sequential
  ramp in `components/ActivityHeatmap.jsx`) came from the `dataviz` skill's
  actual CVD validator (`scripts/validate_palette.js`), not eyeballed — if you
  need a 4th categorical color, re-run the validator rather than picking one.
- **Known bug, not yet fixed**: `routes/auth.js`'s Microsoft OAuth callback
  `INSERT INTO people (email, display_name, ms_graph_connected) VALUES (...)`
  never sets `client_id` — which is `NOT NULL` since migration 009. Anyone
  logging in for the very first time **without** an existing `people` row
  already provisioned (client_id + role_id set via manual SQL, matching every
  other provisioning step in this repo) will hit a DB constraint error on
  login (caught by that route's try/catch, so it surfaces as a login-failed
  page, not a server crash — but still broken). Every new person must be
  pre-provisioned with a `client_id` before their first login until this is
  fixed. `routes/zohoAuth.js`'s equivalent callback has the same gap.
