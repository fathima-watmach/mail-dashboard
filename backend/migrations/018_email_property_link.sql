-- Links an email to a row in `properties` (imported from Client_List.xlsx,
-- migration 012) when its subject line references a UBS code or property/
-- site-reference number — real coverage check on Sariah's mail: 83% of UBS
-- codes and 71% of P-numbers found in subjects match a real properties row,
-- covering ~40% of all mail overall. Nullable — most mail won't match, and
-- that's expected (internal/admin/vendor correspondence has no single
-- property), not an error state.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS property_id integer REFERENCES properties(id);
CREATE INDEX IF NOT EXISTS idx_emails_property_id ON emails (property_id);
