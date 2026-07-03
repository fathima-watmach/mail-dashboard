-- Add multi-provider support (Microsoft + Zoho)

-- Allow one token row per person per provider
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'microsoft';
ALTER TABLE oauth_tokens DROP CONSTRAINT IF EXISTS oauth_tokens_person_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_oauth_tokens_person_provider ON oauth_tokens(person_id, provider);

-- Track which providers each person has connected
ALTER TABLE people ADD COLUMN IF NOT EXISTS zoho_connected BOOLEAN NOT NULL DEFAULT FALSE;

-- Track which mail provider each stored email came from (for routing replies)
ALTER TABLE emails ADD COLUMN IF NOT EXISTS mail_provider TEXT NOT NULL DEFAULT 'microsoft';
