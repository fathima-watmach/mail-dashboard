-- Encrypt OAuth tokens at rest. Adds new encrypted columns alongside the
-- existing plaintext ones — does NOT touch the plaintext columns yet, so
-- already-connected mailboxes keep working. A one-time backfill script
-- (encrypt existing plaintext into these columns) must run before migration
-- 011 finalizes this by dropping the plaintext columns and renaming these in.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Self-aware of whether 011 has already finalized this (access_token is bytea):
-- before finalization, ensure the scratch columns exist for the backfill script;
-- after finalization, tidy them away instead of recreating them forever on every
-- future replay (this system reruns every migration file on every invocation —
-- an earlier, unguarded version of this migration made 011 non-idempotent by
-- doing exactly that).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oauth_tokens' AND column_name = 'access_token' AND data_type = 'bytea'
  ) THEN
    ALTER TABLE oauth_tokens DROP COLUMN IF EXISTS access_token_enc;
    ALTER TABLE oauth_tokens DROP COLUMN IF EXISTS refresh_token_enc;
  ELSE
    ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS access_token_enc BYTEA;
    ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS refresh_token_enc BYTEA;
  END IF;
END $$;
