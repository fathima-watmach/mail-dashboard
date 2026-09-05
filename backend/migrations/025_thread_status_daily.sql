-- Daily snapshot of each thread's status, for a "status trend over time"
-- chart — one row per (thread, day), overwritten with whatever the
-- thread's current status is every time that thread receives new mail that
-- day. Only ever written for threads that already have a thread_summaries
-- row (no extra LLM calls triggered by this table itself — see ingest.js's
-- touchedConversationIds handling).
CREATE TABLE IF NOT EXISTS thread_status_daily (
  id SERIAL PRIMARY KEY,
  mailbox_owner_id INTEGER NOT NULL REFERENCES people(id),
  conversation_id TEXT NOT NULL,
  day DATE NOT NULL,
  status TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_owner_id, conversation_id, day)
);
