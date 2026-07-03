-- Mail Dashboard schema
-- Run via: npm run migrate

-- ============================================================
-- ROLES & PERMISSIONS (data-driven, configurable without code changes)
-- ============================================================

CREATE TABLE IF NOT EXISTS roles (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,        -- e.g. 'CEO', 'Department Head', 'Team Member'
  description   TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id            SERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,        -- e.g. 'view_all_departments', 'view_own_department_only'
  description   TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ============================================================
-- DEPARTMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS departments (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE          -- e.g. 'Sales', 'Pre-sales', 'Operations & Procurement',
                                                -- 'Escalations', 'Finance', 'Projects'
);

-- ============================================================
-- PEOPLE (team mapping you maintain manually, per our plan)
-- ============================================================

CREATE TABLE IF NOT EXISTS people (
  id              SERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  department_id   INTEGER REFERENCES departments(id),
  role_id         INTEGER REFERENCES roles(id),
  -- set once this person connects their own mailbox (Phase: add other logins later)
  ms_graph_connected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- OAUTH TOKENS (per connected mailbox - encrypted at rest recommended later)
-- ============================================================

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id              SERIAL PRIMARY KEY,
  person_id       INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id)
);

-- ============================================================
-- EMAILS (ingested from Graph, then classified)
-- ============================================================

CREATE TABLE IF NOT EXISTS emails (
  id                  SERIAL PRIMARY KEY,
  mailbox_owner_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  graph_message_id    TEXT NOT NULL,           -- Microsoft Graph's own message ID, for dedupe
  conversation_id     TEXT,                    -- Graph's conversationId, for thread grouping
  subject             TEXT,
  from_email          TEXT,
  from_name           TEXT,
  to_recipients        TEXT,                    -- comma-separated for simplicity at this stage
  cc_recipients        TEXT,
  received_at         TIMESTAMPTZ,
  is_direct_to_owner   BOOLEAN DEFAULT FALSE,    -- owner in To: (not just CC)
  body_preview        TEXT,                    -- trimmed body used for classification, not full storage
  -- classification results (filled in after LLM call)
  department_id       INTEGER REFERENCES departments(id),
  urgency              TEXT,                    -- 'action_needed' | 'fyi'
  attributed_person_id INTEGER REFERENCES people(id),  -- who owns/should handle this
  classified_at        TIMESTAMPTZ,
  classification_raw   JSONB,                   -- store the raw LLM response for debugging/audit
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_owner_id, graph_message_id)
);

CREATE INDEX IF NOT EXISTS idx_emails_conversation ON emails(conversation_id);
CREATE INDEX IF NOT EXISTS idx_emails_department ON emails(department_id);
CREATE INDEX IF NOT EXISTS idx_emails_attributed_person ON emails(attributed_person_id);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);

-- ============================================================
-- RESPONSES (tracks reply activity per thread, for scoring)
-- ============================================================

CREATE TABLE IF NOT EXISTS thread_responses (
  id                  SERIAL PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  original_email_id   INTEGER REFERENCES emails(id) ON DELETE CASCADE,
  responder_person_id INTEGER REFERENCES people(id),
  responded_at        TIMESTAMPTZ,
  response_time_minutes INTEGER,                -- computed: responded_at - original received_at
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_thread_responses_conversation ON thread_responses(conversation_id);
CREATE INDEX IF NOT EXISTS idx_thread_responses_responder ON thread_responses(responder_person_id);

-- ============================================================
-- SEED DATA: default roles, permissions, departments
-- ============================================================

INSERT INTO roles (name, description) VALUES
  ('CEO', 'Full visibility across all departments and people'),
  ('Department Head', 'Visibility limited to their own department by default'),
  ('Team Member', 'Visibility limited to their own emails/score only')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
  ('view_all_departments', 'Can view emails/scores across every department'),
  ('view_own_department_only', 'Can only view their own department''s data'),
  ('view_own_data_only', 'Can only view their own emails/score'),
  ('view_scores', 'Can view response-time scoring'),
  ('view_escalations', 'Can view flagged escalation emails'),
  ('manage_team_mapping', 'Can edit the people/department mapping config')
ON CONFLICT (key) DO NOTHING;

-- Wire up default role -> permission mapping
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'CEO' AND p.key IN
  ('view_all_departments', 'view_scores', 'view_escalations', 'manage_team_mapping')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Department Head' AND p.key IN
  ('view_own_department_only', 'view_scores', 'view_escalations')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.name = 'Team Member' AND p.key IN
  ('view_own_data_only')
ON CONFLICT DO NOTHING;

INSERT INTO departments (name) VALUES
  ('Sales'),
  ('Pre-sales'),
  ('Operations & Procurement'),
  ('Escalations'),
  ('Finance'),
  ('Projects')
ON CONFLICT (name) DO NOTHING;
