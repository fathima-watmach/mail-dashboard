import React from "react";

const COLOR = "#2a78d6"; // validated categorical slot 1 (blue)

function formatWeek(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function ResponseTrendChart({ weeks, unitLabel = "Week of" }) {
  const points = weeks.filter((w) => w.avgHours != null);
  if (!points.length) {
    return <p className="text-sm text-gray-400 text-center py-8">Not enough thread activity in this range to compute a trend.</p>;
  }

  const width = 360;
  const height = 160;
  const pad = 24;
  const max = Math.max(...points.map((p) => p.avgHours));
  const min = Math.min(...points.map((p) => p.avgHours));
  const span = max - min || 1;

  const coords = points.map((p, i) => {
    const x = pad + (i * (width - pad * 2)) / Math.max(1, points.length - 1);
    const y = height - pad - ((p.avgHours - min) / span) * (height - pad * 2);
    return { ...p, x, y };
  });
  const path = coords.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${path} L${coords[coords.length - 1].x},${height - pad} L${coords[0].x},${height - pad} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: 160 }}>
      <defs>
        <linearGradient id="respGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={COLOR} stopOpacity="0.2" />
          <stop offset="100%" stopColor={COLOR} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#e5e7eb" strokeWidth="1" />
      <path d={area} fill="url(#respGrad)" />
      <path d={path} fill="none" stroke={COLOR} strokeWidth="2" />
      {/* Y-axis: hours to first reply — min/max labels since the curve is otherwise unitless */}
      <text x={pad} y={pad - 6} textAnchor="start" fontSize="9" fill="#9ca3af">{max}h</text>
      <text x={pad} y={height - pad + 10} textAnchor="start" fontSize="9" fill="#9ca3af">{min}h</text>
      {coords.map((p) => (
        <circle key={p.week} cx={p.x} cy={p.y} r="3.5" fill="#fff" stroke={COLOR} strokeWidth="2">
          <title>{`${unitLabel} ${formatWeek(p.week)}: ${p.avgHours}h avg first response`}</title>
        </circle>
      ))}
      {coords.map((p, i) => (i % Math.max(1, Math.ceil(coords.length / 6)) === 0) && (
        <text key={`lbl-${p.week}`} x={p.x} y={height - 6} textAnchor="middle" fontSize="9" fill="#9ca3af">
          {formatWeek(p.week)}
        </text>
      ))}
    </svg>
  );
}
