# Beacon Backlog

Deferred from the "Wave 1" operations-command-center redesign (2026-08-30).
These two items came out of a detailed product-feedback review but need real
new data-model work, not just a new query against data that already exists —
scoped out of Wave 1 deliberately so Wave 1 could ship against what the
classifier and schema already produce. Both are written up here so a future
session can pick either up without re-deriving the reasoning.

## Client Health

**The idea**: a per-client (or per-customer-property) rollup — e.g. for Sariah
Facilities Management, "how is Colliers (Asteco) doing" — surfacing volume,
open escalations, and SLA performance scoped to one of the client's own
customers rather than to a department or coordinator.

**Why it's not built yet**: there is no link today between an `emails` row and
a specific customer/property. The `properties` table (migration
`012_properties.sql`) holds Sariah's customer/property register
(`properties.customer_name`, e.g. "Colliers (Asteco)") imported from their own
`Client_List.xlsx`, but it's a standalone reference table — nothing in
`ingest.js` or `classifier.js` currently attempts to match an incoming email
to a property. See `AGENTS.md`'s note on `properties` for the full
distinction between `properties.customer_name` (a client's own customer) and
the `clients` table (tenants of this dashboard — Watmach, POSBank, Sariah).

**Roughly what it would take**:
1. A matching strategy — likely sender-domain or sender-email against
   `properties`, possibly with an LLM assist for cases where the property is
   only named in the email body/subject (e.g. a site name, not a domain).
2. A new column on `emails` (e.g. `property_id`) populated at ingest time,
   plus a backfill for existing rows.
3. A new dashboard route aggregating by `property_id` (volume, escalations,
   SLA rate — same shape as the existing `/scores` department rollup, just a
   different group-by dimension).
4. A frontend panel/tab, most naturally added to `Scores.jsx` alongside the
   existing Coordinators/Departments views, or as its own tab if the data
   warrants more space.
5. Only meaningful for clients that actually have a `properties` register
   (currently just Sariah) — needs a graceful "not applicable" state for
   clients without one.

## Top Issues (theme extraction)

**The idea**: surface the 3-5 most common *topics* driving mail volume this
period (e.g. "HVAC breakdown requests", "invoice follow-ups") rather than
just department/severity counts — something closer to "what is everyone
actually emailing about."

**Why it's not built yet**: this isn't a new query against existing data —
`classifier.js` doesn't currently extract anything theme-like. `department`
is too coarse (a client like Sariah runs department names like MEP/Civil/ELV,
not fine-grained topics), and `summary` is free-text per-email, not a
clusterable label. This needs a genuinely new classification dimension.

**Roughly what it would take**:
1. Decide the mechanism: either (a) have the classifier LLM emit a short
   `topic_tag` per email at classification time (cheap, but tags will drift/
   fragment across near-duplicate phrasings unless heavily prompt-constrained
   to a controlled vocabulary), or (b) a separate periodic batch job that
   clusters recent `summary`/`subject` text into themes (more accurate, more
   LLM calls, needs its own budget consideration — see `llmBudget.js`'s
   existing hard monthly cap, which this would compete against).
2. If (a): a new `emails` column, prompt changes, backfill for historical
   rows once the vocabulary is decided.
3. If (b): a new table for computed theme rollups (period-scoped, since
   themes are only meaningful "this week" not "all time"), a cron job or
   on-demand computation, and real thought about cost — this is the kind of
   feature that could quietly blow through the $10/month LLM cap if not
   carefully batched (one call per period across all emails, not per-email).
4. A frontend panel — likely a small ranked list (theme, count, trend arrow)
   on Overview or Analytics, in the same visual language as the existing
   `TrendsChart`/`ActivityHeatmap` components.

Recommendation if/when either is picked up: prototype (a) for Top Issues
first since it's far cheaper than (b) and can be judged on real output before
investing in a separate clustering job.

**Update 2026-09-05**: Client Health's step 1 (property-matching) is done —
`emails.property_id` exists and is populated via `propertyMatcher.js`'s
3-tier match (exact code -> thread inheritance -> semantic/pgvector
embedding fallback), plus the full Client -> Property -> Criticality funnel
UI in `EmailTable.jsx`/`OverviewPanels.jsx`. Steps 3-4 (a dedicated
per-property rollup route + Scores.jsx panel, i.e. actually aggregating
volume/escalations/SLA rate by property rather than just filtering to one)
are still not built — that's what's left of this item.

## Attachment review (PDFs/documents in emails)

**The idea**: read PDFs and other documents attached to incoming mail, not
just the email body, to inform classification and extract information (e.g.
a quotation PDF's amount, a report's findings) — raised as a future
direction while discussing RAG's fit for this app.

**Why it's a strong RAG fit, more so than core classification**: unlike the
department list or the MoM's keyword list (both small enough to just inline
in every prompt), an attached document can be pages long — genuinely too
large to always include in full, which is exactly the situation retrieval is
for. Likely shape: extract text per attachment (a PDF-to-text step — Graph
API can fetch attachment content, similar to how `graphMail.js` already
fetches inline images), chunk and embed it, and retrieve relevant chunks at
classification time the same way `classifier.js`'s `getFeedbackGrounding`
retrieves similar past corrections today. Same `pgvector` infrastructure
(migration `023_feedback_and_embeddings.sql`) would extend naturally — a new
table (`attachment_chunks` or similar) rather than reusing `properties` or
`classification_feedback`. Not scoped or estimated yet — noted here so a
future session has the starting point.

## Escalation: senior-person-joins-thread detection (deferred 2026-09-05)

**Context**: escalation was redefined for Sariah on 2026-09-05 to mean ONLY
an NCR (Non-Conformance Report) mention anywhere in the thread — a hard,
deterministic check (`classifier.js`'s `NCR_RE`/`hasNcrInThread`), replacing
the old broad "any real business problem" definition, which the client found
too loose.

A second candidate condition was discussed: flag an email as an escalation
when a senior representative from the OTHER party (Colliers/Modon, not
Sariah's own staff) newly joins a previously working-level conversation.
**Deliberately not built** — the one real example tested against it turned
out to still be NCR-driven (an NCR was issued further back in that same
thread, just not visible in the portion first shared), so there's no
verified case yet of "senior person joins" being a genuine SEPARATE trigger
from NCR. Building a heuristic without a confirmed real example to check it
against risks the same class of mistake as the abandoned domain-based
customer-hint match earlier this project — a plausible-sounding signal that
turns out unreliable once tested against real data.

**How to revisit this**: the `classification_feedback` table (migration
`023_feedback_and_embeddings.sql`) is already collecting real corrections
with comments — if a coordinator ever corrects an email TO escalation with a
comment along the lines of "a director/VP got involved" and there's
genuinely no NCR anywhere in that thread, that's the first real example to
design the rule against. Wait for a small handful of these before building
anything — one example isn't enough to safely generalize a seniority-based
rule from (what does "senior" mean across different companies' title
conventions? how far back does "newly joined" look?).
