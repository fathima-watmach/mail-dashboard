const { getVisibleMailboxOwnerIds, getClientId } = require("../services/visibility");

function requireLogin(req, res, next) {
  if (!req.session || !req.session.personId) {
    return res.status(401).json({ error: "Not logged in. Visit /auth/login first." });
  }
  next();
}

/**
 * Resolves which mailboxes the logged-in person can see and attaches them as
 * req.visibleMailboxIds, so routes can pool data across every mailbox an admin
 * is entitled to (their own + any delegated shared inboxes) instead of always
 * filtering to just their own session.personId. Also attaches req.clientId,
 * for routes touching client-scoped tables that aren't keyed by mailbox
 * (contact_mappings/domain_mappings) — req.visibleMailboxIds isn't the right
 * filter there.
 */
async function attachVisibility(req, res, next) {
  try {
    const [visibleMailboxIds, clientId] = await Promise.all([
      getVisibleMailboxOwnerIds(req.session.personId),
      getClientId(req.session.personId),
    ]);
    req.visibleMailboxIds = visibleMailboxIds;
    req.clientId = clientId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireLogin, attachVisibility };
