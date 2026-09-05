import React from "react";

// Clickable tile grid for property/client groups — same interaction pattern
// as DepartmentGrid.jsx (click to filter the list below to just that group,
// click again to clear), reused for both EmailTable's Inbox lists and
// UnattendedThreads' Unassigned view rather than the two building separate
// tile components.
export default function GroupTiles({ groups, selectedKey, onSelect }) {
  if (!groups.length) return null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
      {groups.map((g) => {
        const isSelected = selectedKey === g.key;
        return (
          <button
            key={g.key}
            onClick={() => onSelect(isSelected ? null : g.key)}
            className={`text-left border rounded-xl p-3.5 transition-all
              ${isSelected
                ? "border-brand bg-brand text-white shadow-md"
                : g.muted
                  ? "border-gray-200 border-dashed bg-white text-gray-500 hover:border-brand/30 hover:shadow-sm"
                  : "border-gray-100 bg-white text-gray-700 hover:border-brand/30 hover:shadow-sm"
              }`}
          >
            <p className={`text-xs font-medium uppercase tracking-wide truncate ${isSelected ? "text-white/70" : "text-gray-400"}`}>
              {g.label}
            </p>
            <p className={`text-2xl font-bold mt-0.5 ${isSelected ? "text-white" : g.muted ? "text-gray-500" : "text-brand"}`}>
              {g.count}
            </p>
            {g.customer && (
              <p className={`text-xs mt-1 truncate ${isSelected ? "text-white/70" : "text-gray-400"}`}>{g.customer}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
