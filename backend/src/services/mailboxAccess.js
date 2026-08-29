const pool = require("../db/pool");
const { getValidAccessToken: getMsToken } = require("./msAuth");
const { getValidAccessToken: getZohoToken } = require("./zohoAuth");

/**
 * Resolves how to actually reach a mailbox given its people.id, whether it's a
 * normal self-owned mailbox or a shared inbox reached via delegation. Everything
 * that talks to Graph/Zoho on behalf of a mailbox (ingestion, replying, thread
 * summaries) should go through this instead of assuming "session user == mailbox
 * owner == token owner" — that assumption breaks the moment an admin can view or
 * act on a shared inbox they don't personally own.
 *
 * Returns { accessToken, mailboxTarget, provider }. `mailboxTarget` is null for a
 * self-owned mailbox (call the provider's "me" endpoint); for a delegated shared
 * inbox it's that inbox's own email (call the provider's "users/{email}" endpoint
 * using the delegate's token).
 */
async function resolveMailboxAccess(mailboxOwnerId) {
  const { rows } = await pool.query(
    `SELECT email, is_shared_inbox, delegate_via_person_id
     FROM people WHERE id = $1`,
    [mailboxOwnerId]
  );
  if (!rows.length) throw new Error(`No people row for mailbox_owner_id ${mailboxOwnerId}`);

  const { email, is_shared_inbox, delegate_via_person_id } = rows[0];
  const tokenOwnerId = is_shared_inbox && delegate_via_person_id ? delegate_via_person_id : mailboxOwnerId;
  const mailboxTarget = is_shared_inbox && delegate_via_person_id ? email : null;

  const providerRow = await pool.query(
    `SELECT provider FROM oauth_tokens WHERE person_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [tokenOwnerId]
  );
  const provider = providerRow.rows[0]?.provider || "microsoft";

  const accessToken = provider === "zoho" ? await getZohoToken(tokenOwnerId) : await getMsToken(tokenOwnerId);

  return { accessToken, mailboxTarget, provider, tokenOwnerId };
}

module.exports = { resolveMailboxAccess };
