const pool = require("../db/pool");
const { callLLM, extractJson } = require("./llm");

const STATUSES = new Set(["pending", "ongoing", "escalated", "resolved", "reopened"]);
const ACTION_TYPES = new Set([
  "acknowledged", "requested_info", "sent_quotation", "followed_up",
  "escalated", "provided_update", "confirmed_resolution",
]);

function buildPrompt(messages) {
  const messageList = messages.map((m, i) =>
    `[${i}] ${m.received_at.toISOString()} — ${m.handled_by_name ? `${m.handled_by_name} (coordinator)` : m.from_name || m.from_email}:\n${(m.body_preview || "").slice(0, 1200)}`
  ).join("\n\n---\n\n");

  const coordinatorIndices = messages
    .map((m, i) => (m.handled_by_name ? i : null))
    .filter((i) => i !== null);

  return `You are analysing a full email thread (${messages.length} messages, chronological order) for a facilities-management coordinator dashboard.

Thread:
${messageList}

Decide:
1. status: the thread's current state — one of "pending" (no coordinator response yet), "ongoing" (in progress), "escalated" (flagged as a problem needing attention), "resolved" (issue closed/confirmed done), "reopened" (was confirmed resolved earlier in this same thread, but a later message reopened the issue or raised it again).
2. narrative: 2-4 sentences telling the thread's story as one connected account — what was reported, what happened, where it stands now. Base this ONLY on what the messages actually say.
3. actions: for EACH message marked "(coordinator)" above (indices: ${JSON.stringify(coordinatorIndices)}), classify what that specific message did:
   - action_type: exactly one of "acknowledged", "requested_info", "sent_quotation", "followed_up", "escalated", "provided_update", "confirmed_resolution"
   - description: one short plain sentence of what that message communicated

STRICT RULES:
- Only classify messages actually marked "(coordinator)" — do not invent actions for other senders.
- Do NOT invent information not present in the text.
- Return ONLY valid JSON, no markdown, in this exact shape:
{"status":"...","narrative":"...","actions":[{"index":0,"action_type":"...","description":"..."}]}`;
}

async function getOrGenerateThreadSummary(mailboxOwnerId, conversationId, { refresh = false } = {}) {
  if (refresh) {
    await pool.query(
      `DELETE FROM thread_summaries WHERE mailbox_owner_id = $1 AND conversation_id = $2`,
      [mailboxOwnerId, conversationId]
    );
  } else {
    const cached = await pool.query(
      `SELECT * FROM thread_summaries WHERE mailbox_owner_id = $1 AND conversation_id = $2`,
      [mailboxOwnerId, conversationId]
    );
    if (cached.rows.length > 0) {
      const summary = cached.rows[0];
      const actions = await pool.query(
        `SELECT coordinator_name, action_type, action_at, description
         FROM coordinator_actions WHERE thread_summary_id = $1 ORDER BY action_at`,
        [summary.id]
      );
      return {
        status: summary.status,
        narrative: summary.narrative,
        messageCount: summary.message_count,
        actions: actions.rows.map((a) => ({
          coordinatorName: a.coordinator_name, actionType: a.action_type,
          actionAt: a.action_at, description: a.description,
        })),
      };
    }
  }

  const { rows: messages } = await pool.query(
    `SELECT id, received_at, from_name, from_email, body_preview, handled_by_name, subject
     FROM emails WHERE mailbox_owner_id = $1 AND conversation_id = $2
     ORDER BY received_at`,
    [mailboxOwnerId, conversationId]
  );
  if (messages.length === 0) {
    throw new Error("No messages found for this thread");
  }

  const raw = await callLLM(buildPrompt(messages), { maxTokens: 1200 });
  const parsed = extractJson(raw);

  const status = STATUSES.has(parsed?.status) ? parsed.status : "ongoing";
  const narrative = typeof parsed?.narrative === "string" ? parsed.narrative : null;
  const rawActions = Array.isArray(parsed?.actions) ? parsed.actions : [];

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO thread_summaries
       (mailbox_owner_id, conversation_id, subject, first_received_at, last_received_at, message_count, status, narrative)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (mailbox_owner_id, conversation_id) DO UPDATE SET
       subject = EXCLUDED.subject, first_received_at = EXCLUDED.first_received_at,
       last_received_at = EXCLUDED.last_received_at, message_count = EXCLUDED.message_count,
       status = EXCLUDED.status, narrative = EXCLUDED.narrative, generated_at = now()
     RETURNING id`,
    [
      mailboxOwnerId, conversationId, messages[0].subject,
      messages[0].received_at, messages[messages.length - 1].received_at,
      messages.length, status, narrative,
    ]
  );

  const actions = [];
  for (const a of rawActions) {
    const msg = messages[a?.index];
    if (!msg || !msg.handled_by_name) continue; // only trust indices that really are coordinator messages
    const actionType = ACTION_TYPES.has(a.action_type) ? a.action_type : "provided_update";
    const description = typeof a.description === "string" ? a.description : null;
    await pool.query(
      `INSERT INTO coordinator_actions (thread_summary_id, email_id, coordinator_name, action_type, action_at, description)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [inserted.id, msg.id, msg.handled_by_name, actionType, msg.received_at, description]
    );
    actions.push({ coordinatorName: msg.handled_by_name, actionType, actionAt: msg.received_at, description });
  }

  return { status, narrative, messageCount: messages.length, actions };
}

module.exports = { getOrGenerateThreadSummary };
