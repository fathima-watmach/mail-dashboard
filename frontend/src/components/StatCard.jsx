import React from "react";

const COLOR_TOKENS = {
  blue:   { text: "text-brand",       bg: "bg-brand-light",   icon: "text-brand" },
  red:    { text: "text-red-600",     bg: "bg-red-50",        icon: "text-red-500" },
  amber:  { text: "text-amber-600",   bg: "bg-amber-50",      icon: "text-amber-500" },
  orange: { text: "text-orange-600",  bg: "bg-orange-50",     icon: "text-orange-500" },
  green:  { text: "text-emerald-600", bg: "bg-emerald-50",    icon: "text-emerald-500" },
};

// Icon inferred from color, since each StatCard usage already picks a color
// that matches its meaning (volume=blue, critical=red, escalation=orange,
// confidence/success=green, action-needed=amber) — avoids a second prop
// every caller would have to keep in sync with color.
const ICONS = {
  blue:   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
  red:    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />,
  amber:  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4l2.5 2.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />,
  orange: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 13.5c0 2.5-2 4.5-5 4.5s-5-2-5-4.5c0-1.5 1-2.7 1.8-3.7.5-.6.7-1.4.5-2.3-.2-.9 0-1.7.5-2.5.9 1.1 1.4 2.4 1.5 3.7.9-1.3 1.4-3 1.2-4.7 1.7 1.3 3.2 3.3 3.6 5.4.2 1.2.2 2.6-.1 4.1z" />,
  green:  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12l2 2 4-4m5 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
};

export default function StatCard({ label, value, sub, color = "blue", onClick }) {
  const tokens = COLOR_TOKENS[color] || COLOR_TOKENS.blue;

  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-gray-100 p-4 transition-shadow
        ${onClick ? "cursor-pointer hover:shadow-md hover:border-gray-200" : ""}`}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</p>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${tokens.bg}`}>
          <svg className={`w-4 h-4 ${tokens.icon}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {ICONS[color] || ICONS.blue}
          </svg>
        </div>
      </div>
      <p className={`text-3xl font-bold mt-2 ${tokens.text}`}>{value}</p>
      {sub && (
        <span className={`inline-block text-[11px] font-medium mt-2 px-2 py-0.5 rounded-full ${tokens.bg} ${tokens.text}`}>
          {sub}
        </span>
      )}
      {onClick && <p className="text-[10px] text-gray-300 mt-2">Click to view →</p>}
    </div>
  );
}
