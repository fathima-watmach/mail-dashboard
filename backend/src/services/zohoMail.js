const axios = require("axios");

const MAIL_BASE = "https://mail.zoho.com/api";

function authHeader(accessToken) {
  return { Authorization: `Zoho-oauthtoken ${accessToken}` };
}

function decodeHtml(str) {
  return (str || "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Capture HEAD + TAIL so signatures (at the end) are always included
function extractBodyText(raw) {
  const text = (raw || "").trim();
  const HEAD = 2000, TAIL = 1500;
  if (text.length <= HEAD + TAIL) return text;
  return text.slice(0, HEAD) + "\n…\n" + text.slice(-TAIL);
}

/**
 * Fetches the Zoho account ID for the authenticated user.
 * Zoho requires an accountId for all mail API calls.
 */
async function getAccountId(accessToken) {
  const { data } = await axios.get(`${MAIL_BASE}/accounts`, {
    headers: authHeader(accessToken),
  });
  const account = data.data?.[0];
  if (!account) throw new Error("No Zoho mail account found for this token");
  // emailAddress is an array of objects; find the primary one
  const primaryEmail = Array.isArray(account.emailAddress)
    ? account.emailAddress.find((e) => e.isPrimary)?.mailId
    : account.emailAddress;
  const email = (primaryEmail || account.incomingUserName || "").toLowerCase();
  return { accountId: account.accountId, email };
}

/**
 * Fetches messages from Zoho Mail, optionally filtered to on/after `since` (ISO date string).
 * Zoho doesn't support server-side date filtering, so we fetch in pages and stop
 * once we hit messages older than the cutoff.
 */
/**
 * Fetches messages from Zoho Mail, optionally filtered to on/after `since` (ISO date string).
 * Zoho defaults to newest-first. We paginate and skip messages older than the cutoff.
 */
async function fetchRecentMessages(accessToken, accountId, { limit = 100, since = null } = {}) {
  const sinceMs  = since ? new Date(since).getTime() : null;
  const pageSize = 50;
  const results  = [];
  let start      = 0;

  while (results.length < limit) {
    const { data } = await axios.get(
      `${MAIL_BASE}/accounts/${accountId}/messages/view`,
      {
        params: { limit: pageSize, start }, // default order is newest-first
        headers: authHeader(accessToken),
      }
    );
    const page = data.data || [];
    if (page.length === 0) break;

    let hitCutoff = false;
    for (const msg of page) {
      const msgTime = Number(msg.receivedTime);
      if (sinceMs && msgTime < sinceMs) {
        hitCutoff = true;
        break; // remaining messages in this page (and beyond) are older
      }
      results.push(msg);
      if (results.length >= limit) return results;
    }

    if (hitCutoff || page.length < pageSize) break;
    start += pageSize;
  }

  return results;
}

/**
 * Fetches the HTML/text body of a single Zoho message.
 * Requires folderId (returned with each message in messages/view).
 */
async function fetchMessageBody(accessToken, accountId, messageId, folderId) {
  try {
    const url = folderId
      ? `${MAIL_BASE}/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`
      : `${MAIL_BASE}/accounts/${accountId}/messages/${messageId}/content`;
    const { data } = await axios.get(url, { headers: authHeader(accessToken) });
    return data.data?.content || "";
  } catch (_) {
    return "";
  }
}

/**
 * Normalises a raw Zoho message into the same shape our DB/classification pipeline expects.
 * Zoho delivers comma-separated to/cc address strings rather than arrays.
 */
async function normalizeMessage(raw, accessToken, accountId, ownerEmail, ownerAliases = []) {
  const toStr  = decodeHtml(raw.toAddress  || "");
  const ccStr  = decodeHtml(raw.ccAddress  || "");

  // Extract bare email addresses from "Name <email>" or plain "email" strings
  const extractEmails = (str) =>
    [...str.matchAll(/<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g)]
      .map((m) => (m[1] || m[2]).toLowerCase())
      .filter(Boolean);

  const toEmails = extractEmails(toStr);
  const ccEmails = extractEmails(ccStr);

  const allOwnerAddresses = [ownerEmail.toLowerCase(), ...ownerAliases.map((a) => a.toLowerCase())];
  const isDirectToOwner   = toEmails.some((e) => allOwnerAddresses.includes(e));

  // Fetch full body for classification + signature extraction
  // folderId is required by Zoho's content API
  const rawBody  = await fetchMessageBody(accessToken, accountId, raw.messageId, raw.folderId);
  // Fall back to Zoho's own summary field if content fetch fails
  const bodyText = extractBodyText(
    rawBody || (raw.summary ? raw.summary.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "")
  );

  const fromDecoded = decodeHtml(raw.fromAddress || "");
  return {
    providerMessageId: raw.messageId,
    conversationId:    raw.threadId || raw.messageId,
    subject:           raw.subject  || "",
    fromEmail:         fromDecoded.match(/<([^>]+)>/)?.[1]?.toLowerCase()
                       || fromDecoded.toLowerCase(),
    fromName:          fromDecoded.match(/^([^<]+)</)?.[1]?.replace(/"/g, "").trim() || "",
    toRecipients:      toEmails.join(", "),
    ccRecipients:      ccEmails.join(", "),
    receivedAt:        raw.receivedTime ? new Date(Number(raw.receivedTime)).toISOString() : new Date().toISOString(),
    isDirectToOwner,
    bodyPreview:       bodyText,
    zohofolderId:      raw.folderId || null,
  };
}

/**
 * Sends a reply to a Zoho Mail message.
 */
async function sendReply(accessToken, accountId, { origMessageId, fromAddress, text, replyAll = false, cc = [] }) {
  const payload = {
    fromAddress,
    action:     replyAll ? "replyall" : "reply",
    origMsgId:  origMessageId,
    content:    text,
    mailFormat: "plaintext",
  };
  if (cc.length > 0) payload.ccAddress = cc.join(", ");

  const { data } = await axios.post(
    `${MAIL_BASE}/accounts/${accountId}/messages`,
    payload,
    { headers: { ...authHeader(accessToken), "Content-Type": "application/json" } }
  );
  return data;
}

/**
 * Fetches sent emails from the Sent folder and matches them to received emails
 * by conversationId, then populates first_reply_at on matched emails.
 */
async function syncSentReplies(accessToken, accountId, sentFolderId, personId, pool) {
  const pageSize = 50;
  let start = 0;
  let matched = 0;

  // Get the set of conversation IDs we have in the inbox so we only process relevant ones
  const { rows: convRows } = await pool.query(
    `SELECT conversation_id, id, received_at FROM emails
     WHERE mailbox_owner_id = $1 AND first_reply_at IS NULL
     ORDER BY received_at`,
    [personId]
  );
  if (convRows.length === 0) return 0;

  // Build a map: conversationId → { id, received_at }
  const convMap = new Map();
  for (const row of convRows) {
    if (!convMap.has(row.conversation_id)) convMap.set(row.conversation_id, row);
  }

  while (true) {
    const { data } = await axios.get(
      `${MAIL_BASE}/accounts/${accountId}/messages/view`,
      { params: { folderId: sentFolderId, limit: pageSize, start }, headers: authHeader(accessToken) }
    );
    const page = data.data || [];
    if (page.length === 0) break;

    for (const msg of page) {
      const threadId = msg.threadId || msg.messageId;
      const received = convMap.get(threadId);
      if (!received) continue;

      const sentMs = Number(msg.sentDateInGMT || msg.receivedTime);
      const sentAt = new Date(sentMs);
      // Only set if sent AFTER the received email
      if (sentAt > new Date(received.received_at)) {
        await pool.query(
          `UPDATE emails SET first_reply_at = $1 WHERE id = $2 AND (first_reply_at IS NULL OR first_reply_at > $1)`,
          [sentAt.toISOString(), received.id]
        );
        convMap.delete(threadId); // don't overwrite with a later reply
        matched++;
      }
    }

    if (page.length < pageSize) break;
    start += pageSize;
  }

  return matched;
}

module.exports = { getAccountId, fetchRecentMessages, normalizeMessage, sendReply, syncSentReplies };
