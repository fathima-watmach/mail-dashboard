import React from "react";
import InfoTip from "./InfoTip";

// Horizontal bar chart for the 4 "Needs Attention" categories — deliberately
// NOT a pie/donut: these categories overlap (an SLA breach can also be a
// critical escalation), so a chart implying they sum to a whole would
// misrepresent the data. Bars just compare relative magnitude, which is
// honest for overlapping counts. Scaled to the largest value among them so
// the chart stays legible even when one category dwarfs the others.
// SLA target hours per severity — mirrors SLA_CASE in backend/src/routes/dashboard.js exactly.
const SLA_RULES_TOOLTIP = "SLA targets (per Sariah's own targets): Critical 24h · High 2 days · Medium 2-3 days · Low 3-5 days (deadline uses the upper bound of a range)";

const CATEGORIES = [
  { key: "slaBreaches", label: "SLA Breaches", color: "bg-red-500", text: "text-red-600", tip: SLA_RULES_TOOLTIP },
  { key: "unassigned", label: "Unattended", color: "bg-orange-400", text: "text-orange-600" },
  {
    key: "criticalEscalations", label: "Critical Escalations", color: "bg-amber-400", text: "text-amber-700",
    tip: "Only escalations tagged CRITICAL severity that haven't been actioned yet — a narrower count than the 'Active Escalations' KPI up top, which includes every open escalation regardless of severity.",
  },
  { key: "needsReview", label: "Needs Review", color: "bg-gray-400", text: "text-gray-500" },
];

export default function AttentionChart({ summary, onSelect }) {
  const max = Math.max(1, ...CATEGORIES.map((c) => Number(summary[c.key]) || 0));

  return (
    <div className="space-y-3">
      {CATEGORIES.map((c) => {
        const value = Number(summary[c.key]) || 0;
        const pct = Math.max(2, Math.round((value / max) * 100));
        return (
          // A <button> can't contain another interactive element (the info
          // icon needs its own click, separate from "select this category"),
          // so this row is a div with its own click/keyboard handling instead.
          <div
            key={c.key}
            role="button"
            tabIndex={0}
            onClick={() => onSelect && onSelect(c.key)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect && onSelect(c.key); }}
            className="w-full text-left group cursor-pointer"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 group-hover:text-gray-700 transition-colors">
                {c.label}
                {c.tip && <InfoTip text={c.tip} />}
              </span>
              <span className={`text-sm font-bold ${c.text}`}>{value}</span>
            </div>
            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${c.color} transition-all group-hover:opacity-80`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
