-- Support shared inboxes accessed via Microsoft 365 delegation (Full Access),
-- pooled visibility for admin roles, and per-email signature-based attribution.

ALTER TABLE people ADD COLUMN IF NOT EXISTS is_shared_inbox BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE people ADD COLUMN IF NOT EXISTS delegate_via_person_id INTEGER REFERENCES people(id);

ALTER TABLE emails ADD COLUMN IF NOT EXISTS handled_by_name TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS handled_by_role TEXT;
