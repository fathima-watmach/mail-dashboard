const pool = require("../db/pool");

// Second-tier bucketing: when a subject-line property code doesn't match
// (propertyMatcher.js), fall back to who else is on the thread. Checked
// directly against real data before building this: the bare domain isn't
// always enough (mena.colliers.com spans two different customer segments,
// Asteco and Fab), but the individual sender address is — 0 of 15 real
// @mena.colliers.com senders appeared under both segments. So hints are
// stored per sender address first; a domain-level hint is only ever
// derived when every sender seen under that domain agrees on one customer.
//
// Generic/free providers can never identify a specific client — many
// unrelated people use the same one.
const GENERIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
  "live.com", "aol.com", "msn.com", "me.com",
]);

function extractDomain(email) {
  const m = (email || "").trim().toLowerCase().match(/@([\w.-]+)$/);
  return m ? m[1] : null;
}

// Rebuilds email_customer_hints from every email already matched to a real
// property (property_id IS NOT NULL) — that's trusted ground truth, so the
// mapping is mined from it rather than hand-guessed. Safe to re-run any
// time (e.g. after a fresh batch of property matches) — replaces the whole
// table for the given client rather than trying to incrementally patch it.
async function deriveCustomerHints(clientId, mailboxOwnerIds) {
  // Sender-level only — domain-level was tried and dropped. Even
  // restricted to from_email (not to/cc), domain co-occurrence stayed
  // contaminated by real vendors/subcontractors (Tabreed, Schindler,
  // Trimax — companies that do work across many different customers'
  // properties, not just one) genuinely emailing Sariah directly from
  // their own domain about a specific customer's building. A domain only
  // looking "unambiguous" because our current ~1,000-email sample hasn't
  // yet shown it touching a second customer is a sampling artifact, not a
  // real identity claim — not worth the risk of a confidently wrong
  // bucket. Individual sender addresses don't have this problem: checked
  // directly, 0 of 15 real @mena.colliers.com senders appeared under both
  // Colliers customer segments, so a specific person really does
  // correspond to one client consistently.
  const rows = (await pool.query(
    `SELECT e.from_email, pr.customer_name
     FROM emails e
     JOIN properties pr ON pr.id = e.property_id
     WHERE e.mailbox_owner_id = ANY($1::int[])`,
    [mailboxOwnerIds]
  )).rows;

  const senderCustomers = new Map(); // sender email -> Set(customer_name)

  for (const r of rows) {
    const addr = (r.from_email || "").trim().toLowerCase();
    const domain = extractDomain(addr);
    if (!domain || domain.endsWith("sariahfm.com") || GENERIC_DOMAINS.has(domain)) continue;

    if (!senderCustomers.has(addr)) senderCustomers.set(addr, new Set());
    senderCustomers.get(addr).add(r.customer_name);
  }

  const hints = [];
  for (const [sender, customers] of senderCustomers) {
    if (customers.size === 1) hints.push({ hint_key: sender, hint_type: "sender", customer_name: [...customers][0] });
  }

  await pool.query(`DELETE FROM email_customer_hints WHERE client_id = $1`, [clientId]);
  for (const h of hints) {
    await pool.query(
      `INSERT INTO email_customer_hints (client_id, hint_key, hint_type, customer_name)
       VALUES ($1, $2, $3, $4) ON CONFLICT (client_id, hint_key) DO NOTHING`,
      [clientId, h.hint_key, h.hint_type, h.customer_name]
    );
  }
  return hints.length;
}

// Looks up a customer for one email, checking every real participant
// (from, to, cc) against the hint table — not just from_email, since an
// OUTGOING Sariah reply always has from_email = @sariahfm.com itself; the
// actual customer signal for those is in who Sariah is writing to. Safe to
// check all three together because the hint table only ever contains
// addresses proven to be real client senders (derived from from_email
// alone in deriveCustomerHints) — a to/cc match against it is still a
// genuine hit, e.g. the same known client contact cc'd on a reply.
// Sender-level only (no domain fallback) — see deriveCustomerHints for why.
async function matchCustomer({ fromEmail, toRecipients, ccRecipients }, clientId) {
  const rest = [...(toRecipients || "").split(","), ...(ccRecipients || "").split(",")];
  const addrs = [fromEmail, ...rest].map((a) => (a || "").trim().toLowerCase()).filter(Boolean);
  if (!addrs.length || !clientId) return null;

  const senderHits = await pool.query(
    `SELECT customer_name FROM email_customer_hints
     WHERE client_id = $1 AND hint_type = 'sender' AND hint_key = ANY($2::text[]) LIMIT 1`,
    [clientId, addrs]
  );
  return senderHits.rows.length > 0 ? senderHits.rows[0].customer_name : null;
}

module.exports = { deriveCustomerHints, matchCustomer };
