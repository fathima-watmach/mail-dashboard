-- Per-client property/site register, imported from a client's own records
-- (e.g. Sariah's Client_List.xlsx — one sheet per customer they manage
-- properties for). Distinct from the `clients` table: `clients` are tenants
-- of this dashboard (Watmach, POSBank, Sariah); `properties.customer_name`
-- is one of a CLIENT's own customers (e.g. Sariah's customer "Colliers
-- (Asteco)") — deliberately not named/shaped like the clients table to avoid
-- conflating the two.
CREATE TABLE IF NOT EXISTS properties (
  id                     SERIAL PRIMARY KEY,
  client_id              INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  customer_name          TEXT NOT NULL,       -- e.g. 'Colliers (Asteco)', 'Relaam', 'Halliburton'
  site_reference         TEXT,                -- building/project/site name or number, however that client refers to it
  property_no            TEXT,                -- separate property/unit code, where the source distinguishes it from site_reference
  address                TEXT,
  landlord_name          TEXT,
  trn                    TEXT,
  ubs                    TEXT,                -- only present in some sheets (e.g. FABP/MPM/AY)
  facilities_manager     TEXT,
  engineer               TEXT,
  supervisor             TEXT,
  admin                  TEXT,
  client_incharge        TEXT,
  client_incharge_senior TEXT,
  sariah_incharge        TEXT,
  sariah_incharge_2      TEXT,
  sariah_incharge_3      TEXT,
  raw                    JSONB,               -- full original row, for anything the columns above don't capture
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_client ON properties(client_id);
CREATE INDEX IF NOT EXISTS idx_properties_customer_name ON properties(client_id, customer_name);
