import React, { useEffect, useState, useCallback, useMemo } from "react";

// ── Date helpers ──────────────────────────────────────────────────────────────
function startOfWeek(date) {
  const d = new Date(date);
  const diff = d.getDay() === 0 ? -6 : 1 - d.getDay();
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}
function addDays(date, n) {
  const d = new Date(date); d.setDate(d.getDate() + n); return d;
}
function addMonths(date, n) {
  const d = new Date(date); d.setMonth(d.getMonth() + n); return d;
}
function toDateStr(date) { return date.toISOString().split("T")[0]; }
function todayStr() { return toDateStr(new Date()); }

function fmtTime(dtStr) {
  const [, time] = dtStr.split("T");
  const [h, m] = time.split(":");
  const hour = parseInt(h, 10);
  const suffix = hour >= 12 ? "pm" : "am";
  const display = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  return `${display}:${m} ${suffix}`;
}
function fmtMonthYear(date) {
  return date.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}
function fmtDayHeader(date) {
  return date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
}
function fmtFullDay(date) {
  return date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function eventDateKey(dtStr) { return dtStr.split("T")[0]; }

// ── API ───────────────────────────────────────────────────────────────────────
const fetchGraphEvents = (start, end) =>
  fetch(`/api/calendar/events?start=${start}&end=${end}`, { credentials: "include" }).then(r => r.json());

const fetchEmailEvents = (start, end) =>
  fetch(`/api/calendar/email-events?start=${start}&end=${end}`, { credentials: "include" }).then(r => r.json());

const respondToEvent = (id, action) =>
  fetch(`/api/calendar/events/${id}/respond`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  }).then(r => r.json());

// ── Constants ─────────────────────────────────────────────────────────────────
const RESPONSE_COLORS = {
  accepted:            "bg-green-100 border-green-300 text-green-800",
  declined:            "bg-red-100 border-red-300 text-red-700 opacity-60",
  tentativelyAccepted: "bg-yellow-100 border-yellow-300 text-yellow-800",
  none:                "bg-brand-light border-brand text-navy",
  notResponded:        "bg-brand-light border-brand text-navy",
  organizer:           "bg-purple-50 border-purple-300 text-purple-800",
};
const RESPONSE_LABEL = {
  accepted: "Accepted", declined: "Declined",
  tentativelyAccepted: "Tentative", none: "No response", notResponded: "No response",
};
const INVITE_BADGE = {
  required:  { label: "Direct invite", color: "bg-brand-light text-brand" },
  optional:  { label: "Optional",      color: "bg-gray-100 text-gray-500" },
  organizer: { label: "Organiser",     color: "bg-purple-100 text-purple-700" },
};

