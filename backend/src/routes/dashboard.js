const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../db/pool");
const { requireLogin } = require("../middleware/auth");
const { getValidAccessToken: getMsToken }   = require("../services/msAuth");
const { getValidAccessToken: getZohoToken } = require("../services/zohoAuth");
const { sendReply: zohoReply }              = require("../services/zohoMail");
const { callLLM, extractJson }              = require("../services/llm");

router.use(requireLogin);

router.get("/summary", async (req, res) => {
  const { personId } = req.session;

  const [totalRes, criticalRes, actionRes, escalationRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM emails WHERE mailbox_owner_id = $1`, [personId]),
    pool.query(`SELECT COUNT(*) FROM emails WHERE mailbox_owner_id = $1 AND is_critical = true`, [personId]),
    pool.query(`SELECT COUNT(*) FROM emails WHERE mailbox_owner_id = $1 AND urgency = 'action_needed' AND is_direct_to_owner = true`, [personId]),
    pool.query(`SELECT COUNT(*) FROM emails WHERE mailbox_owner_id = $1 AND (classification_raw->>'isEscalation')::boolean = true`, [personId]),
  ]);

  res.json({
    total: Number(totalRes.rows[0].count),
    critical: Number(criticalRes.rows[0].count),
    actionNeeded: Number(actionRes.rows[0].count),
    escalations: Number(escalationRes.rows[0].count),
  });
});

router.get("/buckets", async (req, res) => {
  const { personId } = req.session;

  const { rows } = await pool.query(
    `SELECT d.name AS department, e.urgency, COUNT(*) AS count
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.mailbox_owner_id = $1
     GROUP BY d.name, e.urgency
     ORDER BY d.name`,
    [personId]
  );

  res.json({ buckets: rows });
});

router.get("/escalations", async (req, res) => {
  const { personId } = req.session;
  const directOnly = req.query.direct === "true";

  const { rows } = await pool.query(
    `SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
            e.to_recipients, e.cc_recipients,
            e.is_direct_to_owner, e.is_critical, e.summary, e.actioned_at,
            d.name AS department, p.display_name AS attributed_to,
            e.classification_raw
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN people p ON p.id = e.attributed_person_id
     WHERE e.mailbox_owner_id = $1
       AND (e.classification_raw->>'isEscalation')::boolean = true
       ${directOnly ? "AND e.is_direct_to_owner = true" : ""}
     ORDER BY e.is_critical DESC, e.received_at DESC
     LIMIT 100`,
    [personId]
  );

  res.json({ escalations: rows });
});

router.get("/action-needed", async (req, res) => {
  const { personId } = req.session;

  const { rows } = await pool.query(
    `SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
            e.to_recipients, e.cc_recipients,
            e.is_direct_to_owner, e.is_critical, e.summary, e.actioned_at,
            d.name AS department, p.display_name AS attributed_to
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN people p ON p.id = e.attributed_person_id
     WHERE e.mailbox_owner_id = $1
       AND e.urgency = 'action_needed'
       AND e.is_direct_to_owner = true
     ORDER BY e.is_critical DESC, e.received_at DESC
     LIMIT 100`,
    [personId]
  );

  res.json({ emails: rows });
});

router.post("/emails/:id/reply", async (req, res) => {
  const { personId } = req.session;
  const { text, replyAll = false, cc = [] } = req.body;

  if (!text?.trim()) return res.status(400).json({ error: "Reply text is required" });

  const { rows } = await pool.query(
    `SELECT graph_message_id, mail_provider, from_email FROM emails WHERE id = $1 AND mailbox_owner_id = $2`,
    [req.params.id, personId]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const { graph_message_id, mail_provider, from_email } = rows[0];

  if (mail_provider === "zoho") {
    const personRow = await pool.query(
      `SELECT email, zoho_account_id FROM people WHERE id = $1`, [personId]
    );
    const { email: ownerEmail, zoho_account_id: accountId } = personRow.rows[0];
    const accessToken = await getZohoToken(personId);
    await zohoReply(accessToken, accountId, {
      origMessageId: graph_message_id,
      fromAddress:   ownerEmail,
      text:          text.trim(),
      replyAll,
      cc,
    });
  } else {
    const accessToken = await getMsToken(personId);
    const endpoint = replyAll ? "replyAll" : "reply";
    const body = { comment: text.trim() };
    if (cc.length > 0) {
      body.message = { ccRecipients: cc.map((addr) => ({ emailAddress: { address: addr } })) };
    }
    await axios.post(
      `https://graph.microsoft.com/v1.0/me/messages/${graph_message_id}/${endpoint}`,
      body,
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
  }

  await pool.query(`UPDATE emails SET actioned_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ── Thread summary (on-demand, cached) ────────────────────────────────────────
router.get("/emails/:id/thread-summary", async (req, res) => {
  const { personId } = req.session;
  console.log(`[thread-summary] email=${req.params.id} personId=${personId}`);

  const { rows } = await pool.query(
    `SELECT graph_message_id, mail_provider, thread_summary, body_preview, zoho_folder_id FROM emails
     WHERE id = $1 AND mailbox_owner_id = $2`,
    [req.params.id, personId]
  );
  if (!rows.length) {
    console.log(`[thread-summary] email ${req.params.id} not found for person ${personId}`);
    return res.status(404).json({ error: "Not found" });
  }

  // Clear cache if refresh requested
  if (req.query.refresh === "true") {
    await pool.query(`UPDATE emails SET thread_summary = NULL WHERE id = $1`, [req.params.id]);
  } else if (rows[0].thread_summary) {
    return res.json({ entries: rows[0].thread_summary });
  }

  // Fetch full body from the right provider
  const { graph_message_id, mail_provider, body_preview, zoho_folder_id } = rows[0];
  let fullBody = body_preview || "";
  console.log(`[thread-summary] fetching full body provider=${mail_provider} bodyLen=${fullBody.length} folderId=${zoho_folder_id}`);

  try {
    if (mail_provider === "zoho") {
      const personRow = await pool.query(`SELECT zoho_account_id FROM people WHERE id = $1`, [personId]);
      const accountId = personRow.rows[0]?.zoho_account_id;
      if (accountId) {
        const token = await getZohoToken(personId);
        // Use folder-based URL (required by Zoho API)
        // If folderId not stored, fetch the message list to find it
        let folderId = zoho_folder_id;
        if (!folderId) {
          const listR = await axios.get(
            `https://mail.zoho.com/api/accounts/${accountId}/messages/view?limit=200`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
          );
          const found = (listR.data?.data || []).find(m => m.messageId === graph_message_id);
          folderId = found?.folderId || null;
          if (folderId) {
            await pool.query(`UPDATE emails SET zoho_folder_id = $1 WHERE id = $2`, [folderId, req.params.id]);
          }
        }
        if (folderId) {
          const r = await axios.get(
            `https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${graph_message_id}/content`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
          );
          fullBody = r.data?.data?.content || fullBody;
        }
      }
    } else {
      const token = await getMsToken(personId);
      const r = await axios.get(
        `https://graph.microsoft.com/v1.0/me/messages/${graph_message_id}?$select=body`,
        { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } }
      );
      fullBody = r.data?.body?.content || fullBody;
    }
  } catch (e) {
    console.log(`[thread-summary] body fetch failed, using stored preview: ${e.message}`);
  }

  // Strip HTML — remove block content first, then tags, then decode entities
  const cleanBody = fullBody
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#\d+;/g, " ")
    .replace(/\s{3,}/g, "\n")
    .trim();

  const prompt = `You are analysing an email thread (newest message at top, older replies quoted below).
Extract each distinct message in CHRONOLOGICAL ORDER (oldest first).
For each message return: date (from the text, e.g. "25 Jun 2026"), from (sender name or email as written), summary (one sentence).

STRICT RULES — violations are worse than returning fewer entries:
- ONLY include messages explicitly present in the text below. Do NOT invent any.
- Do NOT use placeholder names like "John Doe", "Jane Smith", or any name not in the text.
- If you cannot find a clear sender name, use their email address.
- Ignore signatures, legal disclaimers, and quoted text that repeats earlier messages.
- If only one distinct message exists, return an array with one entry.
- When uncertain whether a message boundary exists, skip it.
Return ONLY a valid JSON array, no markdown:
[{"date":"...","from":"...","summary":"..."},...]

Email thread:
${cleanBody.slice(0, 8000)}`;

  let entries = [];
  try {
    const raw = await callLLM(prompt, { maxTokens: 800 });
    console.log(`[thread-summary] LLM raw (first 300): ${raw.slice(0, 300)}`);

    // Guard: LLM echoed back HTML from the email body
    if (raw.trimStart().startsWith("<")) {
      console.error("[thread-summary] LLM returned HTML instead of JSON — body likely not cleaned properly");
      return res.status(500).json({ error: "Could not parse thread — try again" });
    }

    entries = extractJson(raw);
    if (!Array.isArray(entries)) entries = [];
  } catch (e) {
    console.error(`[thread-summary] LLM/parse error: ${e.message}`);
    return res.status(500).json({ error: "LLM failed to parse thread", detail: e.message });
  }

  console.log(`[thread-summary] extracted ${entries.length} entries`);

  // Cache even empty results to avoid re-running LLM for emails with single messages
  if (entries.length > 0) {
    await pool.query(`UPDATE emails SET thread_summary = $1 WHERE id = $2`, [JSON.stringify(entries), req.params.id]);
  }

  res.json({ entries });
});

