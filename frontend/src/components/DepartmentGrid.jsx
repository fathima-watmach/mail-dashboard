import React from "react";

const DEPT_COLORS = {
  "Sales": "border-brand bg-brand-light text-brand",
  "Pre-sales": "border-indigo-400 bg-indigo-50 text-indigo-700",
  "Operations & Procurement": "border-violet-400 bg-violet-50 text-violet-700",
  "Escalations": "border-red-400 bg-red-50 text-red-700",
  "Finance": "border-emerald-400 bg-emerald-50 text-emerald-700",
  "Projects": "border-amber-400 bg-amber-50 text-amber-700",
};

export default function DepartmentGrid({ buckets, onSelect, selected }) {
  const byDept = {};
  for (const b of buckets) {
    if (b.department === "Escalations" || !b.department) continue;
    if (!byDept[b.department]) byDept[b.department] = { action_needed: 0, fyi: 0 };
    byDept[b.department][b.urgency] = Number(b.count);
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {Object.entries(byDept).map(([dept, counts]) => {
        const total = counts.action_needed + counts.fyi;
        const color = DEPT_COLORS[dept] || "border-gray-300 bg-gray-50 text-gray-700";
        const isSelected = selected === dept;

        return (
          <button
            key={dept}
            onClick={() => onSelect(isSelected ? null : dept)}
            className={`text-left border-l-4 rounded-lg p-4 transition-all ${color}
              ${isSelected ? "ring-2 ring-offset-1 ring-current shadow-md" : "hover:shadow-sm"}`}
          >
            <p className="text-xs font-medium uppercase tracking-wide opacity-70 truncate">{dept}</p>
            <p className="text-3xl font-bold mt-1">{total}</p>
            <div className="flex gap-3 mt-2 text-xs opacity-80">
              {counts.action_needed > 0 && (
                <span className="font-medium">{counts.action_needed} action</span>
              )}
              {counts.fyi > 0 && (
                <span>{counts.fyi} fyi</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
