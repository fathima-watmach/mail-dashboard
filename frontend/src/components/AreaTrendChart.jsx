import React from "react";

// Smooth-curved two-line area chart — "mail volume vs. responses" style,
// same underlying data shape as TrendsChart's `days` prop but rendered as a
// filled area rather than stacked bars.
function smoothPath(pts) {
  if (pts.length < 2) return `M ${pts[0]?.x ?? 0} ${pts[0]?.y ?? 0}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i], p1 = pts[i + 1];
    const midX = (p0.x + p1.x) / 2;
    const midY = (p0.y + p1.y) / 2;
    d += ` Q ${p0.x} ${p0.y} ${midX} ${midY}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function formatDay(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function AreaTrendChart({ days }) {
  const points = days.map((d) => ({ day: d.day, received: (d.actionNeeded || 0) + (d.fyi || 0), responded: d.responded || 0 }));

  // Real bug fixed 2026-09-05: a single-day filter (e.g. "Sep 1 to Sep 1")
  // produces exactly one point — genuinely can't draw a two-point line/area
  // from that, but the old fallback below said "No email data in this
  // range" even when that one day had real, non-zero numbers. Only say
  // "no data" when there's truly nothing; show the actual figures directly
  // for the single-day case instead of hiding them.
  const hasAnyData = points.some((p) => p.received > 0 || p.responded > 0);
  if (!hasAnyData) {
    return <p className="text-sm text-gray-400 text-center py-8">No email data in this range.</p>;
  }
  if (points.length === 1) {
    const p = points[0];
    return (
      <div className="flex items-center justify-center gap-12 py-10">
        <div className="text-center">
          <p className="text-3xl font-bold text-navy">{p.received}</p>
          <p className="text-xs text-gray-400 mt-1.5">Received &middot; {formatDay(p.day)}</p>
        </div>
        <div className="text-center">
          <p className="text-3xl font-bold" style={{ color: "#8ba0c9" }}>{p.responded}</p>
          <p className="text-xs text-gray-400 mt-1.5">Responded &middot; {formatDay(p.day)}</p>
        </div>
      </div>
    );
  }

  const width = 640, height = 220, pad = 32;
  const maxVal = Math.max(1, ...points.map((p) => Math.max(p.received, p.responded)));

  const scaled = points.map((p, i) => ({
    ...p,
    x: pad + (i * (width - pad * 2)) / Math.max(1, points.length - 1),
    yReceived: height - pad - (p.received / maxVal) * (height - pad * 2),
    yResponded: height - pad - (p.responded / maxVal) * (height - pad * 2),
  }));

  const receivedPath = smoothPath(scaled.map((p) => ({ x: p.x, y: p.yReceived })));
  const respondedPath = smoothPath(scaled.map((p) => ({ x: p.x, y: p.yResponded })));
  const baseline = height - pad;
  const receivedArea = `${receivedPath} L ${scaled[scaled.length - 1].x} ${baseline} L ${scaled[0].x} ${baseline} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: height - pad - f * (height - pad * 2),
    value: Math.round(maxVal * f),
  }));
  const labelEvery = Math.max(1, Math.ceil(scaled.length / 7));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: 240 }}>
      <defs>
        <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0b1634" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#0b1634" stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((t) => (
        <g key={t.y}>
          <line x1={pad} y1={t.y} x2={width - pad} y2={t.y} stroke="#eef1f7" strokeWidth="1" />
          <text x={4} y={t.y + 3} fontSize="9" fill="#9ca3af">{t.value}</text>
        </g>
      ))}

      <path d={receivedArea} fill="url(#volGrad)" />
      <path d={receivedPath} fill="none" stroke="#0b1634" strokeWidth="2" />
      <path d={respondedPath} fill="none" stroke="#8ba0c9" strokeWidth="2" />

      {scaled.map((p) => (
        <circle key={`r-${p.day}`} cx={p.x} cy={p.yReceived} r="2.5" fill="#0b1634">
          <title>{`${formatDay(p.day)}: ${p.received} received`}</title>
        </circle>
      ))}
      {scaled.map((p) => (
        <circle key={`p-${p.day}`} cx={p.x} cy={p.yResponded} r="2.5" fill="#8ba0c9">
          <title>{`${formatDay(p.day)}: ${p.responded} responded`}</title>
        </circle>
      ))}

      {scaled.map((p, i) => (i % labelEvery === 0) && (
        <text key={`lbl-${p.day}`} x={p.x} y={height - 8} textAnchor="middle" fontSize="9" fill="#9ca3af">
          {formatDay(p.day)}
        </text>
      ))}
    </svg>
  );
}
