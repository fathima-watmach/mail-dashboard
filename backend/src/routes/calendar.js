const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const pool    = require("../db/pool");
const { requireLogin }          = require("../middleware/auth");
const { getValidAccessToken }   = require("../services/msAuth");
const { callLLM, extractJson }  = require("../services/llm");

router.use(requireLogin);

const GRAPH = "https://graph.microsoft.com/v1.0";

router.get("/events", async (req, res) => {
  try {
    const { start, end } = req.query;
    const accessToken = await getValidAccessToken(req.session.personId);

    const startDT = start
      ? `${start}T00:00:00`
      : new Date().toISOString().split("T")[0] + "T00:00:00";
    const endDT = end
      ? `${end}T23:59:59`
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0] + "T23:59:59";

    const select = [
      "id", "subject", "start", "end", "location",
      "isOnlineMeeting", "onlineMeeting", "organizer",
      "attendees", "responseStatus", "isOrganizer",
      "isCancelled", "bodyPreview", "showAs",
    ].join(",");

    const response = await axios.get(
      `${GRAPH}/me/calendarView?startDateTime=${startDT}&endDateTime=${endDT}&$orderby=start/dateTime&$top=100&$select=${select}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.timezone="Asia/Kolkata"',
        },
      }
    );

    const ownerEmail = req.session.email.toLowerCase();

    const events = response.data.value.map((evt) => {
      const attendees = (evt.attendees || []).map((a) => ({
        name: a.emailAddress?.name || "",
        email: (a.emailAddress?.address || "").toLowerCase(),
        type: a.type, // required | optional
        response: a.status?.response || "none",
      }));

      // Determine if CEO is directly invited or optional/cc'd
      const myAttendance = attendees.find((a) => a.email === ownerEmail);
      const inviteType = evt.isOrganizer
        ? "organizer"
        : myAttendance?.type === "optional"
        ? "optional"
        : "required";

      return {
        id: evt.id,
        subject: evt.subject || "(No title)",
        start: evt.start,
        end: evt.end,
        location: evt.location?.displayName || null,
        isOnlineMeeting: evt.isOnlineMeeting || false,
        joinUrl: evt.onlineMeeting?.joinUrl || null,
        organizer: evt.organizer?.emailAddress || null,
        attendees,
        responseStatus: evt.responseStatus?.response || "none",
        isOrganizer: evt.isOrganizer || false,
        isCancelled: evt.isCancelled || false,
        inviteType,
        bodyPreview: (evt.bodyPreview || "").slice(0, 300),
      };
    });

    res.json({ events });
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      return res.status(403).json({
        error: "Calendar access not granted. Please sign out and sign in again to approve Calendars.ReadWrite permission.",
      });
    }
    console.error("[calendar] Error fetching events:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch calendar events" });
  }
});

router.post("/events/:id/respond", async (req, res) => {
  const { action, comment } = req.body;
  if (!["accept", "decline", "tentativelyAccept"].includes(action)) {
    return res.status(400).json({ error: "action must be accept | decline | tentativelyAccept" });
  }

  try {
    const accessToken = await getValidAccessToken(req.session.personId);
    await axios.post(
      `${GRAPH}/me/events/${req.params.id}/${action}`,
      { comment: comment || "", sendResponse: true },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[calendar] respond error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send response" });
  }
});

// ── Email-based meeting events (for Zoho users or as supplement) ──────────────
// Scans stored email bodies in date range, extracts meeting/deadline mentions
// via LLM. Results are cached in emails.meeting_date/action_deadline_date so
// they're only extracted once.
//
// As of 2026-09-05, this extraction ALSO happens inline at ingest time
// (classifier.js — merged in, since it was sending the exact same
// subject+body to Gemini a second time for no real reason: same content
// already goes through classification once). Newly-ingested mail already
// has meeting_details set (to '{}' if nothing found) by the time it reaches
// this route, so the WHERE clause below naturally skips it — this loop is
// now effectively a backfill path for mail ingested BEFORE the merge, not
// the primary extraction mechanism for new mail. Left in place rather than
// removed since there's still a real backlog of older unscanned emails.
// Same temporary Sariah pause as ingest.js's SARIAH_CLASSIFICATION_PAUSED_CLIENT_ID
// (2026-09-05) — this route only ever scans mailbox_owner_id = the logged-in
// person's own id, which in practice can't reach Sariah's shared inboxes
// (contactus@/maintenance@ are delegate-accessed, never logged into
// directly) — but guarding it explicitly here too removes any doubt while
// classification corrections are in progress. Remove once corrections are
// done.
const SARIAH_CLASSIFICATION_PAUSED_CLIENT_ID = 8;

router.get("/email-events", async (req, res) => {
  const { personId } = req.session;
  const { start, end } = req.query;

  const personRow = await pool.query(`SELECT client_id FROM people WHERE id = $1`, [personId]);
  const skipLlmBackfill = personRow.rows[0]?.client_id === SARIAH_CLASSIFICATION_PAUSED_CLIENT_ID;

  const startDT = start || new Date().toISOString().split("T")[0];
  const endDT   = end   || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Scan ALL unprocessed emails (not just those in the date range) —
  // an email received last week may mention a meeting scheduled for next month.
  // `meeting_details IS NULL` is the "not yet extracted" sentinel for BOTH
  // meeting and deadline detection (one LLM call does both, see prompt below)
  // — kept as the existing column rather than adding a second gate column.
  // Skips this backfill entirely while Sariah classification is paused
  // (skipLlmBackfill) — the SELECT further down still runs and returns
  // whatever meeting/deadline data already exists, so this only holds off
  // the LLM calls, not real calendar data already on record.
  const { rows: unchecked } = skipLlmBackfill ? { rows: [] } : await pool.query(
    `SELECT id, subject, from_name, from_email, body_preview, received_at
     FROM emails
     WHERE mailbox_owner_id = $1
       AND meeting_details IS NULL
       AND body_preview IS NOT NULL
     ORDER BY received_at DESC LIMIT 50`,
    [personId]
  );

  // Extract meetings AND action deadlines from unchecked emails in one pass.
  // A "deadline" here is deliberately NOT a meeting — no one attends/joins it,
  // it's just a date something is due (send a document, pay an invoice,
  // respond, renew) — the same real-world signal the client's own MoM
  // keyword list (urgent attention/reminder-1-day/EOD today/renewal/
  // tomorrow/etc — see classifier.js) points at for severity, just surfaced
  // here as a literal calendar date instead of a badge.
  for (const email of unchecked) {
    try {
      const prompt = `Read this email and determine two separate things:
1. Does it mention a specific scheduled MEETING, call, visit, or appointment — something both parties attend/join at a set time?
2. Does it mention an ACTION DEADLINE — a date by which something must be sent, completed, paid, renewed, or responded to (NOT a meeting; e.g. "please send by Friday", "renewal due 15th", "reminder - 1 day", "EOD today")?

An email can have neither, either, or both. If a date is mentioned but it's vague/not a specific date (e.g. "soon", "ASAP" with no date), do not extract it.

Respond with ONLY this JSON shape, no markdown:
{"has_meeting":true/false,"meeting":{"date":"YYYY-MM-DD","time":"3:00 PM IST or null","title":"...","participants":["..."]} or null,
 "has_deadline":true/false,"deadline":{"date":"YYYY-MM-DD","title":"brief description","action":"one short sentence of what's due"} or null}

Email subject: ${email.subject}
Email body: ${(email.body_preview || "").slice(0, 2000)}

JSON:`;

      const raw = await callLLM(prompt, { maxTokens: 350 });
      let parsed;
      try { parsed = extractJson(raw); } catch (_) { parsed = { has_meeting: false, has_deadline: false }; }

      const meeting = parsed.has_meeting && parsed.meeting?.date ? parsed.meeting : null;
      const deadline = parsed.has_deadline && parsed.deadline?.date ? parsed.deadline : null;

      await pool.query(
        `UPDATE emails SET
           meeting_date            = $1,
           meeting_time            = $2,
           meeting_title           = $3,
           meeting_details         = $4,
           action_deadline_date    = $5,
           action_deadline_title   = $6,
           action_deadline_details = $7
         WHERE id = $8`,
        [
          meeting?.date || null, meeting?.time || null, meeting?.title || (meeting ? email.subject : null),
          JSON.stringify(meeting || {}),
          deadline?.date || null, deadline?.title || (deadline ? email.subject : null),
          deadline ? JSON.stringify(deadline) : null,
          email.id,
        ]
      );
    } catch (_) { /* skip on error */ }
  }

  // Return all emails with an extracted meeting OR deadline in range —
  // frontend splits each row into a meeting entry, a deadline entry, or
  // both depending on which date fields are populated.
  const { rows: meetings } = await pool.query(
    `SELECT id, subject, from_name, from_email, received_at,
            meeting_date, meeting_time, meeting_title, meeting_details,
            action_deadline_date, action_deadline_title, action_deadline_details
     FROM emails
     WHERE mailbox_owner_id = $1
       AND (
         (meeting_date IS NOT NULL AND meeting_date >= $2 AND meeting_date <= $3)
         OR (action_deadline_date IS NOT NULL AND action_deadline_date >= $2 AND action_deadline_date <= $3)
       )
     ORDER BY COALESCE(meeting_date, action_deadline_date), meeting_time`,
    [personId, startDT, endDT]
  );

  res.json({ events: meetings });
});

module.exports = router;
