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
    const { rows: allMailboxes } = await pool.query(
      `SELECT id FROM people
       WHERE (ms_graph_connected = true OR zoho_connected = true)
         AND client_id = (SELECT client_id FROM people WHERE id = $1)`,
      [personId]
    );
    return allMailboxes.map((r) => r.id);
  }

  return [personId];
}

module.exports = { getVisibleMailboxOwnerIds };
