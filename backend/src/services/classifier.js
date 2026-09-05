const axios = require("axios");
const pool = require("../db/pool");
const { callLlm } = require("./llmQueue");
const { assertBudgetAvailable, recordUsage } = require("./llmBudget");
const { embedText, toVectorLiteral } = require("./embeddings");

// Below this similarity, a past correction is too weak a match to be worth
// surfacing — same caution used everywhere else fuzzy matching shows up in
// this codebase (property semantic fallback, the abandoned domain-based
// customer hint): a weak signal shown as if it were a strong one is worse
// than showing nothing.
const FEEDBACK_SIMILARITY_THRESHOLD = 0.80;
const MAX_GROUNDING_EXAMPLES = 3;

// The stored body_preview has no length cap (graphMail.js/zohoMail.js keep
// the complete text, however long) — this is the ONE place that needs a
// bound, so it lives here instead: protects a single classification call
// from an unbounded prompt (cost, and Gemini's own context window) without
// ever throwing away anything from the database. Head+tail (not just a
// head cutoff) preserves visibility into a trailing signature block for
// handledBy extraction elsewhere, same reasoning as before this moved.
// Raised from 15000+5000 (20000 total) to 37500+12500 (50000 total,
// same 3:1 ratio) — real data check 2026-09-05: 152 of 4,479 messages
// (3.4%) exceeded the old 20000-char cap, most clustered in the
// 20,000-38,000 range. 50000 covers that whole cluster; a single genuine
// 360000-char outlier (a report with a huge embedded table) still won't
// fit — deliberately: a truly pathological one-off shouldn't blow up a
// single classification call unbounded.
const PROMPT_BODY_HEAD = 37500;
const PROMPT_BODY_TAIL = 12500;
function truncateForPrompt(text) {
  if (!text || text.length <= PROMPT_BODY_HEAD + PROMPT_BODY_TAIL) return text || "";
  return text.slice(0, PROMPT_BODY_HEAD) + "\n…\n" + text.slice(-PROMPT_BODY_TAIL);
}

/**
 * Gemini-only classification interface. DeepSeek/Groq/Ollama support was
 * removed deliberately — Gemini 3.5 Flash-Lite is the sole classifier now
 * (2.5 Flash-Lite is no longer available to new API keys as of this writing),
 * gated by llmBudget.js's hard monthly spend cap.
 *
 * Department/category taxonomy is per-client (different clients run entirely
 * different businesses — e.g. Sales/Pre-sales/... vs MEP/Civil/...), so it's
 * passed in as `departmentNames` rather than hardcoded here. Callers resolve
 * the right list from the `departments` table, scoped to the mailbox's client
 * (see services/ingest.js).
 */

// Sariah Facilities Management's client_id (see `clients` table) — the MoM
// keyword list below (Action_Taken_MoM_01-09-2026.pdf) is THEIR client-
// specified vocabulary ("WCR"/"JCR" are Sariah's own FM report abbreviations,
// "renewal"/"EOD today" etc. were negotiated for their specific business).
// Real bug this fixes: the block used to apply unconditionally to every
// client sharing this deployment (departmentNames is already correctly
// per-client, this wasn't) — a completely unrelated client's mail was being
// nudged toward "critical"/"medium" by keywords that mean nothing in their
// business context.
const SARIAH_CLIENT_ID = 8;

// Escalation, redefined for Sariah (2026-09-05): the client wants
// "escalation" to mean ONLY a real NCR (Non-Conformance Report) situation —
// not the previous broad "any real business problem" definition, which they
// found too loose. Deliberately implemented as a hard, deterministic check
// rather than an LLM judgment call: the client's own phrasing was "should
// ONLY be" — an absolute rule, not a soft signal like the severity keywords
// above, so it shouldn't be left to the model's discretion per-call.
//
// A second candidate condition ("a senior person from the other party
// suddenly joins the thread") was discussed and deliberately DEFERRED —
// no clean signal exists for it yet (checked against a real example that
// turned out to still be NCR-driven, just further back in the trail). Left
// out until enough real cases accumulate — via classification_feedback
// corrections — to define it precisely instead of guessing. See
// BEACON_BACKLOG.md.
const NCR_RE = /\bNCR\b/i;

