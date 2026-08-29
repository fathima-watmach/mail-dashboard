import React from "react";

export default function StatCard({ label, value, sub, color = "blue", onClick }) {
  const textColors = {
    blue:   "text-brand",
    red:    "text-red-500",
    amber:  "text-amber-500",
    orange: "text-orange-500",
    green:  "text-emerald-500",
  };

  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-gray-100 p-4 transition-shadow
        ${onClick ? "cursor-pointer hover:shadow-md hover:border-gray-200" : ""}`}
    >
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-0.5 ${textColors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      {onClick && <p className="text-[10px] text-gray-300 mt-1.5">Click to view →</p>}
    </div>
  );
}
