const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireLogin } = require("../middleware/auth");
const { extractSuggestion } = require("../services/signatureParser");

router.use(requireLogin);

// Discover all unique email addresses seen in emails, grouped by domain,
// with their current mapping status
router.get("/discover", async (req, res) => {
  const { rows } = await pool.query(`
    WITH raw_emails AS (
      SELECT LOWER(TRIM(from_email)) AS email FROM emails
        WHERE from_email IS NOT NULL AND from_email != ''
      UNION
      SELECT LOWER(TRIM(e)) FROM emails,
        UNNEST(STRING_TO_ARRAY(to_recipients, ',')) AS e
        WHERE to_recipients IS NOT NULL AND to_recipients != ''
      UNION
      SELECT LOWER(TRIM(e)) FROM emails,
        UNNEST(STRING_TO_ARRAY(cc_recipients, ',')) AS e
        WHERE cc_recipients IS NOT NULL AND cc_recipients != ''
      UNION
      SELECT LOWER(m[1]) FROM emails
        CROSS JOIN LATERAL
          REGEXP_MATCHES(body_preview, '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}', 'g') AS m
        WHERE body_preview IS NOT NULL
    ),
    unique_emails AS (
      SELECT DISTINCT email FROM raw_emails
      WHERE email LIKE '%@%' AND email != ''
    )
    SELECT
      ue.email,
      SPLIT_PART(ue.email, '@', 2) AS domain,
      cm.id        AS contact_id,
      cm.display_name,
      cm.department,
      cm.role_label,
      dm.id        AS domain_id,
      dm.label     AS domain_label,
      dm.type      AS domain_type
    FROM unique_emails ue
    LEFT JOIN contact_mappings cm ON cm.email = ue.email
    LEFT JOIN domain_mappings  dm ON dm.domain = SPLIT_PART(ue.email, '@', 2)
    ORDER BY SPLIT_PART(ue.email, '@', 2), ue.email
  `);

  // Group by domain
  const domainMap = {};
  for (const row of rows) {
    const d = row.domain;
    if (!domainMap[d]) {
      domainMap[d] = {
        domain: d,
        domain_id: row.domain_id,
        label: row.domain_label,
        type: row.domain_type,
        contacts: [],
      };
    }
    domainMap[d].contacts.push({
      email: row.email,
      contact_id: row.contact_id,
      display_name: row.display_name,
      department: row.department,
      role_label: row.role_label,
    });
  }

  res.json({ domains: Object.values(domainMap) });
});

// Flat list of all mapped contacts (for CC autocomplete)
router.get("/contacts", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cm.email, cm.display_name, cm.department, cm.role_label, dm.label as company, dm.type as org_type
     FROM contact_mappings cm
     LEFT JOIN domain_mappings dm ON dm.domain = cm.domain
     ORDER BY cm.display_name NULLS LAST`
  );
  res.json({ contacts: rows });
});

// Suggest contact info for an email address.
// Fetches FULL email bodies from Graph (not truncated DB preview) so signatures
// deep inside forwarded threads are found reliably.
router.get("/suggest", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "email param required" });

  const addr = email.toLowerCase().trim();
  const axios = require("axios");
  const { getValidAccessToken } = require("../services/msAuth");

  // Find graph_message_ids for emails where this person appears
  const { rows: msgRows } = await pool.query(
    `SELECT DISTINCT graph_message_id, from_email, from_name
     FROM emails
     WHERE LOWER(from_email) = $1
        OR to_recipients ILIKE $2
        OR cc_recipients ILIKE $2
        OR body_preview   ILIKE $2
     LIMIT 5`,
    [addr, `%${addr}%`]
  );

  if (msgRows.length === 0) {
    return res.json({ suggestion: { display_name: null, role_label: null, sources: [] } });
  }

  // Fetch full plain-text body from Graph for each message
  const accessToken = await getValidAccessToken(req.session.personId);
  const fullBodies = [];

  for (const row of msgRows) {
    try {
      const r = await axios.get(
        `https://graph.microsoft.com/v1.0/me/messages/${row.graph_message_id}?$select=body`,
        { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' } }
      );
      fullBodies.push({
        from_name: row.from_name,
        is_sender: row.from_email?.toLowerCase() === addr,
        body_preview: r.data.body?.content || "",
      });
    } catch (_) { /* skip failed fetches */ }
  }

  const senderRows  = fullBodies.filter((r) => r.is_sender);
  const mentionRows = fullBodies.filter((r) => !r.is_sender);

  const suggestion = extractSuggestion(addr, senderRows, mentionRows);
  res.json({ suggestion });
});

// Upsert a domain mapping
router.post("/domains", async (req, res) => {
  const { domain, label, type, notes } = req.body;
  if (!domain || !label || !type) {
    return res.status(400).json({ error: "domain, label and type are required" });
  }

  const { rows } = await pool.query(
    `INSERT INTO domain_mappings (domain, label, type, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain) DO UPDATE
       SET label=$2, type=$3, notes=$4, updated_at=now()
     RETURNING *`,
    [domain.toLowerCase(), label, type, notes || null]
  );
  res.json({ domain: rows[0] });
});

router.delete("/domains/:id", async (req, res) => {
  await pool.query("DELETE FROM domain_mappings WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// Upsert a contact mapping
router.post("/contacts", async (req, res) => {
  const { email, display_name, department, role_label, notes } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const domain = email.split("@")[1]?.toLowerCase() || "";
  const { rows } = await pool.query(
    `INSERT INTO contact_mappings (email, display_name, domain, department, role_label, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email) DO UPDATE
       SET display_name=$2, domain=$3, department=$4, role_label=$5, notes=$6, updated_at=now()
     RETURNING *`,
    [email.toLowerCase(), display_name || null, domain, department || null, role_label || null, notes || null]
  );
  res.json({ contact: rows[0] });
});

router.delete("/contacts/:id", async (req, res) => {
  await pool.query("DELETE FROM contact_mappings WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
