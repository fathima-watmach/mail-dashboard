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
// Scans stored email bodies in date range, extracts meeting mentions via LLM.
// Results are cached in emails.meeting_date so they're only extracted once.
router.get("/email-events", async (req, res) => {
  const { personId } = req.session;
  const { start, end } = req.query;

  const startDT = start || new Date().toISOString().split("T")[0];
  const endDT   = end   || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Scan ALL unprocessed emails (not just those in the date range) —
  // an email received last week may mention a meeting scheduled for next month
  const { rows: unchecked } = await pool.query(
    `SELECT id, subject, from_name, from_email, body_preview, received_at
     FROM emails
     WHERE mailbox_owner_id = $1
       AND meeting_details IS NULL
       AND body_preview IS NOT NULL
     ORDER BY received_at DESC LIMIT 50`,
    [personId]
  );

  // Extract meetings from unchecked emails
  for (const email of unchecked) {
    try {
      const prompt = `Read this email and determine if it mentions a specific scheduled meeting, call, visit, or appointment with an explicit date.
If yes, extract: date (ISO format YYYY-MM-DD), time (e.g. "3:00 PM IST" or null), title (brief description), participants (array of names/emails mentioned).
If no meeting is mentioned, return {"has_meeting": false}.
Return ONLY JSON, no markdown.

Email subject: ${email.subject}
Email body: ${(email.body_preview || "").slice(0, 2000)}

JSON:`;

      const raw = await callLLM(prompt, { maxTokens: 300 });
      let parsed;
      try { parsed = extractJson(raw); } catch (_) { parsed = { has_meeting: false }; }

      if (parsed.has_meeting === false || !parsed.date) {
        // Mark as checked with empty result so we don't re-process
        await pool.query(
          `UPDATE emails SET meeting_details = '{}' WHERE id = $1`, [email.id]
        );
      } else {
        await pool.query(
          `UPDATE emails SET
             meeting_date    = $1,
             meeting_time    = $2,
             meeting_title   = $3,
             meeting_details = $4
           WHERE id = $5`,
          [parsed.date, parsed.time || null, parsed.title || email.subject, JSON.stringify(parsed), email.id]
        );
      }
    } catch (_) { /* skip on error */ }
  }

  // Return all emails with extracted meetings in range
  const { rows: meetings } = await pool.query(
    `SELECT id, subject, from_name, from_email, received_at,
            meeting_date, meeting_time, meeting_title, meeting_details
     FROM emails
     WHERE mailbox_owner_id = $1
       AND meeting_date IS NOT NULL
       AND meeting_date >= $2 AND meeting_date <= $3
     ORDER BY meeting_date, meeting_time`,
    [personId, startDT, endDT]
  );

  res.json({ events: meetings });
});

module.exports = router;
