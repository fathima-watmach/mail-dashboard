import React, { useState, useMemo } from "react";

function formatDay(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/**
 * Generic stacked-bar (+ optional line overlay) day chart. `series` is drawn
 * bottom-to-top in the given order; `lineSeries` (optional) shares the same
 * count axis — never a second y-scale, since these are the same unit.
 * series/lineSeries: {key, color, label}
 */
export default function TrendsChart({ days, series, lineSeries }) {
  const [showTable, setShowTable] = useState(false);

  const { maxTotal, maxLine } = useMemo(() => {
    const maxTotal = Math.max(1, ...days.map((d) => series.reduce((sum, s) => sum + (d[s.key] || 0), 0)));
    const maxLine = lineSeries ? Math.max(1, ...days.map((d) => d[lineSeries.key] || 0)) : 1;
    return { maxTotal, maxLine };
  }, [days, series, lineSeries]);

  if (!days.length) {
    return <p className="text-sm text-gray-400 text-center py-8">No email data in this range.</p>;
  }

  const width = 760;
  const height = 220;
  const padTop = 12;
  const padBottom = 28;
  const padLeft = 8;
  const padRight = 8;
  const plotH = height - padTop - padBottom;
  const plotW = width - padLeft - padRight;
  const n = days.length;
  const slot = plotW / n;
  const barW = Math.max(3, Math.min(28, slot * 0.55));
  const labelEvery = Math.max(1, Math.ceil(n / 10));

  const lineYFor = (count) => padTop + plotH - (count / maxLine) * plotH;
  const linePoints = lineSeries
    ? days.map((d, i) => `${padLeft + slot * i + slot / 2},${lineYFor(d[lineSeries.key] || 0)}`).join(" ")
    : "";

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-4 text-xs text-gray-600">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          {lineSeries && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: lineSeries.color }} />
              {lineSeries.label}
            </span>
          )}
        </div>
        <button
          onClick={() => setShowTable((x) => !x)}
          className="text-[11px] text-gray-400 hover:text-gray-600 underline underline-offset-2"
        >
          {showTable ? "View as chart" : "View as table"}
        </button>
      </div>

      {showTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100">
                <th className="text-left font-medium py-1.5">Day</th>
                {series.map((s) => <th key={s.key} className="text-right font-medium py-1.5">{s.label}</th>)}
                {lineSeries && <th className="text-right font-medium py-1.5">{lineSeries.label}</th>}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} className="border-b border-gray-50 text-gray-600">
                  <td className="py-1">{formatDay(d.day)}</td>
                  {series.map((s) => <td key={s.key} className="text-right">{d[s.key] || 0}</td>)}
                  {lineSeries && <td className="text-right">{d[lineSeries.key] || 0}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height: 220 }}>
          <line x1={padLeft} y1={padTop + plotH} x2={width - padRight} y2={padTop + plotH} stroke="#e5e7eb" strokeWidth="1" />

          {days.map((d, i) => {
            const x = padLeft + slot * i + (slot - barW) / 2;
            let yCursor = padTop + plotH;
            const segments = series.map((s) => {
              const val = d[s.key] || 0;
              const segH = (val / maxTotal) * plotH;
              const segY = yCursor - segH;
              yCursor = segY;
              return { ...s, val, segH, segY };
            });
            return (
              <g key={d.day}>
                <title>{`${formatDay(d.day)}: ${series.map((s) => `${d[s.key] || 0} ${s.label.toLowerCase()}`).join(", ")}${lineSeries ? `, ${d[lineSeries.key] || 0} ${lineSeries.label.toLowerCase()}` : ""}`}</title>
                {segments.map((seg, idx) => seg.val > 0 && (
                  <rect key={seg.key} x={x} y={seg.segY} width={barW} height={seg.segH} rx="2" fill={seg.color}
                    stroke="#fff" strokeWidth={idx > 0 ? 1 : 0} />
                ))}
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize="9" fill="#9ca3af">
                    {formatDay(d.day)}
                  </text>
                )}
              </g>
            );
          })}

          {lineSeries && (
            <>
              <polyline points={linePoints} fill="none" stroke={lineSeries.color} strokeWidth="2" />
              {days.map((d, i) => (d[lineSeries.key] || 0) > 0 && (
                <circle
                  key={`pt-${d.day}`}
                  cx={padLeft + slot * i + slot / 2}
                  cy={lineYFor(d[lineSeries.key])}
                  r="3.5"
                  fill={lineSeries.color}
                  stroke="#fff"
                  strokeWidth="1"
                >
                  <title>{`${formatDay(d.day)}: ${d[lineSeries.key]} ${lineSeries.label.toLowerCase()}`}</title>
                </circle>
              ))}
            </>
          )}
        </svg>
      )}
    </div>
  );
}
