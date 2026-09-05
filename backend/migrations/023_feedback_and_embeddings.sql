-- Two features share this migration since both need vector search:
-- 1. classification_feedback — a human correcting a wrong classification.
--    Corrections get embedded so future classifications can retrieve similar
--    past corrections as grounding examples (retrieval, not literal RLHF —
--    Gemini's weights aren't ours to retrain; see conversation).
-- 2. properties.embedding — semantic fallback for property matching when the
--    exact UBS/property-number regex (propertyMatcher.js) finds nothing,
--    e.g. a site name typed in prose with no code.
-- Both use gemini-embedding-001 scaled to 768 dimensions (via MRL) — small
-- enough for fast cosine search at this data volume, plenty of signal for
-- short subject-line/property-name text.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Records HOW a property got linked to an email — 'exact' (regex code match,
-- unchanged behavior) or 'semantic' (embedding fallback, new). Kept as an
-- explicit, visible field rather than silently blending the two signals —
-- same reasoning that killed the earlier domain-based customer-hint attempt:
-- a fuzzy match must stay auditable, never indistinguishable from a certain one.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS property_match_method TEXT;

CREATE TABLE IF NOT EXISTS classification_feedback (
  id                       SERIAL PRIMARY KEY,
  email_id                 INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  corrected_by_person_id   INTEGER NOT NULL REFERENCES people(id),
  -- Snapshot of what the AI originally said, for comparison/audit — the
  -- email row itself gets overwritten with the correction, so without this
  -- the "before" state would be lost.
  original_classification  JSONB NOT NULL,
  corrected_department_id  INTEGER REFERENCES departments(id),
  corrected_urgency        TEXT,
  corrected_severity       TEXT,
  corrected_is_critical    BOOLEAN,
  corrected_is_escalation  BOOLEAN,
  comment                  TEXT,
  -- Embedding of the ORIGINAL email content (subject + body preview) — what
  -- gets matched against when a NEW email comes in, not the correction text.
  embedding                vector(768),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classification_feedback_email ON classification_feedback(email_id);
