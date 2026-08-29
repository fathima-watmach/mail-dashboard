-- Finalizes token encryption after the one-time backfill script has copied
-- every existing plaintext token into access_token_enc/refresh_token_enc
-- (see AGENTS.md). Guarded so it's a no-op if it's already run — this system
-- replays every migration file on every `npm run migrate` call.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'oauth_tokens' AND column_name = 'access_token_enc'
  ) THEN
    ALTER TABLE oauth_tokens DROP COLUMN access_token;
    ALTER TABLE oauth_tokens DROP COLUMN refresh_token;
    ALTER TABLE oauth_tokens RENAME COLUMN access_token_enc TO access_token;
    ALTER TABLE oauth_tokens RENAME COLUMN refresh_token_enc TO refresh_token;
    ALTER TABLE oauth_tokens ALTER COLUMN access_token SET NOT NULL;
  END IF;
END $$;
