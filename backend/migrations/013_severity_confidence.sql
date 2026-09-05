-- 4-tier severity (critical/high/medium/low) and self-reported classifier confidence.
-- Nullable and applied going forward only — existing emails keep their old
-- is_critical/isEscalation values and simply have NULL here; no bulk reclassification.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS severity TEXT
  CHECK (severity IN ('critical','high','medium','low'));
ALTER TABLE emails ADD COLUMN IF NOT EXISTS confidence SMALLINT
  CHECK (confidence BETWEEN 0 AND 100);
