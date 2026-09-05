-- Persistent (not in-memory) monthly LLM spend tracker — survives server
-- restarts/redeploys, which an in-memory counter can't, so the monthly cap
-- actually holds across the whole month rather than resetting on every deploy.
CREATE TABLE IF NOT EXISTS llm_spend (
  month      TEXT PRIMARY KEY,             -- 'YYYY-MM', UTC
  spent_usd  NUMERIC(12,6) NOT NULL DEFAULT 0
);
