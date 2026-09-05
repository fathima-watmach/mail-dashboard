-- Adds "reopened" as a distinct thread_summaries status, for a thread that
-- was previously marked resolved but then received new activity — see
-- ingest.js's touchedConversationIds handling for how this gets set
-- (deterministic flip on new mail, no extra LLM call) and
-- services/threadTracking.js for the on-demand generation path.
ALTER TABLE thread_summaries DROP CONSTRAINT IF EXISTS thread_summaries_status_check;
ALTER TABLE thread_summaries ADD CONSTRAINT thread_summaries_status_check
  CHECK (status IN ('pending','ongoing','escalated','resolved','reopened'));
