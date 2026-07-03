-- Store LLM-extracted meeting mentions from email bodies
ALTER TABLE emails ADD COLUMN IF NOT EXISTS meeting_date    DATE;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS meeting_time    TEXT;       -- e.g. "3:00 PM IST"
ALTER TABLE emails ADD COLUMN IF NOT EXISTS meeting_title   TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS meeting_details JSONB;      -- { participants, location, notes }
ALTER TABLE emails ADD COLUMN IF NOT EXISTS thread_summary  JSONB;      -- cached thread summary entries
