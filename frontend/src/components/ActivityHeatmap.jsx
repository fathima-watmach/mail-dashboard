import React from "react";

// Dataviz skill's sequential blue ramp (5 discrete steps, light→dark) rather
// than opacity-on-a-single-hue — a proper sequential encoding for magnitude.
const RAMP = ["#f3f4f6", "#b7d3f6", "#6da7ec", "#2a78d6", "#184f95"];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function levelFor(count, max) {
  if (count === 0) return 0;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export default function ActivityHeatmap({ cells }) {
  const grid = {};
  let max = 1;
  for (const c of cells) {
    grid[`${c.dow}-${c.hour}`] = c.count;
    if (c.count > max) max = c.count;
  }

  if (!cells.length) {
    return <p className="text-sm text-gray-400 text-center py-8">No email data in this range.</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="inline-grid gap-[3px]" style={{ gridTemplateColumns: "34px repeat(24, 1fr)" }}>
          {DOW_LABELS.map((label, dow) => (
            <React.Fragment key={dow}>
              <span className="text-[10px] text-gray-400 self-center">{label}</span>
              {Array.from({ length: 24 }, (_, hour) => {
                const count = grid[`${dow}-${hour}`] || 0;
                return (
                  <div
                    key={hour}
                    className="aspect-square rounded-sm"
                    style={{ background: RAMP[levelFor(count, max)], minWidth: 14 }}
                    title={`${label} ${hour}:00 — ${count} email${count === 1 ? "" : "s"}`}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>
        <div className="grid gap-[3px] mt-1" style={{ gridTemplateColumns: "34px repeat(24, 1fr)" }}>
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="text-[8px] text-gray-400 text-center">
              {hour % 4 === 0 ? `${hour}h` : ""}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-3 text-[10px] text-gray-400">
        Less
        {RAMP.map((c, i) => <span key={i} className="inline-block w-3 h-3 rounded-sm" style={{ background: c }} />)}
        More
      </div>
    </div>
  );
}
