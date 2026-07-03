import React from "react";

export default function StatCard({ label, value, sub, color = "blue", icon }) {
  const textColors = {
    blue:  "text-brand",
    red:   "text-red-500",
    amber: "text-amber-500",
    green: "text-emerald-500",
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold mt-1 ${textColors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}