// Checks the CURRENT email's own text first (cheap, no query), then falls
// back to the rest of the thread — same lesson as propertyMatcher.js's
// thread-inheritance tier: body_preview truncates long trails (first 2000 +
// last 1500 chars), so an NCR mentioned in an earlier message further back
// in a long chain can be invisible to a single-message check. Each message
// in a thread is its own row with its own untruncated-in-practice text, so
// checking every row in the conversation catches it regardless of how long
// the current message's own quoted trail has grown.
async function hasNcrInThread(email, conversationId) {
  const directText = `${email.subject || ""}\n${email.bodyPreview || ""}`;
  if (NCR_RE.test(directText)) return true;
  if (!conversationId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM emails WHERE conversation_id = $1 AND (subject ~* '\\yNCR\\y' OR body_preview ~* '\\yNCR\\y') LIMIT 1`,
    [conversationId]
  );
  return rows.length > 0;
}

// Retrieval-augmented correction: NOT literal RLHF (Gemini's weights aren't
// ours to retrain over an API) — instead, retrieve the most similar past
// human corrections for this client and hand them to the model as grounding
// examples. Skips the embedding call entirely when this client has zero
// feedback yet, rather than paying for a lookup with nothing to find.
async function getFeedbackGrounding(email, clientId) {
  if (!clientId) return [];
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM classification_feedback cf
     JOIN emails e ON e.id = cf.email_id
     JOIN people p ON p.id = e.mailbox_owner_id
     WHERE p.client_id = $1 AND cf.embedding IS NOT NULL`,
    [clientId]
  );
  if (Number(countRows[0].count) === 0) return [];

  const text = `${email.subject || ""}\n${email.bodyPreview || ""}`.slice(0, 4000);
  if (!text.trim()) return [];

  let vec;
  try {
    vec = toVectorLiteral(await embedText(text));
  } catch (err) {
    console.error("[classifier] feedback-grounding embedding failed (classifying without it):", err.message);
    return [];
  }

  const { rows } = await pool.query(
    `SELECT e.subject, d.name AS corrected_department, cf.corrected_urgency,
            cf.corrected_severity, cf.corrected_is_critical, cf.corrected_is_escalation,
            cf.comment, 1 - (cf.embedding <=> $1::vector) AS similarity
     FROM classification_feedback cf
     JOIN emails e ON e.id = cf.email_id
     JOIN people p ON p.id = e.mailbox_owner_id
     LEFT JOIN departments d ON d.id = cf.corrected_department_id
     WHERE p.client_id = $2 AND cf.embedding IS NOT NULL
     ORDER BY cf.embedding <=> $1::vector
     LIMIT ${MAX_GROUNDING_EXAMPLES}`,
    [vec, clientId]
  );
  return rows.filter((r) => r.similarity >= FEEDBACK_SIMILARITY_THRESHOLD);
}

function buildClassificationPrompt(email, departmentNames, clientId, groundingExamples = []) {
  const severityKeywordGuidance = clientId === SARIAH_CLIENT_ID
    ? `
   Treat these as strong signals toward "critical" when present (client-specified, from Sariah's own MoM 01/09/2026): "urgent attention", "complaint", "immediate", "reminder – 1 day", "EOD today", "today", "renewal", "priority", "tomorrow", "update status". Not automatic — still weigh against the actual content — but these words mean the sender is treating it as same-day.
   Treat "WCR" or "JCR" (Sariah facilities-management report abbreviations) as a signal toward "medium" rather than "low", even if the email otherwise reads as routine/FYI.`
    : "";

  const escalationDefinition = clientId === SARIAH_CLIENT_ID
    ? `true ONLY if "NCR" (Non-Conformance Report) is mentioned anywhere in this email or its thread — that is the ONLY basis for escalation on this client's mail (client-specified, 2026-09-05). A real problem, an urgent request, a complaint, or an outage does NOT by itself qualify — those are captured by severity/urgency instead, not this flag. (Note: this field is actually re-checked deterministically in code afterward for this client, so your answer here mainly needs to be consistent for the "reasoning" field below.)`
    : `true ONLY for real business problems — broken equipment, customer complaints, supplier failures, financial risks, or security incidents. NEVER for test emails, welcome messages, event invitations, routine order updates, payment notifications, or informational emails.`;

  const groundingBlock = groundingExamples.length > 0
    ? `\nA human on this team previously corrected the AI's classification on similar past emails. Weigh these corrections heavily if this email resembles any of them:\n${groundingExamples.map((g, i) =>
        `${i + 1}. Similar subject: "${g.subject}" — corrected to: department=${g.corrected_department || "?"}, urgency=${g.corrected_urgency || "?"}, severity=${g.corrected_severity || "?"}, is_critical=${g.corrected_is_critical}, is_escalation=${g.corrected_is_escalation}${g.comment ? `. Reviewer's note: "${g.comment}"` : ""}`
      ).join("\n")}\n`
    : "";

  return `You are classifying a business email for an executive dashboard.
${groundingBlock}
Departments (pick exactly one): ${departmentNames.join(", ")}

Email:
From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Directly addressed to the recipient (not just CC'd): ${email.isDirectToOwner}
Body preview: ${truncateForPrompt(email.bodyPreview)}

Decide:
1. department: which department this belongs to
2. urgency: "action_needed" if the recipient must personally act or decide, "fyi" if awareness only
3. is_escalation: ${escalationDefinition}
4. is_critical: true ONLY if this requires action TODAY — explicit today deadline, severe ongoing outage, or sender is waiting right now. false otherwise.
5. severity: one of "critical", "high", "medium", "low" — critical: same bar as is_critical above (action today); high: a real escalation/significant issue but not same-day; medium: a routine action_needed item; low: fyi with no real risk.${severityKeywordGuidance}
6. confidence: your confidence in this classification as a whole, an integer from 0 to 100.
7. summary: 1-2 plain-English sentences describing what this email is about and what action (if any) is needed. Do NOT mention "CEO", "executive", or the recipient's role — write neutrally.
8. reasoning: one short sentence explaining your urgency/escalation decision
9. has_meeting: does this mention a specific scheduled MEETING, call, visit, or appointment — something both parties attend/join at a set time? If yes, also give meeting_date (YYYY-MM-DD), meeting_time (e.g. "3:00 PM IST", or null), meeting_title (brief description).
10. has_deadline: does this mention an ACTION DEADLINE — a date by which something must be sent, completed, paid, renewed, or responded to (NOT a meeting; e.g. "please send by Friday", "renewal due 15th", "reminder - 1 day", "EOD today")? If yes, also give deadline_date (YYYY-MM-DD), deadline_title (brief description), deadline_action (one short sentence of what's due).
   For 9 and 10: an email can have neither, either, or both. If a date is mentioned but vague/unspecific (e.g. "soon", "ASAP" with no actual date), do not extract it — leave has_meeting/has_deadline false.

Respond with ONLY valid JSON, no markdown, in this exact shape:
{"department":"...","urgency":"action_needed or fyi","is_escalation":true or false,"is_critical":true or false,"severity":"critical, high, medium, or low","confidence":0-100,"summary":"...","reasoning":"...",
"has_meeting":true or false,"meeting_date":"YYYY-MM-DD or null","meeting_time":"... or null","meeting_title":"... or null",
"has_deadline":true or false,"deadline_date":"YYYY-MM-DD or null","deadline_title":"... or null","deadline_action":"... or null"}`;
}

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// Fallback when the model omits/mangles severity or confidence — falls back
// gracefully rather than crashing ingestion, same as the department fallback
// below. Derived from the booleans/urgency the model did return, so it stays
// consistent even when severity itself is bad JSON.
function deriveSeverity(parsed) {
  if (VALID_SEVERITIES.has(parsed.severity)) return parsed.severity;
  if (parsed.is_critical) return "critical";
  if (parsed.is_escalation) return "high";
  if (parsed.urgency === "action_needed") return "medium";
  return "low";
}

