const axios = require("axios");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Capture the first 2000 chars (context for LLM) + last 1500 chars (where signatures live).
// For short emails this is just the full text.
function extractBodyText(raw) {
  const text = raw.trim();
  const HEAD = 2000;
  const TAIL = 1500;
  if (text.length <= HEAD + TAIL) return text;
  return text.slice(0, HEAD) + "\n…\n" + text.slice(-TAIL);
}

/**
 * Fetches recent messages from a mailbox via Graph API.
 * Uses delta-friendly fields; for Phase 1 we just pull the most recent N,
 * sorted newest first. Later this can be upgraded to Graph's delta query
 * for efficient incremental sync instead of re-fetching a fixed window.
 */
async function fetchRecentMessages(accessToken, { top = 50 } = {}) {
  const select = [
    "id",
    "conversationId",
    "subject",
    "from",
    "toRecipients",
    "ccRecipients",
    "receivedDateTime",
    "body",
  ].join(",");

  const url = `${GRAPH_BASE}/me/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${select}`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  });

  return response.data.value;
}

/**
 * Normalizes a raw Graph message object into the shape our DB/classification
 * pipeline expects, and determines if the mailbox owner was directly addressed
 * (in To:) versus just CC'd.
 */
function normalizeMessage(rawMessage, ownerEmail, ownerAliases = []) {
  const toEmails = (rawMessage.toRecipients || []).map((r) =>
    r.emailAddress.address.toLowerCase()
  );
  const ccEmails = (rawMessage.ccRecipients || []).map((r) =>
    r.emailAddress.address.toLowerCase()
  );

  const allOwnerAddresses = [ownerEmail.toLowerCase(), ...ownerAliases.map((a) => a.toLowerCase())];
  const isDirectToOwner = toEmails.some((e) => allOwnerAddresses.includes(e));

  return {
    graphMessageId: rawMessage.id,
    conversationId: rawMessage.conversationId,
    subject: rawMessage.subject || "",
    fromEmail: rawMessage.from?.emailAddress?.address || "",
    fromName: rawMessage.from?.emailAddress?.name || "",
    toRecipients: toEmails.join(", "),
    ccRecipients: ccEmails.join(", "),
    receivedAt: rawMessage.receivedDateTime,
    isDirectToOwner,
    bodyPreview: extractBodyText(rawMessage.body?.content || rawMessage.bodyPreview || ""),
  };
}

module.exports = { fetchRecentMessages, normalizeMessage };
