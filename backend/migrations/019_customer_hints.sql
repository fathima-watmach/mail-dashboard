-- Second-tier bucketing signal for the property/client boxing feature. Some
-- customers (e.g. Colliers) share one email domain across two DIFFERENT
-- properties.customer_name segments (Asteco vs Fab) — confirmed on real
-- matched mail that the *individual sender address* disambiguates cleanly
-- (0 of 15 real @mena.colliers.com senders appeared under both segments),
-- while the bare domain does not. So hints are keyed per sender address
-- first, with domain as a fallback only for senders/domains proven
-- unambiguous against real already-matched mail — see customerMatcher.js.
CREATE TABLE IF NOT EXISTS email_customer_hints (
  id serial PRIMARY KEY,
  client_id integer NOT NULL REFERENCES clients(id),
  hint_key text NOT NULL,        -- a sender email address, or a bare domain
  hint_type text NOT NULL CHECK (hint_type IN ('sender', 'domain')),
  customer_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, hint_key)
);

-- Set whenever we know the customer/client for an email, whether from an
-- exact property match (property_id set too) or from this sender/domain
-- hint alone (property_id stays null — we know the client, not the unit).
ALTER TABLE emails ADD COLUMN IF NOT EXISTS customer_name_hint text;
CREATE INDEX IF NOT EXISTS idx_emails_customer_name_hint ON emails (customer_name_hint);
