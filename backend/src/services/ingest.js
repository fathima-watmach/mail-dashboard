require("dotenv").config();
const pool = require("../db/pool");
const { getValidAccessToken: getMsToken }   = require("./msAuth");
const { getValidAccessToken: getZohoToken } = require("./zohoAuth");
const { fetchRecentMessages: fetchMs, fetchThreadMessages, normalizeMessage: normalizeMs, fetchInlineImages, listFoldersToScan } = require("./graphMail");
const { fetchRecentMessages: fetchZoho, normalizeMessage: normalizeZoho } = require("./zohoMail");
const { classifyEmail }   = require("./classifier");
const { attributePerson } = require("./attribution");
const { resolveMailboxAccess } = require("./mailboxAccess");
const { extractHandler, matchRoster, matchRosterByName } = require("./signatureParser");
const { matchRosterFromImage } = require("./signatureOcr");
const { matchProperty } = require("./propertyMatcher");
const { matchCustomer } = require("./customerMatcher");

async function ingestForPerson(personId, personEmail, provider = "microsoft", zohoAccountId = null, since = null, limit = 100, until = null, skipClassification = false) {
  console.log(`[ingest] Starting for person_id=${personId} (${personEmail}) provider=${provider}`);

  const personRow = await pool.query(
    `SELECT email_aliases, is_shared_inbox, client_id, coordinator_roster FROM people WHERE id = $1`, [personId]
  );
  let aliases = personRow.rows[0]?.email_aliases || [];
  const isSharedInbox = personRow.rows[0]?.is_shared_inbox || false;
  const clientId = personRow.rows[0]?.client_id;
  const coordinatorRoster = personRow.rows[0]?.coordinator_roster || [];

  // Department/category taxonomy is per-client — different clients run entirely
  // different businesses, so each resolves its own list at classification time.
  const departmentRows = await pool.query(`SELECT id, name FROM departments WHERE client_id = $1`, [clientId]);
  const departmentNames = departmentRows.rows.map((r) => r.name);
  const departmentNameToId = Object.fromEntries(departmentRows.rows.map((r) => [r.name, r.id]));

  let rawMessages;
  let accessToken;
  let mailboxTarget = null;

  if (provider === "zoho") {
    accessToken = await getZohoToken(personId);
    rawMessages = await fetchZoho(accessToken, zohoAccountId, { limit, since });
    console.log(`[ingest] Fetched ${rawMessages.length} messages from Zoho`);
  } else {
    // resolveMailboxAccess picks up the delegate's token + the shared inbox's own
    // address for mailboxes reached via Full Access delegation (e.g. contactus@,
    // info@) — a normal self-owned mailbox just gets its own token back with no target.
    ({ accessToken, mailboxTarget } = await resolveMailboxAccess(personId));

    // Fetch per-folder, not one mailbox-wide top-N query — a real high-volume
    // mailbox (Outlook rules auto-filing incoming mail into 20+ named
    // subfolders) starved the root Inbox down to 0% coverage under the old
    // single-query approach: a global "top N most recent" ranking gets
    // dominated by whichever folder has the highest message velocity. Each
    // folder now gets its own `limit`-sized budget, so a quiet folder can
    // never be crowded out by a busy one. See listFoldersToScan()'s comment.
    const folders = await listFoldersToScan(accessToken, mailboxTarget);
    rawMessages = [];
    for (const folder of folders) {
      const folderMessages = await fetchMs(accessToken, { top: limit, mailboxTarget, since, until, folderId: folder.id });
      if (folderMessages.length > 0) {
        console.log(`[ingest]   "${folder.name}": ${folderMessages.length} messages`);
      }
      rawMessages.push(...folderMessages);
    }
    console.log(`[ingest] Fetched ${rawMessages.length} messages total from Microsoft Graph across ${folders.length} folders${mailboxTarget ? ` (delegated: ${mailboxTarget})` : ""}${since ? ` since ${since}` : ""}${until ? ` until ${until}` : ""}`);

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
  // Threads touched by a genuinely NEW message this run — see the full
  // thread-history backfill after the main loop below for why.
  const touchedConversationIds = new Set();

  // Normalizes one raw message and checks the dedupe key — returns null if
  // it already exists (nothing more to do), otherwise the normalized
  // message. Split out from the old combined processRawMessage so callers
  // can group several normalized messages from the SAME conversation before
  // deciding how many times to actually call the classifier — see
  // classifyBatch below for why that grouping matters.
  async function normalizeAndCheckNew(raw) {
    let normalized;
    if (provider === "zoho") {
      normalized = await normalizeZoho(raw, accessToken, zohoAccountId, personEmail, aliases);
    } else {
      normalized = normalizeMs(raw, personEmail, aliases);
    }

    // Dedupe on provider message ID (stored in graph_message_id column
    // regardless of provider). Real failure hit 2026-09-05: a bare
    // `ETIMEDOUT`/`ENOTFOUND` on this exact query (a transient network/DNS
    // blip against Supabase, not a code bug) was uncaught and crashed the
    // ENTIRE multi-thousand-message pull outright, losing all progress. A
    // single 2s retry turned out to not be enough either — real observed
    // blips lasted long enough that dozens of consecutive messages in a row
    // all failed and got skipped, silently losing most of a run. Now
    // retries up to 4 times with a longer, growing backoff (5s/10s/20s)
    // before finally giving up on just this one message.
    let existing;
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        existing = await pool.query(
          `SELECT id FROM emails WHERE mailbox_owner_id = $1 AND graph_message_id = $2`,
          [personId, normalized.providerMessageId || normalized.graphMessageId]
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 4) {
          const wait = 5000 * attempt;
          console.error(`[ingest] Dedupe check failed (attempt ${attempt}/4) for "${normalized.subject}": ${err.message} — retrying in ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    if (lastErr) {
      console.error(`[ingest] Dedupe check failed 4 times, skipping this message:`, lastErr.message);
      errorCount++;
      return null;
    }
    if (existing.rows.length > 0) { skippedCount++; return null; }

    if (normalized.conversationId) touchedConversationIds.add(normalized.conversationId);
    return normalized;
  }

  // Finalizes ONE already-normalized, already-new message: handledBy
  // extraction, property/customer matching, attribution, and the INSERT —
  // everything that's genuinely per-message. `classification` is passed in
  // rather than computed here, since it may be shared across an entire
  // batch of same-thread messages (see classifyBatch/processBatch below).
  async function finalizeMessage(normalized, classification) {
    // For shared inboxes (contactus@, maintenance@), an OUTGOING message is
    // identified by domain, not exact address — real bug fixed 2026-09-05:
    // this used to require the sender to be LITERALLY contactus@/
    // maintenance@ itself, so a coordinator replying from their own
    // personal @sariahfm.com address (e.g. sineesh@, support@) was never
    // even considered an outgoing reply at all — not just unattributed, but
    // invisible to handled_by_name extraction entirely. Same domain as the
    // shared inbox's own address is a safe, exact signal here (it's the
    // company's own domain, not a shared external one), matching the same
    // fix applied to every "did Sariah reply" check in dashboard.js.
    // Incoming customer emails carry the customer's signature, not staff,
    // so leave those unset.
    let handledBy = null;
    const sameDomainAsMailbox = normalized.fromEmail &&
      normalized.fromEmail.split("@")[1]?.toLowerCase() === personEmail.split("@")[1]?.toLowerCase();
    if (isSharedInbox && sameDomainAsMailbox) {
      // Try the sender's own display name against the roster FIRST — a
      // structured, always-present signal (unlike a body-text signature,
      // which many real signoffs never carry as selectable text at all).
      if (coordinatorRoster.length > 0) {
        handledBy = matchRosterByName(normalized.fromName, coordinatorRoster);
      }

      // When a roster IS configured, trust ONLY matchRoster/matchRosterByName
      // — a known, closed list. The generic extractHandler() fallback was
      // found misattributing real outgoing messages to people who are NOT
      // in the roster (e.g. a quoted/forwarded earlier participant's own
      // signature elsewhere in the captured body), which directly conflicts
      // with Phase 1 scoping to a known set of coordinators: a wrong name is
      // worse than an honest null. extractHandler stays as the fallback
      // only for shared inboxes with NO roster configured at all.
      if (!handledBy) {
        handledBy = coordinatorRoster.length > 0
          ? matchRoster(normalized.bodyPreview, coordinatorRoster)
          : extractHandler(normalized.bodyPreview);
      }

      // Many real signatures are a single flattened image (logo + name baked
      // into the pixels, not selectable text) — confirmed by direct
      // inspection that neither Graph's plain-text nor raw-HTML body ever
      // contains the name in that case, so matchRoster() above can never
      // find it. Only worth the extra Graph attachments call + Gemini vision
      // call when the free text match already failed and there's a roster
      // to match against; MS-only (Zoho's inline-attachment shape differs
      // and isn't wired up here). Real gap found 2026-09-05: this is a
      // Gemini call independent of classifyEmail — skipClassification alone
      // didn't stop it, so it needs its own explicit guard here too.
      if (!handledBy && coordinatorRoster.length > 0 && provider !== "zoho" && !skipClassification) {
        try {
          const images = await fetchInlineImages(accessToken, normalized.graphMessageId, { mailboxTarget });
          for (const img of images) {
            handledBy = await matchRosterFromImage(img.contentBytes, img.contentType, coordinatorRoster);
            if (handledBy) break;
          }
        } catch (ocrErr) {
          console.error(`[ingest] Signature-image OCR failed for "${normalized.subject}":`, ocrErr.message);
        }
      }
    }

    // Cheap regex match against the property register (Client_List.xlsx
    // import) — independent of classification, so an unclassified email
    // still gets grouped by property once this resolves. See
    // propertyMatcher.js for the real coverage numbers behind this. Tiers
    // 1-3 are free (regex/DB only); tier 4 (semantic) calls Gemini
    // embeddings, so it's skipped too under skipClassification — same
    // real gap as the OCR fallback above, found 2026-09-05.
    const { propertyId, method: propertyMatchMethod } = await matchProperty(
      { subject: normalized.subject, bodyPreview: normalized.bodyPreview, conversationId: normalized.conversationId },
      clientId,
      { skipSemantic: skipClassification }
    );

    // customer_name_hint is set whenever we know the CLIENT, whether from
    // the exact property match above (most precise) or, failing that, a
    // known sender on the thread (customerMatcher.js — coarser, doesn't
    // pinpoint a property, but still real).
    let customerNameHint = null;
    if (propertyId) {
      const propRow = await pool.query(`SELECT customer_name FROM properties WHERE id = $1`, [propertyId]);
      customerNameHint = propRow.rows[0]?.customer_name || null;
    } else {
      customerNameHint = await matchCustomer(
        { fromEmail: normalized.fromEmail, toRecipients: normalized.toRecipients, ccRecipients: normalized.ccRecipients },
        clientId
      );
    }

    try {
      if (classification) {
        const departmentId = departmentNameToId[classification.department] || null;
        const attributedPersonId = await attributePerson({
          fromEmail:     normalized.fromEmail,
          toRecipients:  normalized.toRecipients,
          ccRecipients:  normalized.ccRecipients,
          departmentName: classification.department,
        });
        await pool.query(
          `INSERT INTO emails (
            mailbox_owner_id, graph_message_id, conversation_id, internet_message_id, subject,
            from_email, from_name, to_recipients, cc_recipients, received_at,
            is_direct_to_owner, body_preview, department_id, urgency,
            attributed_person_id, classified_at, classification_raw,
            is_critical, summary, mail_provider, zoho_folder_id,
            handled_by_name, handled_by_role, severity, confidence, property_id, customer_name_hint, property_match_method,
            meeting_date, meeting_time, meeting_title, meeting_details,
            action_deadline_date, action_deadline_title, action_deadline_details
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
          [
            personId,
            normalized.providerMessageId || normalized.graphMessageId,
            normalized.conversationId, normalized.internetMessageId || null, normalized.subject,
            normalized.fromEmail, normalized.fromName,
            normalized.toRecipients, normalized.ccRecipients,
            normalized.receivedAt, normalized.isDirectToOwner, normalized.bodyPreview,
            departmentId, classification.urgency, attributedPersonId,
            JSON.stringify({ reasoning: classification.reasoning, isEscalation: classification.isEscalation, isCritical: classification.isCritical }),
            classification.isCritical, classification.summary, provider, normalized.zohofolderId || null,
            handledBy?.name || null, handledBy?.role || null,
            classification.severity || null, classification.confidence, propertyId, customerNameHint, propertyMatchMethod,
            classification.meetingDate, classification.meetingTime, classification.meetingTitle,
            JSON.stringify(classification.meetingDate ? { date: classification.meetingDate, time: classification.meetingTime, title: classification.meetingTitle } : {}),
            classification.deadlineDate, classification.deadlineTitle,
            classification.deadlineDate ? JSON.stringify({ action: classification.deadlineAction }) : null,
          ]
        );
        newCount++;
      } else {
        // Save without classification so dedup skips it on next restart;
        // the reclassify cron will fill in the missing fields later
        await pool.query(
          `INSERT INTO emails (
            mailbox_owner_id, graph_message_id, conversation_id, internet_message_id, subject,
            from_email, from_name, to_recipients, cc_recipients, received_at,
            is_direct_to_owner, body_preview, mail_provider, zoho_folder_id,
            urgency, is_critical, handled_by_name, handled_by_role, property_id, customer_name_hint, property_match_method
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'fyi',false,$15,$16,$17,$18,$19)
          ON CONFLICT DO NOTHING`,
          [
            personId,
            normalized.providerMessageId || normalized.graphMessageId,
            normalized.conversationId, normalized.internetMessageId || null, normalized.subject,
            normalized.fromEmail, normalized.fromName,
            normalized.toRecipients, normalized.ccRecipients,
            normalized.receivedAt, normalized.isDirectToOwner, normalized.bodyPreview,
            provider, normalized.zohofolderId || null,
            handledBy?.name || null, handledBy?.role || null, propertyId, customerNameHint, propertyMatchMethod,
          ]
        );
      }
    } catch (insertErr) {
      console.error(`[ingest] DB insert failed:`, insertErr.message);
    }

    // No explicit sleep needed here — geminiQueue enforces 4.2s between every
    // Gemini API call globally (across ingest + thread summaries + reclassify)
  }

  // skipClassification lets a deliberate raw-pull backfill (e.g. "pull
  // Aug 1 onward but hold off classifying, corrections are still coming")
  // reuse the exact same unclassified-insert path already used for a real
  // LLM failure below — these rows sit with classified_at IS NULL until a
  // manual reclassify run picks them up later, same as any other
  // unclassified email.
  async function classifyOnce(normalized) {
    if (skipClassification) return null;
    try {
      return await classifyEmail(normalized, departmentNames, clientId);
    } catch (err) {
      errorCount++;
      console.error(`[ingest] Classification failed for "${normalized.subject}":`, err.message);
      return null;
    }
  }

  // Real gap found 2026-09-05 ("one email group, one call"): the thread
  // backfill below fetches a conversation's ENTIRE message history, and the
  // old code called classifyEmail() separately for EVERY message in it —
  // a 10-message thread being ingested for the first time meant 10 Gemini
  // calls for what's genuinely one case, each one re-reading most of the
  // same quoted trail the last call already saw. Now: normalize + dedupe
  // every raw message first, group the genuinely-new ones by conversation,
  // and classify ONCE per group.
  //
  // The one call is given a SYNTHETIC combined body — every message in the
  // group concatenated in chronological order, not just the latest one's
  // own text. Deliberately not "just use the latest message" (it usually
  // quotes everything earlier, but not always — a real, already-hit gap
  // this session: some genuine replies don't quote the trail at all, which
  // is exactly why hasNcrInThread/matchProperty's thread-wide DB fallbacks
  // exist in the first place. None of THIS group's messages are in the DB
  // yet when classification runs, so those fallbacks can't see them either
  // — the concatenation is what keeps the single call as fully-informed as
  // 10 separate calls would have been. classifier.js's own prompt-time
  // truncation (50000 chars) still applies on top of this as the final
  // safety bound. The shared result is applied to every message in the
  // group; only handledBy/property/attribution stay genuinely per-message,
  // since those actually do vary message-to-message and cost nothing to
  // compute individually.
  async function processBatch(rawList) {
    const byConversation = new Map();
    const solo = [];
    for (const raw of rawList) {
      const normalized = await normalizeAndCheckNew(raw);
      if (!normalized) continue;
      if (!normalized.conversationId) { solo.push(normalized); continue; }
      if (!byConversation.has(normalized.conversationId)) byConversation.set(normalized.conversationId, []);
      byConversation.get(normalized.conversationId).push(normalized);
    }

    const groups = [...byConversation.values(), ...solo.map((n) => [n])];
    for (const group of groups) {
      group.sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
      const representative = group[group.length - 1];
      const combinedBody = group.length === 1
        ? representative.bodyPreview
        : group.map((m) =>
            `--- ${m.receivedAt?.toISOString?.() || m.receivedAt} from ${m.fromName || m.fromEmail} ---\n${m.bodyPreview || ""}`
          ).join("\n\n");
      const classification = await classifyOnce({ ...representative, bodyPreview: combinedBody });
      for (const normalized of group) {
        await finalizeMessage(normalized, classification);
      }
    }
  }

  await processBatch(rawMessages);

  // Full thread-history backfill — Microsoft only. Zoho's API doesn't have a
  // confirmed equivalent to Graph's conversationId filter; rather than guess
  // at an unverified endpoint, this is skipped for Zoho for now (same
  // quoted-reply-only behavior as before for that provider, not a
  // regression). For every thread that got a genuinely NEW message this
  // run, fetch its ENTIRE history regardless of date and process it as one
  // batch — already-seen messages skip instantly via the dedupe check
  // inside processBatch, so this only does real work (and at most one
  // classification call) for messages we've never had, however old they are.
  if (provider !== "zoho" && touchedConversationIds.size > 0) {
    console.log(`[ingest] Backfilling full thread history for ${touchedConversationIds.size} thread(s)...`);
    for (const conversationId of touchedConversationIds) {
      try {
        const threadMessages = await fetchThreadMessages(accessToken, conversationId, { mailboxTarget });
        await processBatch(threadMessages);
      } catch (err) {
        console.error(`[ingest] Thread backfill failed for conversation ${conversationId}:`, err.message);
      }
    }
  }

  // A thread previously marked "resolved" that then receives a genuinely new
  // message has clearly reopened — flip it immediately and for free (no LLM
  // call) rather than waiting for someone to happen to reopen that thread's
  // summary in the UI. The narrative text itself stays as-is until a user
  // explicitly regenerates it (existing refresh flow in threadTracking.js) —
  // only the status changes here.
  if (touchedConversationIds.size > 0) {
    await pool.query(
      `UPDATE thread_summaries SET status = 'reopened', generated_at = now()
       WHERE mailbox_owner_id = $1 AND conversation_id = ANY($2::text[]) AND status = 'resolved'`,
      [personId, Array.from(touchedConversationIds)]
    );

    // Daily status-trend snapshot — free (no LLM call): just records
    // whatever status is ALREADY cached (including the reopened flip just
    // above) for today, for any touched thread that has one. Threads never
    // opened in the UI (no thread_summaries row yet) simply don't get a
    // snapshot — this only tracks status for threads someone has actually
    // looked at, same coverage caveat as thread_summaries itself.
    await pool.query(
      `INSERT INTO thread_status_daily (mailbox_owner_id, conversation_id, day, status)
       SELECT mailbox_owner_id, conversation_id, CURRENT_DATE, status
       FROM thread_summaries
       WHERE mailbox_owner_id = $1 AND conversation_id = ANY($2::text[])
       ON CONFLICT (mailbox_owner_id, conversation_id, day) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [personId, Array.from(touchedConversationIds)]
    );
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

// TEMPORARILY set 2026-09-05 at the user's explicit request: Sariah
// (client_id=8) classification corrections are still in progress, and the
// regular hourly/startup ingest cron was found still classifying Sariah's
// new incoming mail normally the whole time — a real gap, since neither
// the disabled reclassify cron nor the manual Aug-1 skip-classification
// pull touch this path at all. Scoped to just this one client so other
// clients' normal ingest+classify isn't affected. Remove once corrections
// are done and Sariah should go back to classifying normally on ingest.
const SARIAH_CLASSIFICATION_PAUSED_CLIENT_ID = 8;

async function ingestAll({ historical = false } = {}) {
  // Microsoft accounts — includes both self-connected mailboxes and shared/delegated
  // inboxes (is_shared_inbox = true). A shared inbox never logs in itself, so
  // ms_graph_connected is always false for it; it only becomes reachable once its
  // delegate (delegate_via_person_id) has a working connection. ingestForPerson
  // already resolves delegated access via resolveMailboxAccess() — this query just
  // needs to stop excluding those rows from the loop that calls it.
  // include_own_mailbox=false excludes a person's OWN inbox from ingestion
  // (e.g. a CEO/admin login whose personal mailbox isn't an operational
  // triage mailbox) without touching their usability as a shared-inbox
  // DELEGATE — the second OR-branch below intentionally checks only
  // d.ms_graph_connected, not d.include_own_mailbox, so a shared inbox stays
  // ingestable even when its delegate's own mailbox is excluded.
  const { rows: msUsers } = await pool.query(
    `SELECT p.id, p.email, p.client_id
     FROM people p
     LEFT JOIN people d ON p.delegate_via_person_id = d.id
     WHERE (p.ms_graph_connected = true AND p.include_own_mailbox = true)
        OR (p.is_shared_inbox = true AND d.ms_graph_connected = true)`
  );

  // Zoho accounts
  const { rows: zohoUsers } = await pool.query(
    `SELECT id, email, zoho_account_id FROM people WHERE zoho_connected = true AND include_own_mailbox = true`
  );

  if (msUsers.length === 0 && zohoUsers.length === 0) {
    console.log("[ingest] No connected mailboxes found.");
    return;
  }

  for (const p of msUsers) {
    try {
      // Historical run only for mailboxes with zero emails — prevents hammering
      // the LLM on every restart. A brand-new mailbox pulls the last 1 month
      // (client-requested default for an initial pilot); an existing one just
      // gets a 7-day catch-up, same as the regular hourly cron.
      let since, limit;
      if (historical) {
        const { rows } = await pool.query(`SELECT COUNT(*) FROM emails WHERE mailbox_owner_id = $1`, [p.id]);
        const hasEmails = parseInt(rows[0].count, 10) > 0;
        if (hasEmails) {
          since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          // 100 undercounts real volume even at 7 days — several of contactus@'s
          // real folders (Inbox, Sent Items, SINEESH, SARIAH-FM, ASTECO
          // COMMON, MAINTENANCE) hit that cap within a week. Per-folder now,
          // so this can afford real headroom without inflating cost for
          // quieter mailboxes/folders (each folder's own `since` filter
          // still bounds it to real recent volume, not a flat 300 fetched
          // regardless).
          limit = 300;
          console.log(`[ingest] ${p.email} already has emails — running 7-day catch-up instead of full historical`);
        } else {
          since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          // Per-folder budget now (see ingestForPerson), not mailbox-wide —
          // a real high-volume mailbox showed 900+ messages in just the root
          // Inbox alone within 30 days, so this needs real headroom per
          // folder, not the old shared 500 that one busy folder could eat.
          limit = 3000;
          console.log(`[ingest] ${p.email} is new — running 1-month historical ingest since ${since}`);
        }
      } else {
        since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        limit = 300;
      }
      const skipClassification = p.client_id === SARIAH_CLASSIFICATION_PAUSED_CLIENT_ID;
      await ingestForPerson(p.id, p.email, "microsoft", null, since, limit, null, skipClassification);
    } catch (err) { console.error(`[ingest] MS failure for ${p.email}:`, err.message); }
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
async function reclassifyUnclassified({ limit = 10 } = {}) {
  const { rows: pending } = await pool.query(
    `SELECT id, mailbox_owner_id, subject, from_name, from_email, conversation_id,
            to_recipients, cc_recipients, is_direct_to_owner, body_preview
     FROM emails
     WHERE classified_at IS NULL AND body_preview IS NOT NULL
     ORDER BY received_at DESC
     LIMIT $1`,
    [limit]
  );

  if (pending.length === 0) return;
  console.log(`[reclassify] Found ${pending.length} unclassified emails`);

  // Same "one email group, one call" fix as ingest.js's processBatch —
  // needed here too, since this is the function that will actually
  // classify a large skip-classification backfill (e.g. Sariah's Aug 1
  // pull) once someone runs it. Grouping by (mailbox, conversation) means a
  // whole thread of still-pending messages gets ONE classification call,
  // not one per message.
  const byConversation = new Map();
  const solo = [];
  for (const email of pending) {
    if (!email.conversation_id) { solo.push(email); continue; }
    const key = `${email.mailbox_owner_id}:${email.conversation_id}`;
    if (!byConversation.has(key)) byConversation.set(key, []);
    byConversation.get(key).push(email);
  }
  const groups = [...byConversation.values(), ...solo.map((e) => [e])];

  for (const group of groups) {
    const first = group[0];
    try {
      const ownerRow = await pool.query(`SELECT client_id FROM people WHERE id = $1`, [first.mailbox_owner_id]);
      const clientId = ownerRow.rows[0]?.client_id;
      const departmentRows = await pool.query(
        `SELECT id, name FROM departments WHERE client_id = $1`, [clientId]
      );
      const departmentNames = departmentRows.rows.map((r) => r.name);
      const departmentNameToId = Object.fromEntries(departmentRows.rows.map((r) => [r.name, r.id]));

      // Pull EVERY message in this conversation (not just the still-pending
      // ones) so the one call sees the whole thread's context, same reason
      // ingest.js's processBatch concatenates rather than trusting the
      // latest message alone to already quote everything earlier.
      let combinedBody, representative;
      if (first.conversation_id) {
        const { rows: threadRows } = await pool.query(
          `SELECT subject, from_name, from_email, body_preview, received_at, is_direct_to_owner
           FROM emails WHERE mailbox_owner_id = $1 AND conversation_id = $2 ORDER BY received_at`,
          [first.mailbox_owner_id, first.conversation_id]
        );
        representative = threadRows[threadRows.length - 1];
        combinedBody = threadRows.length === 1
          ? representative.body_preview
          : threadRows.map((m) =>
              `--- ${m.received_at.toISOString()} from ${m.from_name || m.from_email} ---\n${m.body_preview || ""}`
            ).join("\n\n");
      } else {
        representative = first;
        combinedBody = first.body_preview;
      }

      const classification = await classifyEmail({
        fromName: representative.from_name,
        fromEmail: representative.from_email,
        subject: representative.subject,
        isDirectToOwner: representative.is_direct_to_owner,
        bodyPreview: combinedBody,
        conversationId: first.conversation_id,
      }, departmentNames, clientId);

      const departmentId = departmentNameToId[classification.department] || null;

      for (const email of group) {
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
            is_critical = $5, summary = $6, severity = $7, confidence = $8
           WHERE id = $9`,
          [
            departmentId, classification.urgency, attributedPersonId,
            JSON.stringify({ reasoning: classification.reasoning, isEscalation: classification.isEscalation, isCritical: classification.isCritical }),
            classification.isCritical, classification.summary,
            classification.severity || null, classification.confidence, email.id,
          ]
        );
        console.log(`[reclassify] Classified: "${email.subject}"`);
      }
    } catch (err) {
      console.error(`[reclassify] Failed for group (conversation ${first.conversation_id}):`, err.message);
    }
    // No extra sleep here — llmQueue.js already paces every real Gemini call
    // centrally (see its own comment for the current rate). This used to
    // have its own hardcoded 6s-per-email sleep on top of that, a leftover
    // from the free-tier era that silently dominated over llmQueue's pacing
    // and made this loop run at 10/min regardless of the queue's real speed.
  }
}

if (require.main === module) {
  ingestAll().then(() => { console.log("[ingest] Manual run complete."); process.exit(0); });
}

module.exports = { ingestForPerson, ingestAll, reclassifyUnclassified };
