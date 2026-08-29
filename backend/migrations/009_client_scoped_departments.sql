-- Introduce a client boundary: each client gets its own department/category
-- taxonomy, and each mailbox (people row) belongs to one client.

CREATE TABLE IF NOT EXISTS clients (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE departments ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
ALTER TABLE people      ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);

-- Backfill: whatever's already in the DB (the other client's Sales/Pre-sales/etc.
-- departments, and any already-connected mailboxes) belongs to a 'Default' client,
-- so nothing currently running breaks.
INSERT INTO clients (name) VALUES ('Default') ON CONFLICT (name) DO NOTHING;
UPDATE departments SET client_id = (SELECT id FROM clients WHERE name = 'Default') WHERE client_id IS NULL;
UPDATE people      SET client_id = (SELECT id FROM clients WHERE name = 'Default') WHERE client_id IS NULL;

-- Departments are now scoped per client, not globally unique by name.
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_client_name ON departments(client_id, name);

ALTER TABLE departments ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE people      ALTER COLUMN client_id SET NOT NULL;
