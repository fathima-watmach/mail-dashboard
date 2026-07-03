CREATE TABLE IF NOT EXISTS domain_mappings (
  id         SERIAL PRIMARY KEY,
  domain     TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'other',
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_mappings (
  id           SERIAL PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT,
  domain       TEXT,
  department   TEXT,
  role_label   TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_mappings_domain ON contact_mappings(domain);
