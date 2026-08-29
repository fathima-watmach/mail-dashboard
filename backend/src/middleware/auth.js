const { getVisibleMailboxOwnerIds } = require("../services/visibility");

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
 * filtering to just their own session.personId.
 */
async function attachVisibility(req, res, next) {
  try {
    req.visibleMailboxIds = await getVisibleMailboxOwnerIds(req.session.personId);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireLogin, attachVisibility };
