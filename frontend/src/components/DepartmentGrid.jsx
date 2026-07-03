import React from "react";

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
        const isSelected = selected === dept;

        return (
          <button
            key={dept}
            onClick={() => onSelect(isSelected ? null : dept)}
            className={`text-left border rounded-xl p-4 transition-all
              ${isSelected
                ? "border-brand bg-brand text-white shadow-md"
                : "border-gray-100 bg-white text-gray-700 hover:border-brand/30 hover:shadow-sm"
              }`}
          >
            <p className={`text-xs font-medium uppercase tracking-wide truncate ${isSelected ? "text-white/70" : "text-gray-400"}`}>
              {dept}
            </p>
            <p className={`text-3xl font-bold mt-1 ${isSelected ? "text-white" : "text-brand"}`}>
              {total}
            </p>
            <div className={`flex gap-3 mt-2 text-xs ${isSelected ? "text-white/70" : "text-gray-400"}`}>
              {counts.action_needed > 0 && (
                <span className={`font-medium ${isSelected ? "text-white" : "text-gray-600"}`}>
                  {counts.action_needed} action
                </span>
              )}
              {counts.fyi > 0 && <span>{counts.fyi} fyi</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
