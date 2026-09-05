-- Separates "this person's OAuth token is valid" (ms_graph_connected /
-- zoho_connected — also used as a DELEGATE credential for shared inboxes,
-- see ingestAll()/getVisibleMailboxOwnerIds()) from "this person's OWN
-- mailbox should be ingested and shown as a mailbox in the dashboard".
--
-- Real case this fixes: admin@sariahfm.com is Sariah's CEO/admin login AND
-- the delegate whose token grants access to contactus@/maintenance@ (the
-- only two real operational mailboxes for that client). Its
-- ms_graph_connected must stay true — flipping it would silently break the
-- hourly cron ingestion of contactus@/maintenance@, which depends on the
-- delegate's ms_graph_connected being true. What we actually want is for
-- admin@'s OWN inbox (0 real emails, not an operational mailbox) to never
-- be ingested or pooled into an admin viewer's visible mailbox set — this
-- column is that independent switch. Defaults to true (preserves existing
-- behavior for every other client/person, e.g. POSBank's CEO pooling model)
-- so this is opt-out, not opt-in, and must be set false explicitly per
-- person via manual SQL, same convention as every other provisioning step
-- in this repo (no admin UI yet).
ALTER TABLE people ADD COLUMN IF NOT EXISTS include_own_mailbox boolean NOT NULL DEFAULT true;

UPDATE people SET include_own_mailbox = false WHERE email = 'admin@sariahfm.com';
