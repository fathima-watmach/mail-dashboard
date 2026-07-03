require("dotenv").config();
const pool = require("../db/pool");
const { getValidAccessToken: getMsToken }   = require("./msAuth");
const { getValidAccessToken: getZohoToken } = require("./zohoAuth");
const { fetchRecentMessages: fetchMs, normalizeMessage: normalizeMs } = require("./graphMail");
const { fetchRecentMessages: fetchZoho, normalizeMessage: normalizeZoho } = require("./zohoMail");
const { classifyEmail }   = require("./classifier");
const { attributePerson } = require("./attribution");

async function ingestForPerson(personId, personEmail, provider = "microsoft", zohoAccountId = null, since = null, limit = 100) {
  console.log(`[ingest] Starting for person_id=${personId} (${personEmail}) provider=${provider}`);

  const aliasRow = await pool.query(`SELECT email_aliases FROM people WHERE id = $1`, [personId]);
  let aliases = aliasRow.rows[0]?.email_aliases || [];

  let rawMessages;
  let accessToken;

  if (provider === "zoho") {
    accessToken = await getZohoToken(personId);
    rawMessages = await fetchZoho(accessToken, zohoAccountId, { limit, since });
    console.log(`[ingest] Fetched ${rawMessages.length} messages from Zoho`);
  } else {
    accessToken = await getMsToken(personId);
    rawMessages = await fetchMs(accessToken, { top: 50 });
    console.log(`[ingest] Fetched ${rawMessages.length} messages from Microsoft Graph`);

    // Auto-detect aliases for Microsoft accounts
    const discoveredAliases = new Set(aliases.map((a) => a.toLowerCase()));
    for (const raw of rawMessages) {
      for (const r of raw.toRecipients || []) {
        const addr = r.emailAddress.address.toLowerCase();
        if (addr !== personEmail.toLowerCase() && !discoveredAliases.has(addr)) {
          if ((raw.toRecipients || []).length === 1) {
            discoveredAliases.add(addr);
            console.log(`[ingest] Discovered alias for ${personEmail}: ${addr}`);
          }
        }
      }
    }

    const updatedAliases = Array.from(discoveredAliases);
    if (updatedAliases.length !== aliases.length) {
      await pool.query(`UPDATE people SET email_aliases = $1 WHERE id = $2`, [updatedAliases, personId]);
      aliases = updatedAliases;
      for (const alias of updatedAliases) {
        await pool.query(
          `UPDATE emails SET is_direct_to_owner = true
           WHERE mailbox_owner_id = $1 AND is_direct_to_owner = false AND to_recipients ILIKE $2`,
          [personId, `%${alias}%`]
        );
      }
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let newCount = 0, skippedCount = 0, errorCount = 0;

  for (const raw of rawMessages) {
    let normalized;
    if (provider === "zoho") {
      normalized = await normalizeZoho(raw, accessToken, zohoAccountId, personEmail, aliases);
    } else {
      normalized = normalizeMs(raw, personEmail, aliases);
    }

    // Dedupe on provider message ID (stored in graph_message_id column regardless of provider)
    const existing = await pool.query(
      `SELECT id FROM emails WHERE mailbox_owner_id = $1 AND graph_message_id = $2`,
      [personId, normalized.providerMessageId || normalized.graphMessageId]
    );
    if (existing.rows.length > 0) { skippedCount++; continue; }

    try {
      const classification = await classifyEmail(normalized);

      const departmentRow = await pool.query(
        `SELECT id FROM departments WHERE name = $1`, [classification.department]
      );
      const departmentId = departmentRow.rows[0]?.id || null;

      const attributedPersonId = await attributePerson({
        fromEmail:     normalized.fromEmail,
        toRecipients:  normalized.toRecipients,
        ccRecipients:  normalized.ccRecipients,
        departmentName: classification.department,
      });

      await pool.query(
        `INSERT INTO emails (
          mailbox_owner_id, graph_message_id, conversation_id, subject,
          from_email, from_name, to_recipients, cc_recipients, received_at,
          is_direct_to_owner, body_preview, department_id, urgency,
          attributed_person_id, classified_at, classification_raw,
          is_critical, summary, mail_provider, zoho_folder_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,$17,$18,$19)`,
        [
          personId,
          normalized.providerMessageId || normalized.graphMessageId,
          normalized.conversationId,
          normalized.subject,
          normalized.fromEmail,
          normalized.fromName,
          normalized.toRecipients,
          normalized.ccRecipients,
          normalized.receivedAt,
          normalized.isDirectToOwner,
          normalized.bodyPreview,
          departmentId,
          classification.urgency,
          attributedPersonId,
          JSON.stringify({ reasoning: classification.reasoning, isEscalation: classification.isEscalation, isCritical: classification.isCritical }),
          classification.isCritical,
          classification.summary,
          provider,
          normalized.zohofolderId || null,
        ]
      );
      newCount++;
      await sleep(5000); // 5s between classifications — 12/min, leaves headroom for interactive calls
    } catch (err) {
      errorCount++;
      console.error(`[ingest] Failed for message:`, err.message);
    }
  }

  console.log(`[ingest] Done for ${personEmail}: ${newCount} new, ${skippedCount} skipped, ${errorCount} errors`);
  return { newCount, skippedCount, errorCount };
}

function getFinancialYearStart() {
  const now = new Date();
  // Financial year starts April 1; if we're before April, use previous year
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(fyYear, 3, 1).toISOString(); // April 1 00:00:00
}

async function ingestAll({ historical = false } = {}) {
  // Microsoft accounts
  const { rows: msUsers } = await pool.query(
    `SELECT id, email FROM people WHERE ms_graph_connected = true`
  );

  // Zoho accounts
  const { rows: zohoUsers } = await pool.query(
    `SELECT id, email, zoho_account_id FROM people WHERE zoho_connected = true`
  );

  if (msUsers.length === 0 && zohoUsers.length === 0) {
    console.log("[ingest] No connected mailboxes found.");
    return;
  }

  for (const p of msUsers) {
    try { await ingestForPerson(p.id, p.email, "microsoft"); }
    catch (err) { console.error(`[ingest] MS failure for ${p.email}:`, err.message); }
  }

  // Historical (startup): pull full financial year with higher limit
  // Recurring (cron): pull last 7 days only to avoid re-processing
  const zohoSince = historical
    ? getFinancialYearStart()
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const zohoLimit = historical ? 500 : 100;

  if (historical) {
    console.log(`[ingest] Historical run — fetching Zoho emails since ${zohoSince}`);
  }

  for (const p of zohoUsers) {
    try { await ingestForPerson(p.id, p.email, "zoho", p.zoho_account_id, zohoSince, zohoLimit); }
    catch (err) { console.error(`[ingest] Zoho failure for ${p.email}:`, err.message); }
  }
}

if (require.main === module) {
  ingestAll().then(() => { console.log("[ingest] Manual run complete."); process.exit(0); });
}

module.exports = { ingestForPerson, ingestAll };
