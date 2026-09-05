const axios = require("axios");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Returns the Graph API base path for a mailbox: the caller's own mailbox
 * ("/me") by default, or a shared mailbox reached via delegated access
 * ("/users/{mailboxTarget}") when one is given.
 */
function graphBaseFor(mailboxTarget) {
  return mailboxTarget ? `${GRAPH_BASE}/users/${encodeURIComponent(mailboxTarget)}` : `${GRAPH_BASE}/me`;
}

// Sends a brand-new message from the token owner's own mailbox (Mail.Send —
// never Mail.Send.Shared, so this only ever works for a self-owned mailbox,
// i.e. mailboxTarget is always null here: the dashboard's own logged-in
// user replying as themselves, not "as" whatever shared inbox the original
// email arrived in). Not a Graph in-place /reply on the original message —
// that would require Send-As on the source mailbox, which shared inboxes
// deliberately don't have (see AGENTS.md). This is a fresh compose+send
// instead, so it never touches the original mailbox's own send permissions.
async function sendNewMail(accessToken, { to, cc = [], subject, bodyHtml }) {
  const message = {
    subject,
    body: { contentType: "HTML", content: bodyHtml },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  };
  if (cc.length > 0) message.ccRecipients = cc.map((address) => ({ emailAddress: { address } }));

  await axios.post(
    `${GRAPH_BASE}/me/sendMail`,
    { message, saveToSentItems: true },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

// Was head(2000)+tail(1500), dropping the middle of anything longer — real
// bug found 2026-09-05: 57% of Sariah's ingested mail was already hitting
// that cap, not a rare edge case, because FM reply trails routinely run
// long (a real example ran 15+ messages spanning weeks). The dropped middle
// is exactly where a mid-thread NCR mention or property reference tends to
// live, which is why propertyMatcher.js and classifier.js each needed a
// separate thread-wide DB fallback to route around this.
//
// Later that same day: raised to head(15000)+tail(5000), then removed
// entirely — no length cap on what gets STORED at all now. The cap was only
// ever protecting one thing: a single classifier LLM call from an unbounded
// prompt (see classifier.js's own truncation, applied right at prompt-build
// time instead). Storage itself has no reason to ever lose information —
// Postgres TEXT has no practical size limit, and every other consumer of
// this field (property/NCR/signature matching) only gets MORE accurate by
// seeing the complete text instead of a truncated middle.
function extractBodyText(raw) {
  return raw.trim();
}

/**
 * Fetches recent messages from a mailbox via Graph API.
 * Uses delta-friendly fields; for Phase 1 we just pull the most recent N,
 * sorted newest first. Later this can be upgraded to Graph's delta query
 * for efficient incremental sync instead of re-fetching a fixed window.
 */
// Graph enforces its own server-side page-size cap per response regardless of
// $top (in practice well under 500 once $select includes the full message
// body) — a single request against a busy mailbox silently returns only the
// newest chunk of messages, never reaching further back even when `since` was
// 30 days ago. Real emails ended up clustered into the last few days because
// of exactly this: older mail in-window was simply never fetched. Follow
// @odata.nextLink until `top` total messages are collected or pages run out.
// `folderId`, when given, scopes the fetch to that single folder
// (/mailFolders/{id}/messages) instead of the mailbox-wide /messages
// collection — see listFoldersToScan()'s doc comment for why this matters:
// a single mailbox-wide top-N query gets dominated by whichever folder has
// the highest message velocity, silently starving quieter folders (in a
// real case, the root Inbox itself got 0% coverage against a mailbox with
// heavy Outlook auto-filing rules sorting mail into 20+ named subfolders).
async function fetchRecentMessages(accessToken, { top = 50, mailboxTarget = null, since = null, until = null, folderId = null } = {}) {
  const select = [
    "id",
    "conversationId",
    "internetMessageId",
    "subject",
    "from",
    "toRecipients",
    "ccRecipients",
    "receivedDateTime",
    "body",
  ].join(",");

  const base = folderId
    ? `${graphBaseFor(mailboxTarget)}/mailFolders/${folderId}/messages`
    : `${graphBaseFor(mailboxTarget)}/messages`;

  const pageSize = Math.min(top, 100);
  let url = `${base}?$top=${pageSize}&$orderby=receivedDateTime desc&$select=${select}`;
  // `until` is optional and additive to `since` — bounds a fetch to an exact
  // window (e.g. "just Sep 1") instead of "since X, however recent that
  // gets." Not used by the normal hourly/startup ingest (open-ended `since`
  // only), but real for a one-off scoped backfill/test run.
  if (since && until) {
    url += `&$filter=${encodeURIComponent(`receivedDateTime ge ${since} and receivedDateTime lt ${until}`)}`;
  } else if (since) {
    url += `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
  }

  const all = [];
  while (url && all.length < top) {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
      },
    });
    all.push(...response.data.value);
    url = response.data["@odata.nextLink"] || null;
  }

  return all.slice(0, top);
}

// Fetches EVERY message in a given conversation, regardless of date or
// folder — used when a new message arrives on an existing thread, so
// classification/property-matching/the NCR check see the thread's actual
// origin (which could be months old) instead of just whatever happens to be
// quoted inline in the newest reply. Real gap this closes: relying on
// quoted-reply text alone silently loses anything the newest message's own
// captured body doesn't reach, and there's no guarantee of that for a long-
// running thread. Mailbox-wide (not folder-scoped) since a thread's earlier
// messages can be auto-filed into a different subfolder than its latest
// reply — folder boundaries don't matter here the way they do for
// fetchRecentMessages's "what's new" scan.
async function fetchThreadMessages(accessToken, conversationId, { mailboxTarget = null, top = 200 } = {}) {
  const select = [
    "id", "conversationId", "internetMessageId", "subject",
    "from", "toRecipients", "ccRecipients", "receivedDateTime", "body",
  ].join(",");

  let url = `${graphBaseFor(mailboxTarget)}/messages?$top=${Math.min(top, 100)}&$orderby=receivedDateTime asc&$select=${select}&$filter=${encodeURIComponent(`conversationId eq '${conversationId}'`)}`;

  const all = [];
  while (url && all.length < top) {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
    });
    all.push(...response.data.value);
    url = response.data["@odata.nextLink"] || null;
  }
  return all.slice(0, top);
}

// Lists every folder worth scanning for new mail: the root Inbox (where
// genuinely new/unfiled mail lands — highest priority), Sent Items
// (coordinator replies), and Inbox's subfolder tree (real case: Outlook
// rules auto-file incoming mail by sender/vendor into named subfolders like
// "SARIAH-FM"/"ASTECO COMMON" — real correspondence, not clutter). Recurses
// up to maxDepth levels since at least one real folder ("SARIAH COMMON")
// had 0 items itself but 12 child folders of its own. Empty folders
// (totalItemCount === 0, i.e. nothing has EVER been filed there) are
// skipped as a cheap optimization — everything else is scanned even if it
// turns out to have nothing in the `since` window, since totalItemCount is
// a lifetime count, not a recent one.
async function listFoldersToScan(accessToken, mailboxTarget, { maxDepth = 3 } = {}) {
  const base = graphBaseFor(mailboxTarget);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const select = "id,displayName,totalItemCount,childFolderCount";

  async function listChildren(folderId, depth) {
    if (depth > maxDepth) return [];
    const res = await axios.get(`${base}/mailFolders/${folderId}/childFolders?$top=100&$select=${select}`, { headers });
    let out = [];
    for (const f of res.data.value) {
      if (f.totalItemCount > 0) out.push({ id: f.id, name: f.displayName, priority: 2 });
      if (f.childFolderCount > 0) out = out.concat(await listChildren(f.id, depth + 1));
    }
    return out;
  }

  const inbox = (await axios.get(`${base}/mailFolders/Inbox?$select=${select}`, { headers })).data;
  const sent = (await axios.get(`${base}/mailFolders/SentItems?$select=${select}`, { headers })).data;
  const children = inbox.childFolderCount > 0 ? await listChildren(inbox.id, 1) : [];

  return [
    { id: inbox.id, name: "Inbox", priority: 0 },
    { id: sent.id, name: "Sent Items", priority: 1 },
    ...children,
  ];
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
    internetMessageId: rawMessage.internetMessageId || null,
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

// Fetches inline image attachments (e.g. cid:image001.png signature
// graphics) for a single message — used only as a fallback when
// matchRoster()/extractHandler() find no name in the text body, since many
// real shared-inbox signatures are a single flattened image with the
// coordinator's name baked into the pixels, not selectable text (confirmed
// by direct inspection: neither Graph's plain-text nor raw-HTML body ever
// contains the name in that case). Capped at maxImages since a signature is
// almost always the first or only inline image; callers should stop trying
// further images once a match is found.
async function fetchInlineImages(accessToken, messageId, { mailboxTarget = null, maxImages = 2 } = {}) {
  const base = graphBaseFor(mailboxTarget);
  const url = `${base}/messages/${encodeURIComponent(messageId)}/attachments`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return (response.data.value || [])
    .filter((a) => a.isInline && a.contentType?.startsWith("image/") && a.contentBytes)
    .slice(0, maxImages)
    .map((a) => ({ contentType: a.contentType, contentBytes: a.contentBytes }));
}

module.exports = { fetchRecentMessages, fetchThreadMessages, normalizeMessage, graphBaseFor, fetchInlineImages, listFoldersToScan, sendNewMail };
