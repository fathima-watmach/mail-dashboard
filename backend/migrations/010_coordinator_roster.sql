-- Known-roster attribution for shared inboxes: instead of guessing at signature
-- formatting (which varies a lot in practice — some staff don't use a "Regards"
-- closing line at all), store the exact known handlers for a shared inbox and
-- match emails against that closed list directly.
ALTER TABLE people ADD COLUMN IF NOT EXISTS coordinator_roster JSONB NOT NULL DEFAULT '[]';
