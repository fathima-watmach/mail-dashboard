import React, { useEffect, useState, useCallback } from "react";

const GRAPH_RESPOND = (id, action) =>
  fetch(`/api/calendar/events/${id}/respond`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  }).then((r) => r.json());

const fetchEvents = (start, end) =>
  fetch(`/api/calendar/events?start=${start}&end=${end}`, { credentials: "include" }).then((r) =>
    r.json()
  );

// ── Helpers ───────────────────────────────────────────────────────────────────

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Mon as first day
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function toDateStr(date) {
  return date.toISOString().split("T")[0];
}

function fmtTime(dtStr) {
  // dtStr like "2026-06-25T15:00:00.0000000" already in IST (Prefer header)
  const [, time] = dtStr.split("T");
  const [h, m] = time.split(":");
  const hour = parseInt(h, 10);
  const suffix = hour >= 12 ? "pm" : "am";
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${display}:${m} ${suffix}`;
}

function fmtDayHeader(date) {
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
}

function fmtMonthYear(date) {
  return date.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function eventDateKey(dtStr) {
  return dtStr.split("T")[0];
}

const RESPONSE_COLORS = {
  accepted:           "bg-green-100 border-green-300 text-green-800",
  declined:           "bg-red-100 border-red-300 text-red-700 opacity-60",
  tentativelyAccepted:"bg-yellow-100 border-yellow-300 text-yellow-800",
  none:               "bg-brand-light border-brand text-navy",
  notResponded:       "bg-brand-light border-brand text-navy",
  organizer:          "bg-purple-50 border-purple-300 text-purple-800",
};

const INVITE_BADGE = {
  required:  { label: "Direct invite", color: "bg-brand-light text-brand" },
  optional:  { label: "Optional",      color: "bg-gray-100 text-gray-500" },
  organizer: { label: "Organiser",     color: "bg-purple-100 text-purple-700" },
};

const RESPONSE_LABEL = {
  accepted:            "Accepted",
  declined:            "Declined",
  tentativelyAccepted: "Tentative",
  none:                "No response",
  notResponded:        "No response",
};

// ── Event Card ────────────────────────────────────────────────────────────────

// Card for meetings extracted from email bodies (no accept/decline — just context)
function EmailMeetingCard({ event }) {
  const [expanded, setExpanded] = useState(false);
  const details = event.meeting_details || {};
  return (
    <div
      className="mb-1 rounded-lg border border-purple-200 bg-purple-50 p-2 cursor-pointer text-xs"
      onClick={() => setExpanded((x) => !x)}
    >
      <p className="font-medium text-purple-800 truncate">{event.subject}</p>
      <p className="text-purple-500 mt-0.5">
        {event.meeting_time || "Time TBD"} · <span className="italic">via email</span>
      </p>
      {expanded && (
        <div className="mt-1.5 pt-1.5 border-t border-purple-200 space-y-0.5 text-purple-700">
          <p><span className="font-medium">From:</span> {event.from_name || event.from_email}</p>
          {details.participants?.length > 0 && (
            <p><span className="font-medium">Participants:</span> {details.participants.join(", ")}</p>
          )}
          {details.notes && <p className="italic">{details.notes}</p>}
        </div>
      )}
    </div>
  );
}

function EventCard({ event, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [responding, setResponding] = useState(null);

  const respond = async (action) => {
    setResponding(action);
    await GRAPH_RESPOND(event.id, action);
    setResponding(null);
    onRefresh();
  };

  const needsResponse =
    !event.isOrganizer &&
    !event.isCancelled &&
    (event.responseStatus === "none" || event.responseStatus === "notResponded");

  const colorClass =
    event.isCancelled
      ? "bg-gray-100 border-gray-200 text-gray-400 opacity-50"
      : event.inviteType === "organizer"
      ? RESPONSE_COLORS.organizer
      : RESPONSE_COLORS[event.responseStatus] || RESPONSE_COLORS.none;

  const inviteBadge = INVITE_BADGE[event.inviteType];

  return (
    <div
      className={`rounded-lg border p-2 mb-1.5 cursor-pointer transition-shadow hover:shadow-sm ${colorClass}`}
      onClick={() => setExpanded((x) => !x)}
    >
      {/* Time + title */}
      <p className="text-xs font-semibold leading-tight">{fmtTime(event.start.dateTime)}</p>
      <p className="text-xs font-medium leading-snug mt-0.5 line-clamp-2">
        {event.isCancelled ? "❌ " : ""}{event.subject}
      </p>

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mt-1">
        {inviteBadge && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${inviteBadge.color}`}>
            {inviteBadge.label}
          </span>
        )}
        {!needsResponse && !event.isCancelled && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-white/60 text-current">
            {RESPONSE_LABEL[event.responseStatus]}
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-current/10 space-y-1.5 text-xs" onClick={(e) => e.stopPropagation()}>
          {/* Time range */}
          <p className="text-gray-600">
            {fmtTime(event.start.dateTime)} – {fmtTime(event.end.dateTime)}
          </p>

          {/* Location */}
          {event.location && (
            <p className="flex items-center gap-1 text-gray-600">
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              {event.location}
            </p>
          )}

          {/* Online meeting */}
          {event.isOnlineMeeting && event.joinUrl && (
            <a
              href={event.joinUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-brand hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
              </svg>
              Join online meeting
            </a>
          )}

          {/* Organiser */}
          {event.organizer && !event.isOrganizer && (
            <p className="text-gray-500">Organiser: {event.organizer.name || event.organizer.address}</p>
          )}

          {/* Attendees */}
          {event.attendees.length > 0 && (
            <div>
              <p className="text-gray-500 font-medium mb-0.5">
                {event.attendees.length} attendee{event.attendees.length !== 1 ? "s" : ""}
              </p>
              <div className="space-y-0.5 max-h-24 overflow-y-auto">
                {event.attendees.map((a) => (
                  <p key={a.email} className="text-gray-500 truncate">
                    {a.name || a.email}
                    <span className="ml-1 opacity-60">
                      {a.type === "optional" ? "(optional)" : ""}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Body preview */}
          {event.bodyPreview && (
            <p className="text-gray-400 italic leading-relaxed line-clamp-3">{event.bodyPreview}</p>
          )}

          {/* Accept / Decline / Tentative */}
          {needsResponse && (
            <div className="flex gap-1.5 pt-1">
              <button
                onClick={() => respond("accept")}
                disabled={!!responding}
                className="px-2.5 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 disabled:opacity-50"
              >
                {responding === "accept" ? "…" : "Accept"}
              </button>
              <button
                onClick={() => respond("tentativelyAccept")}
                disabled={!!responding}
                className="px-2.5 py-1 bg-yellow-500 text-white text-xs rounded hover:bg-yellow-600 disabled:opacity-50"
              >
                {responding === "tentativelyAccept" ? "…" : "Maybe"}
              </button>
              <button
                onClick={() => respond("decline")}
                disabled={!!responding}
                className="px-2.5 py-1 bg-red-500 text-white text-xs rounded hover:bg-red-600 disabled:opacity-50"
              >
                {responding === "decline" ? "…" : "Decline"}
              </button>
            </div>
          )}

          {/* Change response buttons for already-responded events */}
          {!needsResponse && !event.isOrganizer && !event.isCancelled && (
            <div className="flex gap-1.5 pt-1">
              {event.responseStatus !== "accepted" && (
                <button onClick={() => respond("accept")} disabled={!!responding}
                  className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded hover:bg-green-200 disabled:opacity-50">
                  {responding === "accept" ? "…" : "Accept"}
                </button>
              )}
              {event.responseStatus !== "tentativelyAccepted" && (
                <button onClick={() => respond("tentativelyAccept")} disabled={!!responding}
                  className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded hover:bg-yellow-200 disabled:opacity-50">
                  {responding === "tentativelyAccept" ? "…" : "Maybe"}
                </button>
              )}
              {event.responseStatus !== "declined" && (
                <button onClick={() => respond("decline")} disabled={!!responding}
                  className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded hover:bg-red-200 disabled:opacity-50">
                  {responding === "decline" ? "…" : "Decline"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Calendar Page ────────────────────────────────────────────────────────

export default function Calendar({ user }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [events, setEvents]         = useState([]);
  const [emailEvents, setEmailEvents] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const isZoho = user?.provider === "zoho";

  const load = useCallback(() => {
    const start = toDateStr(weekStart);
    const end   = toDateStr(addDays(weekStart, 6));
    setLoading(true);
    setError(null);

    // Always load email-based events for all users
    fetch(`/api/calendar/email-events?start=${start}&end=${end}`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setEmailEvents(d.events || []))
      .catch(() => {});

    if (isZoho) {
      // Zoho users: skip Graph calendar, just use email events
      setEvents([]);
      setLoading(false);
      return;
    }

    fetchEvents(start, end)
      .then((d) => {
        if (d.error) { setError(d.error); return; }
        setEvents(d.events || []);
      })
      .catch(() => setError("Failed to load calendar."))
      .finally(() => setLoading(false));
  }, [weekStart, isZoho]);

  useEffect(() => { load(); }, [load]);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Group calendar events by date key
  const byDay = {};
  for (const evt of events) {
    const key = eventDateKey(evt.start.dateTime);
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push({ ...evt, _type: "calendar" });
  }
  // Add email-extracted meeting events
  for (const m of emailEvents) {
    const key = m.meeting_date; // already YYYY-MM-DD
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push({ ...m, _type: "email", id: `email-${m.id}`, subject: m.meeting_title || m.subject });
  }

  const prevWeek = () => setWeekStart((d) => addDays(d, -7));
  const nextWeek = () => setWeekStart((d) => addDays(d, 7));
  const goToday  = () => setWeekStart(startOfWeek(new Date()));

  const pending = events.filter(
    (e) => !e.isOrganizer && !e.isCancelled &&
           (e.responseStatus === "none" || e.responseStatus === "notResponded")
  ).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-gray-800">{fmtMonthYear(weekStart)}</h2>
          {pending > 0 && (
            <span className="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">
              {pending} awaiting response
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goToday}
            className="text-xs text-gray-500 hover:text-brand border border-gray-200 px-3 py-1.5 rounded-lg hover:border-brand transition-colors">
            Today
          </button>
          <button onClick={prevWeek}
            className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors text-gray-500">
            ‹
          </button>
          <button onClick={nextWeek}
            className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors text-gray-500">
            ›
          </button>
          <button onClick={load}
            className="text-xs text-gray-400 hover:text-brand px-2 transition-colors">
            ↻
          </button>
        </div>
      </div>

      {/* Error / permission banner */}
      {error && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          {user?.provider === "zoho" ? (
            <>
              <p className="font-semibold mb-1">Zoho calendar not connected</p>
              <p className="text-xs text-amber-700">Showing meetings extracted from your emails above (purple). Full Zoho Calendar sync coming soon.</p>
            </>
          ) : (
            <>
              <p className="font-semibold mb-1">Calendar permission needed</p>
              <p>{error}</p>
              <a href="/auth/login"
                className="mt-2 inline-block text-brand hover:underline text-xs font-medium">
                Sign in again to grant access →
              </a>
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" />
        </div>
      ) : (
        <>
          {/* Legend */}
          <div className="flex flex-wrap gap-3 text-xs text-gray-500">
            {[
              { color: "bg-brand-light border-brand", label: "No response yet" },
              { color: "bg-green-100 border-green-300", label: "Accepted" },
              { color: "bg-yellow-100 border-yellow-300", label: "Tentative" },
              { color: "bg-red-100 border-red-300", label: "Declined" },
              { color: "bg-purple-100 border-purple-300", label: "You organised" },
            ].map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <span className={`w-3 h-3 rounded border ${l.color} inline-block`} />
                {l.label}
              </span>
            ))}
          </div>

          {/* Week grid */}
          <div className="grid grid-cols-7 gap-1.5">
            {days.map((day) => {
              const key = toDateStr(day);
              const isToday = key === toDateStr(new Date());
              const dayEvents = byDay[key] || [];

              return (
                <div key={key} className="min-h-32">
                  {/* Day header */}
                  <div className={`text-center py-1.5 rounded-t-lg mb-1 text-xs font-semibold
                    ${isToday ? "bg-brand text-white" : "bg-gray-100 text-gray-600"}`}>
                    {fmtDayHeader(day)}
                  </div>

                  {/* Events */}
                  {dayEvents.length === 0 ? (
                    <div className="h-20 rounded-lg border border-dashed border-gray-100" />
                  ) : (
                    dayEvents.map((evt) =>
                      evt._type === "email" ? (
                        <EmailMeetingCard key={evt.id} event={evt} />
                      ) : (
                        <EventCard key={evt.id} event={evt} onRefresh={load} />
                      )
                    )
                  )}
                </div>
              );
            })}
          </div>

          {events.length === 0 && emailEvents.length === 0 && !error && (
            <p className="text-center py-8 text-gray-400 text-sm">
              {isZoho ? "No meetings found in emails this week." : "No events this week."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