function parseConfidence(parsed) {
  const n = Number(parsed.confidence);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

async function classifyWithGemini(email, departmentNames, clientId) {
  const groundingExamples = await getFeedbackGrounding(email, clientId);
  const prompt = buildClassificationPrompt(email, departmentNames, clientId, groundingExamples);

  await assertBudgetAvailable();
  const response = await callLlm(() => axios.post(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    {
      model: process.env.GEMINI_CLASSIFY_MODEL || "gemini-3.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 450, // was 300 — raised to fit the merged meeting/deadline fields (see items 9-10)
    },
    { headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, "Content-Type": "application/json" } }
  ));
  await recordUsage(response.data.usage);

  const rawText = response.data.choices[0].message.content.trim();

  let parsed;
  try {
    const cleaned = rawText.replace(/^```json\s*|\s*```$/g, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini classifier response as JSON: ${rawText}`);
  }

  if (!departmentNames.includes(parsed.department)) {
    // Fall back gracefully rather than crashing the whole ingestion run
    parsed.department = departmentNames[0];
    parsed.reasoning = (parsed.reasoning || "") + " [fallback: unrecognized department from model]";
  }

  // Deterministic override for Sariah — the model's own is_escalation guess
  // is ignored entirely for this client; only a real NCR mention (anywhere
  // in the thread) counts. See NCR_RE/hasNcrInThread above for why.
  const isEscalation = clientId === SARIAH_CLIENT_ID
    ? await hasNcrInThread(email, email.conversationId)
    : Boolean(parsed.is_escalation);

  // Meeting/deadline extraction — merged in from what used to be a
  // separate, later Gemini call in calendar.js's /email-events route (same
  // subject+bodyPreview sent to Gemini twice for no real reason — see
  // conversation). Only trust a date when the model actually gave one;
  // "has_meeting: true" with no date is treated as no meeting.
  const meetingDate = parsed.has_meeting && parsed.meeting_date ? parsed.meeting_date : null;
  const deadlineDate = parsed.has_deadline && parsed.deadline_date ? parsed.deadline_date : null;

  return {
    department: parsed.department,
    urgency: parsed.urgency === "action_needed" ? "action_needed" : "fyi",
    isEscalation,
    isCritical: Boolean(parsed.is_critical),
    severity: deriveSeverity(parsed),
    confidence: parseConfidence(parsed),
    summary: parsed.summary || "",
    reasoning: parsed.reasoning || "",
    meetingDate, meetingTime: meetingDate ? (parsed.meeting_time || null) : null, meetingTitle: meetingDate ? (parsed.meeting_title || null) : null,
    deadlineDate, deadlineTitle: deadlineDate ? (parsed.deadline_title || null) : null, deadlineAction: deadlineDate ? (parsed.deadline_action || null) : null,
    raw: response.data,
  };
}

async function classifyEmail(email, departmentNames, clientId) {
  if (!departmentNames?.length) {
    throw new Error("classifyEmail requires a non-empty departmentNames list for this mailbox's client");
  }
  return classifyWithGemini(email, departmentNames, clientId);
}

module.exports = { classifyEmail };