router.post("/emails/:id/action", async (req, res) => {
  const { personId } = req.session;
  const { id } = req.params;

  const { rows } = await pool.query(
    `SELECT actioned_at FROM emails WHERE id = $1 AND mailbox_owner_id = $2`,
    [id, personId]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const newValue = rows[0].actioned_at ? null : new Date();
  await pool.query(
    `UPDATE emails SET actioned_at = $1 WHERE id = $2`,
    [newValue, id]
  );

  res.json({ actioned: !!newValue, actioned_at: newValue });
});

// ── Global search ─────────────────────────────────────────────────────────────
router.get("/search", async (req, res) => {
  const { personId } = req.session;
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ emails: [] });

  const { rows } = await pool.query(
    `SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
            e.to_recipients, e.cc_recipients,
            e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
            e.classification_raw, d.name AS department
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.mailbox_owner_id = $1
       AND (e.subject       ILIKE $2
         OR e.from_name     ILIKE $2
         OR e.from_email    ILIKE $2
         OR e.summary       ILIKE $2
         OR e.body_preview  ILIKE $2
         OR e.to_recipients ILIKE $2)
     ORDER BY e.received_at DESC
     LIMIT 50`,
    [personId, `%${q}%`]
  );

  res.json({ emails: rows, query: q });
});

