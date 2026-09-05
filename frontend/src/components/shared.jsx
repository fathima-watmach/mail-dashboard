import React from "react";

// Shared rate/time-badge helpers, lifted out of Scores.jsx so Overview's new
// panels (Per-Person Load, Department Load, Responder Performance) render
// with the exact same visual language instead of a second copy.

export function pct(n, total) {
  if (!total) return 0;
  return Math.round((Number(n) / Number(total)) * 100);
}

export function RateBar({ value, total, color = "bg-brand" }) {
  const p = pct(value, total);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right">{p}%</span>
    </div>
  );
}

export function Badge({ value, color }) {
  if (!Number(value)) return <span className="text-gray-300 text-xs">—</span>;
  return <span className={`text-xs font-semibold ${color}`}>{value}</span>;
}

export function PendingTime({ hours }) {
  if (!hours) return <span className="text-gray-300 text-xs">—</span>;
  const h = Number(hours);
  if (h >= 48) {
    const days = Math.round(h / 24);
    return <span className="text-xs font-semibold text-red-500">{days}d waiting</span>;
  }
  if (h >= 24) return <span className="text-xs font-semibold text-orange-500">{Math.round(h)}h waiting</span>;
  return <span className="text-xs font-semibold text-amber-500">{Math.round(h)}h waiting</span>;
}

export function ResponseTime({ hours }) {
  if (hours == null) return <span className="text-gray-300 text-xs">—</span>;
  const h = Number(hours);
  const color = h <= 4 ? "text-green-600" : h <= 24 ? "text-amber-600" : "text-red-500";
  const label = h < 1 ? `${Math.round(h * 60)}m` : `${h}h`;
  return <span className={`text-xs font-semibold ${color}`}>{label}</span>;
}

// SLA target hours per severity tier — mirrors backend's SLA_CASE
// (dashboard.js) exactly, only used here to judge "approaching" (last 25% of
// the window), not to recompute the deadline itself (that's server-side).
// Real targets from Sariah's own MoM (01/09/2026) — mirrors SLA_HOURS in
// backend/src/routes/dashboard.js exactly.
const SLA_TARGET_HOURS = { critical: 24, high: 48, medium: 72, low: 120 };

// Per-row SLA countdown/breach badge — computed live from `deadline` at
// render time rather than a static server string, so it stays accurate for
// as long as the page is left open. `met` (already computed server-side —
// a coordinator reply for shared inboxes, actioned_at otherwise) suppresses
// the badge entirely: this flags risk, it doesn't need to celebrate success.
export function SlaBadge({ deadline, met, severity }) {
  if (!deadline || !severity || met) return null;
  const diffMs = new Date(deadline).getTime() - Date.now();
  const diffHours = diffMs / 3600000;

  if (diffMs <= 0) {
    const overdue = Math.abs(diffHours);
    const label = overdue >= 24 ? `${Math.round(overdue / 24)}d overdue` : `${Math.round(overdue)}h overdue`;
    return <span className="text-xs font-semibold text-red-600 bg-red-100 px-1.5 py-0.5 rounded whitespace-nowrap">🔴 SLA · {label}</span>;
  }

  const h = Math.floor(diffHours);
  const m = Math.round((diffHours - h) * 60);
  const label = h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  const approaching = diffHours <= (SLA_TARGET_HOURS[severity] || 24) * 0.25;
  const color = approaching ? "text-amber-700 bg-amber-100" : "text-gray-500 bg-gray-100";
  return (
    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${color}`}>
      {approaching ? "⚠ " : ""}SLA · {label}
    </span>
  );
}

export function deltaSub(deltaPct, unit = "") {
  if (deltaPct == null) return undefined;
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct}%${unit} vs. previous period`;
}

// 4-tier severity styling, extending the 2-tier convention already used in
// EscalationList.jsx (red=critical) and EmailTable.jsx (amber=action_needed,
// gray=fyi) — medium/high slot into that existing hue vocabulary rather than
// introducing new ones.
export const SEVERITY_STYLE = {
  critical: { dot: "bg-red-600",    badge: "text-red-600 bg-red-100",       row: "bg-red-50 border-red-200" },
  high:     { dot: "bg-orange-400", badge: "text-orange-600 bg-orange-100", row: "bg-orange-50 border-orange-100" },
  medium:   { dot: "bg-amber-500",  badge: "text-amber-700 bg-amber-100",   row: "bg-amber-50 border-amber-100" },
  low:      { dot: "bg-gray-400",   badge: "text-gray-500 bg-gray-100",     row: "bg-gray-50 border-gray-100" },
};

export const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export function SeverityBadge({ severity }) {
  if (!severity || !SEVERITY_STYLE[severity]) return null;
  const s = SEVERITY_STYLE[severity];
  return (
    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${s.badge}`}>
      {SEVERITY_LABEL[severity].toUpperCase()}
    </span>
  );
}

// Thread status (pending/ongoing/escalated/resolved — the requirements doc's
// own taxonomy, see services/threadTracking.js) — same badge convention as
// SEVERITY_STYLE, distinct hues so the two badge types are never confused.
export const STATUS_STYLE = {
  pending:   { badge: "text-gray-600 bg-gray-100" },
  ongoing:   { badge: "text-blue-600 bg-blue-50" },
  escalated: { badge: "text-orange-600 bg-orange-100" },
  resolved:  { badge: "text-green-700 bg-green-100" },
};
export const STATUS_LABEL = { pending: "Pending", ongoing: "Ongoing", escalated: "Escalated", resolved: "Resolved" };

export function StatusBadge({ status }) {
  if (!status || !STATUS_STYLE[status]) return null;
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[status].badge}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

// Coordinator action types (services/threadTracking.js) — plain-English labels.
export const ACTION_TYPE_LABEL = {
  acknowledged: "Acknowledged",
  requested_info: "Requested info",
  sent_quotation: "Sent quotation",
  followed_up: "Followed up",
  escalated: "Escalated",
  provided_update: "Provided update",
  confirmed_resolution: "Confirmed resolution",
};

// Frontend-only initials avatar — no backend/photo dependency.
export function InitialsAvatar({ name, email }) {
  const source = (name || email || "?").trim();
  const initials = source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";
  return (
    <div className="w-8 h-8 rounded-full bg-brand-light text-brand flex items-center justify-center text-xs font-semibold flex-shrink-0">
      {initials}
    </div>
  );
}