// ── Email meeting card ────────────────────────────────────────────────────────
function EmailMeetingCard({ event }) {
  const [expanded, setExpanded] = useState(false);
  const details = event.meeting_details || {};
  return (
    <div className="mb-1 rounded-lg border border-purple-200 bg-purple-50 p-2 cursor-pointer text-xs"
      onClick={() => setExpanded(x => !x)}>
      <p className="font-medium text-purple-800 truncate">{event.meeting_title || event.subject}</p>
      <p className="text-purple-500 mt-0.5">{event.meeting_time || "Time TBD"} · <span className="italic">via email</span></p>
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

// ── Graph calendar event card ─────────────────────────────────────────────────
function EventCard({ event, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [responding, setResponding] = useState(null);

  const respond = async (action) => {
    setResponding(action);
    await respondToEvent(event.id, action);
    setResponding(null);
    onRefresh();
  };

  const needsResponse = !event.isOrganizer && !event.isCancelled &&
    (event.responseStatus === "none" || event.responseStatus === "notResponded");

  const colorClass = event.isCancelled
    ? "bg-gray-100 border-gray-200 text-gray-400 opacity-50"
    : event.inviteType === "organizer"
    ? RESPONSE_COLORS.organizer
    : RESPONSE_COLORS[event.responseStatus] || RESPONSE_COLORS.none;

  return (
    <div className={`rounded-lg border p-2 mb-1.5 cursor-pointer transition-shadow hover:shadow-sm ${colorClass}`}
      onClick={() => setExpanded(x => !x)}>
      <p className="text-xs font-semibold">{fmtTime(event.start.dateTime)}</p>
      <p className="text-xs font-medium mt-0.5 line-clamp-2">{event.isCancelled ? "❌ " : ""}{event.subject}</p>
      <div className="flex flex-wrap gap-1 mt-1">
        {INVITE_BADGE[event.inviteType] && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${INVITE_BADGE[event.inviteType].color}`}>
            {INVITE_BADGE[event.inviteType].label}
          </span>
        )}
        {!needsResponse && !event.isCancelled && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-white/60 text-current">
            {RESPONSE_LABEL[event.responseStatus]}
          </span>
        )}
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-current/10 space-y-1.5 text-xs" onClick={e => e.stopPropagation()}>
          <p className="text-gray-600">{fmtTime(event.start.dateTime)} – {fmtTime(event.end.dateTime)}</p>
          {event.location && <p className="text-gray-600">📍 {event.location}</p>}
          {event.isOnlineMeeting && event.joinUrl && (
            <a href={event.joinUrl} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-brand hover:underline" onClick={e => e.stopPropagation()}>
              🎥 Join online meeting
            </a>
          )}
          {event.organizer && !event.isOrganizer && (
            <p className="text-gray-500">Organiser: {event.organizer.name || event.organizer.address}</p>
          )}
          {event.attendees.length > 0 && (
            <div>
              <p className="text-gray-500 font-medium">{event.attendees.length} attendee{event.attendees.length !== 1 ? "s" : ""}</p>
              <div className="space-y-0.5 max-h-20 overflow-y-auto mt-0.5">
                {event.attendees.map(a => (
                  <p key={a.email} className="text-gray-500 truncate">{a.name || a.email}{a.type === "optional" ? " (optional)" : ""}</p>
                ))}
              </div>
            </div>
          )}
          {event.bodyPreview && <p className="text-gray-400 italic line-clamp-3">{event.bodyPreview}</p>}
          {needsResponse && (
            <div className="flex gap-1.5 pt-1">
              {[["accept","Accept","bg-green-600 hover:bg-green-700"],["tentativelyAccept","Maybe","bg-yellow-500 hover:bg-yellow-600"],["decline","Decline","bg-red-500 hover:bg-red-600"]].map(([a,l,c]) => (
                <button key={a} onClick={() => respond(a)} disabled={!!responding}
                  className={`px-2.5 py-1 text-white text-xs rounded disabled:opacity-50 ${c}`}>
                  {responding === a ? "…" : l}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Calendar ─────────────────────────────────────────────────────────────
export default function Calendar({ user }) {
  const [view, setView]       = useState("week"); // "day" | "week" | "month"
  const [anchor, setAnchor]   = useState(new Date());
  const [events, setEvents]   = useState([]);
  const [emailEvents, setEmailEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const isZoho = user?.provider === "zoho";

  // Date range for the current view
  const { start, end, displayLabel } = useMemo(() => {
    if (view === "day") {
      const s = toDateStr(anchor);
      return { start: s, end: s, displayLabel: fmtFullDay(anchor) };
    }
    if (view === "week") {
      const ws = startOfWeek(anchor);
      return { start: toDateStr(ws), end: toDateStr(addDays(ws, 6)), displayLabel: fmtMonthYear(ws) };
    }
    // month
    const ms = startOfMonth(anchor);
    const me = endOfMonth(anchor);
    return { start: toDateStr(ms), end: toDateStr(me), displayLabel: fmtMonthYear(anchor) };
  }, [view, anchor]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);

    fetchEmailEvents(start, end)
      .then(d => setEmailEvents(d.events || []))
      .catch(() => {});

    if (isZoho) {
      setEvents([]);
      setLoading(false);
      return;
    }

    fetchGraphEvents(start, end)
      .then(d => {
        if (d.error) { setError(d.error); return; }
        setEvents(d.events || []);
      })
      .catch(() => setError("Failed to load calendar."))
      .finally(() => setLoading(false));
  }, [start, end, isZoho]);

  useEffect(() => { load(); }, [load]);

  // Group all events by date string
  const byDay = useMemo(() => {
    const map = {};
    for (const evt of events) {
      const key = eventDateKey(evt.start.dateTime);
      if (!map[key]) map[key] = [];
      map[key].push({ ...evt, _type: "calendar" });
    }
    for (const m of emailEvents) {
      const key = m.meeting_date;
      if (!map[key]) map[key] = [];
      map[key].push({ ...m, _type: "email", id: `email-${m.id}`, subject: m.meeting_title || m.subject });
    }
    return map;
  }, [events, emailEvents]);

  // Navigation
  const prev = () => {
    if (view === "day")   setAnchor(d => addDays(d, -1));
    if (view === "week")  setAnchor(d => addDays(startOfWeek(d), -7));
    if (view === "month") setAnchor(d => addMonths(d, -1));
  };
  const next = () => {
    if (view === "day")   setAnchor(d => addDays(d, 1));
    if (view === "week")  setAnchor(d => addDays(startOfWeek(d), 7));
    if (view === "month") setAnchor(d => addMonths(d, 1));
  };
  const goToday = () => setAnchor(new Date());

  const pending = events.filter(e =>
    !e.isOrganizer && !e.isCancelled &&
    (e.responseStatus === "none" || e.responseStatus === "notResponded")
  ).length;

  const totalEvents = events.length + emailEvents.length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-gray-800">{displayLabel}</h2>
          {pending > 0 && (
            <span className="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-medium">
              {pending} awaiting response
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* View toggle */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {[["day","Day"],["week","Week"],["month","Month"]].map(([v,l]) => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors
                  ${view === v ? "bg-brand text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}>
                {l}
              </button>
            ))}
          </div>
          <button onClick={goToday}
            className="text-xs text-gray-500 hover:text-brand border border-gray-200 px-3 py-1.5 rounded-lg hover:border-brand transition-colors">
            Today
          </button>
          <button onClick={prev} className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-500">‹</button>
          <button onClick={next} className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-500">›</button>
          <button onClick={load} className="text-xs text-gray-400 hover:text-brand px-2">↻</button>
        </div>
      </div>

      {/* Permission/error banner */}
      {error && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <p className="font-semibold mb-1">Calendar permission needed</p>
          <p>{error}</p>
          <a href="/auth/login" className="mt-2 inline-block text-brand hover:underline text-xs font-medium">
            Sign in again to grant access →
          </a>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" />
        </div>
      ) : (
        <>
          {/* ── DAY VIEW ── */}
          {view === "day" && (
            <DayView
              dateStr={toDateStr(anchor)}
              dayEvents={byDay[toDateStr(anchor)] || []}
              onRefresh={load}
            />
          )}

          {/* ── WEEK VIEW ── */}
          {view === "week" && (
            <WeekView
              weekStart={startOfWeek(anchor)}
              byDay={byDay}
              onRefresh={load}
              onDayClick={(d) => { setAnchor(d); setView("day"); }}
            />
          )}

          {/* ── MONTH VIEW ── */}
          {view === "month" && (
            <MonthView
              anchor={anchor}
              byDay={byDay}
              onDayClick={(d) => { setAnchor(d); setView("day"); }}
            />
          )}

          {totalEvents === 0 && !error && (
            <p className="text-center py-8 text-gray-400 text-sm">
              No meetings or events found for this period.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Day View ──────────────────────────────────────────────────────────────────
function DayView({ dateStr, dayEvents, onRefresh }) {
  const isToday = dateStr === todayStr();
  return (
    <div className="space-y-2">
      <div className={`rounded-xl p-4 ${isToday ? "bg-brand-light border border-brand/20" : "bg-gray-50 border border-gray-100"}`}>
        {dayEvents.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">No meetings or events this day.</p>
        ) : (
          <div className="space-y-2">
            {dayEvents.map(evt =>
              evt._type === "email"
                ? <EmailMeetingCard key={evt.id} event={evt} />
                : <EventCard key={evt.id} event={evt} onRefresh={onRefresh} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Week View ─────────────────────────────────────────────────────────────────
function WeekView({ weekStart, byDay, onRefresh, onDayClick }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return (
    <>
      <div className="flex flex-wrap gap-3 text-xs text-gray-500">
        {[
          { color: "bg-brand-light border-brand", label: "No response yet" },
          { color: "bg-green-100 border-green-300", label: "Accepted" },
          { color: "bg-yellow-100 border-yellow-300", label: "Tentative" },
          { color: "bg-red-100 border-red-300", label: "Declined" },
          { color: "bg-purple-50 border-purple-300", label: "You organised" },
          { color: "bg-purple-100 border-purple-200", label: "Via email" },
        ].map(l => (
          <span key={l.label} className="flex items-center gap-1">
            <span className={`w-3 h-3 rounded border ${l.color} inline-block`} /> {l.label}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map(day => {
          const key = toDateStr(day);
          const isToday = key === todayStr();
          const dayEvents = byDay[key] || [];
          return (
            <div key={key} className="min-h-32">
              <div
                className={`text-center py-1.5 rounded-t-lg mb-1 text-xs font-semibold cursor-pointer
                  ${isToday ? "bg-brand text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                onClick={() => onDayClick(day)}
              >
                {fmtDayHeader(day)}
              </div>
              {dayEvents.length === 0
                ? <div className="h-20 rounded-lg border border-dashed border-gray-100" />
                : dayEvents.map(evt =>
                    evt._type === "email"
                      ? <EmailMeetingCard key={evt.id} event={evt} />
                      : <EventCard key={evt.id} event={evt} onRefresh={onRefresh} />
                  )
              }
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Month View ────────────────────────────────────────────────────────────────
function MonthView({ anchor, byDay, onDayClick }) {
  const ms  = startOfMonth(anchor);
  const me  = endOfMonth(anchor);
  const today = todayStr();

  // Build grid: start from Monday of the week containing month start
  const gridStart = startOfWeek(ms);
  const totalDays = Math.ceil((me.getDate() + ((ms.getDay() === 0 ? 6 : ms.getDay() - 1))) / 7) * 7;
  const gridDays  = Array.from({ length: Math.max(totalDays, 35) }, (_, i) => addDays(gridStart, i));
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div>
      {/* Day of week headers */}
      <div className="grid grid-cols-7 mb-1">
        {DOW.map(d => (
          <div key={d} className="text-center text-xs font-semibold text-gray-400 py-2">{d}</div>
        ))}
      </div>
      {/* Day cells */}
      <div className="grid grid-cols-7 gap-px bg-gray-100 rounded-xl overflow-hidden border border-gray-100">
        {gridDays.map(day => {
          const key     = toDateStr(day);
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = key === today;
          const count   = (byDay[key] || []).length;
          const hasEmail   = (byDay[key] || []).some(e => e._type === "email");
          const hasCalendar = (byDay[key] || []).some(e => e._type === "calendar");

          return (
            <div
              key={key}
              onClick={() => onDayClick(day)}
              className={`bg-white min-h-20 p-2 cursor-pointer transition-colors hover:bg-gray-50
                ${!inMonth ? "opacity-40" : ""}`}
            >
              <div className={`w-7 h-7 flex items-center justify-center rounded-full text-xs font-semibold mb-1
                ${isToday ? "bg-brand text-white" : "text-gray-700"}`}>
                {day.getDate()}
              </div>
              {count > 0 && (
                <div className="space-y-0.5">
                  {hasCalendar && (
                    <div className="text-[10px] bg-brand-light text-brand rounded px-1.5 py-0.5 truncate font-medium">
                      {(byDay[key] || []).filter(e => e._type === "calendar").length} meeting{(byDay[key] || []).filter(e => e._type === "calendar").length !== 1 ? "s" : ""}
                    </div>
                  )}
                  {hasEmail && (
                    <div className="text-[10px] bg-purple-50 text-purple-700 rounded px-1.5 py-0.5 truncate font-medium">
                      {(byDay[key] || []).filter(e => e._type === "email").length} via email
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-400 mt-2 text-center">Click any day to see details</p>
    </div>
  );
}
