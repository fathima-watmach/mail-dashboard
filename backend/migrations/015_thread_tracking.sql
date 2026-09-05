-- Thread-level status/narrative and a per-coordinator action log within each
-- thread, generated on-demand (same lazy-cache pattern as the existing
-- per-email thread-summary feature) — see services/threadTracking.js.
CREATE TABLE IF NOT EXISTS thread_summaries (
  id SERIAL PRIMARY KEY,
  mailbox_owner_id INTEGER NOT NULL REFERENCES people(id),
  conversation_id TEXT NOT NULL,
  subject TEXT,
  first_received_at TIMESTAMPTZ,
  last_received_at TIMESTAMPTZ,
  message_count INTEGER,
  status TEXT CHECK (status IN ('pending','ongoing','escalated','resolved')),
  narrative TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_owner_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS coordinator_actions (
  id SERIAL PRIMARY KEY,
  thread_summary_id INTEGER NOT NULL REFERENCES thread_summaries(id) ON DELETE CASCADE,
  email_id INTEGER REFERENCES emails(id),
  coordinator_name TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN
    ('acknowledged','requested_info','sent_quotation','followed_up',
     'escalated','provided_update','confirmed_resolution')),
  action_at TIMESTAMPTZ NOT NULL,
  description TEXT
);
