-- Real client-provided property data (Asteco Allocation - Copy.xlsx, added
-- 2026-09-04) uses two different identifier styles depending on the sheet:
-- a numeric/coded project number (property_no, already exists) and a
-- separate human-readable building/site name (e.g. "Al Nahyan Compound A",
-- "AWQAF building") that isn't the same thing and isn't always present.
-- Nullable — most existing rows (from the original Client_List.xlsx import)
-- won't have this filled in, and that's fine, not an error state.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS site_name text;
