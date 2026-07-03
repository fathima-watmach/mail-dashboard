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

    let classification = null;
    try {
      classification = await classifyEmail(normalized);
    } catch (err) {
      errorCount++;
      console.error(`[ingest] Classification failed for "${normalized.subject}":`, err.message);
    }

    try {
      if (classification) {
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
            normalized.conversationId, normalized.subject,
            normalized.fromEmail, normalized.fromName,
            normalized.toRecipients, normalized.ccRecipients,
            normalized.receivedAt, normalized.isDirectToOwner, normalized.bodyPreview,
            departmentId, classification.urgency, attributedPersonId,
            JSON.stringify({ reasoning: classification.reasoning, isEscalation: classification.isEscalation, isCritical: classification.isCritical }),
            classification.isCritical, classification.summary, provider, normalized.zohofolderId || null,
          ]
        );
        newCount++;
      } else {
        // Save without classification so dedup skips it on next restart;
        // the reclassify cron will fill in the missing fields later
        await pool.query(
          `INSERT INTO emails (
            mailbox_owner_id, graph_message_id, conversation_id, subject,
            from_email, from_name, to_recipients, cc_recipients, received_at,
            is_direct_to_owner, body_preview, mail_provider, zoho_folder_id,
            urgency, is_critical
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'fyi',false)
          ON CONFLICT DO NOTHING`,
          [
            personId,
            normalized.providerMessageId || normalized.graphMessageId,
            normalized.conversationId, normalized.subject,
            normalized.fromEmail, normalized.fromName,
            normalized.toRecipients, normalized.ccRecipients,
            normalized.receivedAt, normalized.isDirectToOwner, normalized.bodyPreview,
            provider, normalized.zohofolderId || null,
          ]
        );
      }
    } catch (insertErr) {
      console.error(`[ingest] DB insert failed:`, insertErr.message);
    }

    // No explicit sleep needed here — geminiQueue enforces 4.2s between every
    // Gemini API call globally (across ingest + thread summaries + reclassify)
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

  for (const p of zohoUsers) {
    try {
      // Historical run only for users with zero emails — prevents hammering the LLM on every restart
      let since, limit;
      if (historical) {
        const { rows } = await pool.query(`SELECT COUNT(*) FROM emails WHERE mailbox_owner_id = $1`, [p.id]);
        const hasEmails = parseInt(rows[0].count, 10) > 0;
        if (hasEmails) {
          since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          limit = 100;
          console.log(`[ingest] ${p.email} already has emails — running 7-day catch-up instead of full historical`);
        } else {
          since = getFinancialYearStart();
          limit = 500;
          console.log(`[ingest] ${p.email} is new — running full financial-year historical ingest since ${since}`);
        }
      } else {
        since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        limit = 100;
      }
      await ingestForPerson(p.id, p.email, "zoho", p.zoho_account_id, since, limit);
    } catch (err) {
      console.error(`[ingest] Zoho failure for ${p.email}:`, err.message);
    }
  }
}

// Slowly reclassify emails that were stored without classification (e.g. due to rate limits)
async function reclassifyUnclassified() {
  const { rows: pending } = await pool.query(
    `SELECT id, mailbox_owner_id, subject, from_name, from_email,
            to_recipients, cc_recipients, is_direct_to_owner, body_preview
     FROM emails
     WHERE classified_at IS NULL AND body_preview IS NOT NULL
     ORDER BY received_at DESC
     LIMIT 10`
  );

  if (pending.length === 0) return;
  console.log(`[reclassify] Found ${pending.length} unclassified emails — processing slowly`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const email of pending) {
    try {
      const classification = await classifyEmail({
        fromName: email.from_name,
        fromEmail: email.from_email,
        subject: email.subject,
        isDirectToOwner: email.is_direct_to_owner,
        bodyPreview: email.body_preview,
      });

      const departmentRow = await pool.query(`SELECT id FROM departments WHERE name = $1`, [classification.department]);
      const departmentId = departmentRow.rows[0]?.id || null;
      const attributedPersonId = await attributePerson({
        fromEmail: email.from_email,
        toRecipients: email.to_recipients,
        ccRecipients: email.cc_recipients,
        departmentName: classification.department,
      });

      await pool.query(
        `UPDATE emails SET
          department_id = $1, urgency = $2, attributed_person_id = $3,
          classified_at = now(), classification_raw = $4,
          is_critical = $5, summary = $6
         WHERE id = $7`,
        [
          departmentId, classification.urgency, attributedPersonId,
          JSON.stringify({ reasoning: classification.reasoning, isEscalation: classification.isEscalation, isCritical: classification.isCritical }),
          classification.isCritical, classification.summary, email.id,
        ]
      );
      console.log(`[reclassify] Classified: "${email.subject}"`);
    } catch (err) {
      console.error(`[reclassify] Failed for email ${email.id}:`, err.message);
    }
    await sleep(6000); // 10/min — safely under Gemini free tier 15 RPM
  }
}

if (require.main === module) {
  ingestAll().then(() => { console.log("[ingest] Manual run complete."); process.exit(0); });
}

module.exports = { ingestForPerson, ingestAll, reclassifyUnclassified };
