const pool = require("../db/pool");
const { embedText, toVectorLiteral } = require("./embeddings");

// Matches an email against `properties` (Client_List.xlsx / Asteco Allocation
// import) via four tiers, cheapest and most certain first. Scoped by
// client_id throughout — property numbers/names aren't globally unique
// across different clients' registers.
const UBS_RE = /UBS\s*[#:-]?\s*(\d{3,5})/i;
const P_RE = /\bP[\s/-]?(\d{3,5})\b/i;

// Below this cosine similarity, a semantic match is treated as "found
// nothing" rather than committed — same caution that killed the earlier
// domain-based customer-hint attempt (a weak signal silently accepted reads
// as confident and can't be told apart from a real one later). Tune this
// against real mismatches/misses once semantic matches start accumulating,
// not on a hunch.
const SIMILARITY_THRESHOLD = 0.82;

// Site names under this length are too generic to trust as a substring
// match (real risk: a short/common word coincidentally appearing in
// unrelated mail) — everything actually seen in this client's data is well
// above this (shortest real values are 4-char codes like "P227").
const MIN_SITE_NAME_LENGTH = 4;

/**
 * @param {{subject: string, bodyPreview: string, conversationId: string}} email
 * @param {number} clientId
 * @returns {Promise<{propertyId: number|null, method: 'exact'|'name'|'inherited'|'semantic'|null}>}
 */
async function matchProperty(email, clientId, { skipSemantic = false } = {}) {
  const { subject, bodyPreview, conversationId } = email || {};
  if (!clientId) return { propertyId: null, method: null };

  // Tier 1: exact code match — checked against subject AND body, not subject
  // alone. A UBS/P-number can appear anywhere in the message, and this is a
  // free, certain signal either way — 83%/71% real-data match rates
  // (verified before building this) for UBS/P-number respectively.
  const searchText = `${subject || ""}\n${bodyPreview || ""}`;

  const ubsMatch = searchText.match(UBS_RE);
  if (ubsMatch) {
    const { rows } = await pool.query(
      `SELECT id FROM properties WHERE client_id = $1 AND ubs = $2 LIMIT 1`,
      [clientId, ubsMatch[1]]
    );
    if (rows.length > 0) return { propertyId: rows[0].id, method: "exact" };
  }

  const pMatch = searchText.match(P_RE);
  if (pMatch) {
    const { rows } = await pool.query(
      `SELECT id FROM properties WHERE client_id = $1 AND (property_no = $2 OR site_reference = $2) LIMIT 1`,
      [clientId, pMatch[1]]
    );
    if (rows.length > 0) return { propertyId: rows[0].id, method: "exact" };
  }

  // Tier 2: site-name substring — a property's actual name (e.g. "Al Wahda
  // Tower", "Yasat Compound") written out in plain text, not a code. This is
  // still a LITERAL text match, same certainty tier as the regex above, not
  // a similarity guess — real data showed this catching correct matches
  // that the semantic tier's similarity score (0.6-0.7) couldn't clear a
  // safe threshold for, without the false-positive risk of just lowering
  // that threshold (see conversation — genuinely wrong matches scored in
  // the exact same 0.6-0.7 band on this data).
  const { rows: siteNames } = await pool.query(
    `SELECT id, site_name FROM properties
     WHERE client_id = $1 AND site_name IS NOT NULL AND LENGTH(site_name) >= $2
     ORDER BY LENGTH(site_name) DESC`,
    [clientId, MIN_SITE_NAME_LENGTH]
  );
  const lowerText = searchText.toLowerCase();
  for (const p of siteNames) {
    const name = p.site_name.toLowerCase();
    // Also try with a leading "al " stripped — real gap found testing this:
    // "Al Yasat Compound" is stored with the Arabic definite article, but a
    // real email referred to it as just "Yasat Compound." Checking the
    // bare-stripped form too still requires an exact substring elsewhere in
    // the text, no fuzziness added.
    const bareName = name.startsWith("al ") ? name.slice(3) : null;
    if (lowerText.includes(name) || (bareName && bareName.length >= MIN_SITE_NAME_LENGTH && lowerText.includes(bareName))) {
      return { propertyId: p.id, method: "name" };
    }
  }

  // Tier 3: thread inheritance. Real gap this addresses: a mail trail's
  // FIRST message often names the property, but the external party's later
  // replies frequently don't repeat it anywhere in the reply — no code, no
  // name, nothing a single-message match (regex OR semantic) could ever
  // catch, because the information simply isn't in that message. If any
  // OTHER email already in this same thread resolved to a property, inherit
  // it — free, deterministic, and the only tier that actually solves this
  // specific case. (Process-side, Sariah's team has also been asked to
  // start including the property name in every reply going forward — this
  // is the technical complement to that, not a replacement for it.)
  if (conversationId) {
    const { rows } = await pool.query(
      `SELECT property_id FROM emails WHERE conversation_id = $1 AND property_id IS NOT NULL LIMIT 1`,
      [conversationId]
    );
    if (rows.length > 0) return { propertyId: rows[0].property_id, method: "inherited" };
  }

  // Tier 4: semantic fallback — embeds the FULL email (subject + body), not
  // just the subject line, since a property name is prose that could be
  // anywhere in the message, deep in a quoted trail included. Only commits
  // to a match above SIMILARITY_THRESHOLD; anything weaker stays unmatched
  // rather than guessing. skipSemantic lets a deliberate no-LLM pull (e.g.
  // ingest.js's skipClassification) opt out of this specific tier too — it's
  // the one call in this function that isn't free (Gemini embeddings).
  if (!skipSemantic && searchText.trim().length > 0) {
    try {
      const embedding = await embedText(searchText.slice(0, 4000));
      const vec = toVectorLiteral(embedding);
      const { rows } = await pool.query(
        `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
         FROM properties
         WHERE client_id = $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 1`,
        [vec, clientId]
      );
      if (rows.length > 0 && rows[0].similarity >= SIMILARITY_THRESHOLD) {
        return { propertyId: rows[0].id, method: "semantic" };
      }
    } catch (err) {
      console.error("[propertyMatcher] semantic fallback failed:", err.message);
    }
  }

  return { propertyId: null, method: null };
}

module.exports = { matchProperty, SIMILARITY_THRESHOLD, MIN_SITE_NAME_LENGTH };
