-- Action-item due dates mentioned in an email ("please send by Friday",
-- "renewal due 15th", "reminder – 1 day" — the same keyword vocabulary
-- classifier.js already treats as severity signals, see AGENTS.md) are a
-- different concept from a scheduled MEETING (006_meeting_extraction.sql):
-- nobody attends/joins a deadline, it's just a date something is due. Same
-- column shape as meeting_date/meeting_title/meeting_details so the
-- calendar route's existing extraction pass can populate both from one LLM
-- call per email instead of two.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS action_deadline_date    DATE;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS action_deadline_title   TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS action_deadline_details JSONB;  -- { action }