// ── Auto-reply suggestions ─────────────────────────────────────────────────────
router.get("/emails/:id/reply-suggestions", async (req, res) => {
  const { personId } = req.session;

  const { rows } = await pool.query(
    `SELECT subject, from_name, from_email, summary, body_preview
     FROM emails WHERE id = $1 AND mailbox_owner_id = $2`,
    [req.params.id, personId]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const { subject, from_name, summary, body_preview } = rows[0];

  const prompt = `Draft 3 short professional email reply options for this email.
Subject: ${subject}
From: ${from_name}
Context: ${summary || (body_preview || "").slice(0, 200)}

Return ONLY a JSON array of exactly 3 strings (1-2 sentences each), no markdown:
["option 1","option 2","option 3"]

Options should cover: (1) acknowledge + confirm action, (2) request more info / time, (3) polite defer or partial response.`;

  try {
    const raw = await callLLM(prompt, { maxTokens: 300 });
    if (raw.trimStart().startsWith("<")) throw new Error("LLM returned HTML");
    const suggestions = extractJson(raw);
    if (!Array.isArray(suggestions)) throw new Error("Not an array");
    res.json({ suggestions: suggestions.slice(0, 3) });
  } catch (e) {
    console.error(`[reply-suggestions] error: ${e.message}`);
    res.status(500).json({ error: "Could not generate suggestions" });
  }
});

router.get("/scores", async (req, res) => {
  const { personId } = req.session;

  // Department-level stats with thread-gap based avg response
  const { rows: deptRows } = await pool.query(
    `WITH base AS (
       SELECT e.id, e.received_at, e.urgency, e.actioned_at, e.is_critical,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              COALESCE(d.name, 'Unclassified') AS department,
              LOWER(REGEXP_REPLACE(e.subject, '^\s*(re|fw|fwd)\s*:\s*', '', 'gi')) AS base_subject,
              e.from_email
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.mailbox_owner_id = $1
     ),
     thread_gaps AS (
       SELECT e1.department,
              EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
       FROM base e1
       JOIN base e2 ON
         e2.base_subject = e1.base_subject AND
         e2.received_at > e1.received_at AND
         e2.received_at < e1.received_at + INTERVAL '14 days'
       GROUP BY e1.id, e1.department, e1.received_at
     )
     SELECT
       b.department,
       COUNT(*) AS total_emails,
       COUNT(*) FILTER (WHERE b.urgency = 'action_needed') AS action_needed,
       COUNT(*) FILTER (WHERE b.is_escalation) AS escalations,
       COUNT(*) FILTER (WHERE b.is_critical) AS critical,
       ROUND(
         MAX(EXTRACT(EPOCH FROM (now() - b.received_at)) / 3600)
         FILTER (WHERE b.urgency = 'action_needed' AND b.actioned_at IS NULL)
       , 0) AS longest_pending_hours,
       ROUND((SELECT AVG(gap_hours) FROM thread_gaps tg WHERE tg.department = b.department), 1) AS avg_response_hours
     FROM base b
     GROUP BY b.department
     ORDER BY longest_pending_hours DESC NULLS LAST, total_emails DESC`,
    [personId]
  );

  // Derive the logged-in user's domain so scores only cover internal teammates
  const personRow = await pool.query(`SELECT email FROM people WHERE id = $1`, [personId]);
  const ownerDomain = (personRow.rows[0]?.email || "").split("@")[1] || "";

  // Sender-level stats — same domain as the logged-in user only.
  // Avg response time: computed from thread pairs in the inbox.
  // When a sender's email is followed by another email from the same sender with
  // the same base subject (RE: stripped), the gap = one response cycle.
  const { rows: senderRows } = await pool.query(
    `WITH base AS (
       SELECT
         e.id,
         e.from_email,
         e.received_at,
         e.urgency,
         e.actioned_at,
         e.is_critical,
         (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
         LOWER(REGEXP_REPLACE(e.subject, '^\s*(re|fw|fwd)\s*:\s*', '', 'gi')) AS base_subject,
         COALESCE(cm.display_name, e.from_name, e.from_email) AS sender,
         COALESCE(cm.role_label, '') AS role_label,
         COALESCE(cm.department, d.name, '') AS department
       FROM emails e
       LEFT JOIN contact_mappings cm ON LOWER(cm.email) = LOWER(e.from_email)
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.mailbox_owner_id = $1
         AND SPLIT_PART(e.from_email, '@', 2) = $2
     ),
     thread_gaps AS (
       -- Match any follow-up in the same thread (any sender), not just same sender
       SELECT
         e1.from_email,
         EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
       FROM base e1
       JOIN base e2 ON
         e2.base_subject = e1.base_subject AND
         e2.received_at > e1.received_at AND
         e2.received_at < e1.received_at + INTERVAL '14 days'
       GROUP BY e1.id, e1.from_email, e1.received_at
     )
     SELECT
       b.sender,
       b.from_email,
       b.role_label,
       b.department,
       COUNT(*) AS total_emails,
       COUNT(*) FILTER (WHERE b.urgency = 'action_needed') AS action_needed,
       COUNT(*) FILTER (WHERE b.is_escalation) AS escalations,
       COUNT(*) FILTER (WHERE b.is_critical) AS critical,
       ROUND(
         MAX(EXTRACT(EPOCH FROM (now() - b.received_at)) / 3600)
         FILTER (WHERE b.urgency = 'action_needed' AND b.actioned_at IS NULL)
       , 0) AS longest_pending_hours,
       ROUND((SELECT AVG(gap_hours) FROM thread_gaps tg WHERE tg.from_email = b.from_email), 1) AS avg_response_hours
     FROM base b
     GROUP BY b.from_email, b.sender, b.role_label, b.department
     ORDER BY longest_pending_hours DESC NULLS LAST, total_emails DESC`,
    [personId, ownerDomain]
  );

  res.json({ departments: deptRows, senders: senderRows, domain: ownerDomain });
});

router.get("/emails", async (req, res) => {
  const { personId } = req.session;
  const { department } = req.query;

  const params = [personId];
  let departmentFilter = "";
  if (department) {
    params.push(department);
    departmentFilter = `AND d.name = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
            e.to_recipients, e.cc_recipients,
            e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
            d.name AS department, p.display_name AS attributed_to
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN people p ON p.id = e.attributed_person_id
     WHERE e.mailbox_owner_id = $1 ${departmentFilter}
     ORDER BY e.is_critical DESC, e.received_at DESC
     LIMIT 200`,
    params
  );

  res.json({ emails: rows });
});

module.exports = router;
