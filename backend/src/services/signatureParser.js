const ROLE_KEYWORDS = /manager|director|ceo|cto|coo|cfo|engineer|analyst|executive|head|lead|officer|president|vp|vice|consultant|associate|assistant|founder|co-founder|developer|architect|specialist|coordinator|supervisor|account|sales|service|operations|finance|procurement|business|technical|regional|national|general|representative|advisor|partner|incharge|in-charge/i;

// Lines that signal the start of a signature block
const SIG_DELIMITER_RE = /(^|\n)(best regards?|regards?\s+and\s+thank\s+you|regards?|warm regards?|kind regards?|thanks\s*(?:and regards?)?|thank\s*you|cheers|sincerely|yours\s+(?:truly|faithfully|sincerely)?|with regards?|thanking you),?\s*\n/im;

// Lines that are clearly NOT a role: phone numbers, URLs, emails, or street addresses
const JUNK_LINE_RE = /^[\d\s+\-(). ]{6,}$|^https?:\/\/|@|^www\.|mob:|tel:|ph:|fax:|pin\s*:|^\+\d/i;

// Address-specific patterns — floor, road, layout, sector, city/state combos, pin codes
const ADDRESS_LINE_RE = /\b(floor|road|street|avenue|lane|layout|sector|colony|nagar|block|plot|flat|building|tower|complex|park|phase|cross|main|hsr|btm|koramangala|indiranagar|whitefield|bengaluru|bangalore|mumbai|delhi|chennai|hyderabad|pune|kolkata)\b|\b\d{5,6}\b/i;

/**
 * Find all signature-like blocks in a body by scanning for closing phrases.
 * Returns an array of text blocks, each starting just after a closing phrase.
 */
function findAllSignatureBlocks(body) {
  const blocks = [];
  let searchFrom = 0;
  let match;
  const re = new RegExp(SIG_DELIMITER_RE.source, "gim");

  while ((match = re.exec(body)) !== null) {
    const blockStart = match.index + match[0].length;
    // Take up to 400 chars per block (enough for name + title + company)
    blocks.push(body.slice(blockStart, blockStart + 400));
    searchFrom = blockStart;
  }

  return blocks;
}

/**
 * Given a signature block text, find a role/title line near the person's name.
 * Falls back to looking for any role-keyword line in the block.
 */
function extractRoleFromBlock(sigBlock, displayName) {
  if (!sigBlock) return null;

  const lines = sigBlock.split("\n").map((l) => l.trim()).filter(Boolean);
  const firstName = displayName ? displayName.split(/\s+/)[0] : "";

  // Strategy 1: find the name line, then check lines immediately after it
  if (displayName) {
    const nameIdx = lines.findIndex(
      (l) =>
        l.toLowerCase().includes(displayName.toLowerCase()) ||
        (firstName.length > 2 && l.toLowerCase().includes(firstName.toLowerCase()))
    );
    if (nameIdx >= 0) {
      for (const line of lines.slice(nameIdx + 1, nameIdx + 5)) {
        if (!line || line.length < 3 || line.length > 120) continue;
        if (JUNK_LINE_RE.test(line) || ADDRESS_LINE_RE.test(line)) continue;
        if (ROLE_KEYWORDS.test(line)) return line;
      }
    }
  }

  // Strategy 2: any role-keyword line in the block (name may not appear in sig)
  for (const line of lines) {
    if (!line || line.length < 3 || line.length > 120) continue;
    if (JUNK_LINE_RE.test(line) || ADDRESS_LINE_RE.test(line)) continue;
    if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(line)) continue;
    if (ROLE_KEYWORDS.test(line)) return line;
  }

  return null;
}

/**
 * Given an email address and the set of email bodies that mention it,
 * return best-effort { display_name, role_label, sources[] }.
 */
function extractSuggestion(email, senderRows, mentionRows) {
  const result = { display_name: null, role_label: null, sources: [] };

  const allRows = [...senderRows, ...mentionRows];

  // 1. Display name — prefer direct from_name field, fall back to "Name <email>" pattern
  for (const row of senderRows) {
    if (row.from_name?.trim()) {
      result.display_name = row.from_name.trim();
      result.sources.push("sender name");
      break;
    }
  }

  if (!result.display_name) {
    const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`([A-Za-z][A-Za-z .'\\-]{1,40}?)\\s*<${escaped}>`, "i");
    for (const row of allRows) {
      const m = (row.body_preview || "").match(pattern);
      if (m?.[1]?.trim()) {
        result.display_name = m[1].trim();
        result.sources.push("email thread");
        break;
      }
    }
  }

  // 2. Role — scan ALL signature blocks across all available bodies
  for (const row of allRows) {
    const body = row.body_preview || "";
    const blocks = findAllSignatureBlocks(body);

    for (const block of blocks) {
      const role = extractRoleFromBlock(block, result.display_name);
      if (role) {
        result.role_label = role;
        const source = senderRows.includes(row) ? "signature" : "email thread";
        if (!result.sources.includes(source)) result.sources.push(source);
        return result; // found everything, stop
      }
    }
  }

  // 3. Last resort — ONLY look in a tight window BEFORE the email address (e.g. "Name <Title> <email>")
  // Do NOT look after the address — that leads into unrelated body content or a different person's signature.
  if (!result.role_label) {
    for (const row of senderRows) {  // only emails where this person is the sender
      const body = row.body_preview || "";
      const idx = body.toLowerCase().indexOf(email.toLowerCase());
      if (idx === -1) continue;
      const before = body.slice(Math.max(0, idx - 200), idx);
      const lines = before.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines.reverse()) {  // closest lines to the address first
        if (!line || line.length < 3 || line.length > 120) continue;
        if (JUNK_LINE_RE.test(line) || ADDRESS_LINE_RE.test(line)) continue;
        if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(line)) continue;
        if (ROLE_KEYWORDS.test(line)) {
          result.role_label = line;
          result.sources.push("email thread");
          return result;
        }
      }
    }
  }

  return result;
}

module.exports = { extractSuggestion };
