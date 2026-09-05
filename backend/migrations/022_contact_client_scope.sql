-- contact_mappings/domain_mappings were never client-scoped (documented gap,
-- see AGENTS.md) — every client's CC autocomplete pulled from the exact same
-- global list. Surfaced as a real bug: a Sariah user typing a CC saw
-- @datacore.com.sa staff (a different client's own-company contacts)
-- suggested on a Sariah<->Colliers thread with zero relevance.
--
-- Nullable, not backfilled: the 23 existing rows are all datacore.com.sa,
-- none of them belong to any of the 4 real clients (Watmach/POSBank/Sariah
-- FM/Default) in a way this migration can safely infer — same reasoning
-- that killed domain-level customer-hint matching earlier (a domain alone
-- isn't a safe signal for who it "belongs to"). Left as NULL so they simply
-- stop appearing for anyone until a person explicitly assigns or deletes
-- them, rather than guessing and silently mis-scoping real contact data.
ALTER TABLE contact_mappings ADD COLUMN IF NOT EXISTS client_id INT REFERENCES clients(id);
ALTER TABLE domain_mappings  ADD COLUMN IF NOT EXISTS client_id INT REFERENCES clients(id);

-- Global uniqueness on email/domain no longer makes sense once two different
-- clients can each save their own mapping for the same external address —
-- replace with per-client uniqueness. Guarded so this is a no-op once
-- already applied (same idempotency convention as every other migration
-- here — see AGENTS.md's migration-replay gotcha).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_mappings_email_key'
  ) THEN
    ALTER TABLE contact_mappings DROP CONSTRAINT contact_mappings_email_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_mappings_client_email_key'
  ) THEN
    ALTER TABLE contact_mappings ADD CONSTRAINT contact_mappings_client_email_key UNIQUE (client_id, email);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_mappings_domain_key'
  ) THEN
    ALTER TABLE domain_mappings DROP CONSTRAINT domain_mappings_domain_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domain_mappings_client_domain_key'
  ) THEN
    ALTER TABLE domain_mappings ADD CONSTRAINT domain_mappings_client_domain_key UNIQUE (client_id, domain);
  END IF;
END $$;
