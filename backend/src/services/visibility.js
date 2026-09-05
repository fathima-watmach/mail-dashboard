const pool = require("../db/pool");

/**
 * Resolves which mailboxes (people.id values) a logged-in person is allowed to
 * see, using the existing roles/permissions schema. A role with the
 * 'view_all_departments' permission (e.g. CEO) sees every connected mailbox,
 * including delegated shared inboxes — everyone else sees only their own, which
 * matches today's behavior unchanged.
 */
async function getVisibleMailboxOwnerIds(personId) {
  const { rows } = await pool.query(
    `SELECT perm.key
     FROM people p
     JOIN roles r ON r.id = p.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions perm ON perm.id = rp.permission_id
     WHERE p.id = $1`,
    [personId]
  );
  const permissionKeys = rows.map((r) => r.key);

  if (permissionKeys.includes("view_all_departments")) {
    // Scoped to the viewer's OWN client — multiple clients can share this
    // deployment, and "see everything" must not leak across that boundary.
    // Includes shared/delegated inboxes (is_shared_inbox = true) whose
    // delegate is connected — a shared inbox never logs in itself, so it can
    // never satisfy ms_graph_connected/zoho_connected on its own (same gap
    // ingest.js's ingestAll() had, fixed the same way here).
    //
    // include_own_mailbox=false excludes a person's OWN mailbox from this
    // pool (e.g. a CEO/admin login whose personal inbox isn't an operational
    // triage mailbox — real case: admin@sariahfm.com) without affecting
    // their usability as a shared-inbox DELEGATE, which is why the shared-
    // inbox OR-branch below checks only d.ms_graph_connected/d.zoho_connected,
    // never d.include_own_mailbox.
    const { rows: allMailboxes } = await pool.query(
      `SELECT p.id
       FROM people p
       LEFT JOIN people d ON p.delegate_via_person_id = d.id
       WHERE p.client_id = (SELECT client_id FROM people WHERE id = $1)
         AND (
           (p.include_own_mailbox = true AND (p.ms_graph_connected = true OR p.zoho_connected = true))
           OR (p.is_shared_inbox = true AND (d.ms_graph_connected = true OR d.zoho_connected = true))
         )`,
      [personId]
    );
    return allMailboxes.map((r) => r.id);
  }

  return [personId];
}

// Resolves the logged-in person's own client_id — needed anywhere that reads
// or writes client-scoped data OUTSIDE the emails table (contact_mappings/
// domain_mappings notably had no client scoping at all until this was added;
// see migration 022_contact_client_scope.sql), where req.visibleMailboxIds
// isn't the right filter since those tables aren't keyed by mailbox.
async function getClientId(personId) {
  const { rows } = await pool.query(`SELECT client_id FROM people WHERE id = $1`, [personId]);
  return rows[0]?.client_id ?? null;
}

module.exports = { getVisibleMailboxOwnerIds, getClientId };
