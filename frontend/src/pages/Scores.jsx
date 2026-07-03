import React, { useEffect, useState } from "react";

function pct(n, total) {
  if (!total) return 0;
  return Math.round((Number(n) / Number(total)) * 100);
}

function RateBar({ value, total, color = "bg-brand" }) {
  const p = pct(value, total);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right">{p}%</span>
    </div>
  );
}

function Badge({ value, color }) {
  if (!Number(value)) return <span className="text-gray-300 text-xs">—</span>;
  return <span className={`text-xs font-semibold ${color}`}>{value}</span>;
}

function PendingTime({ hours }) {
  if (!hours) return <span className="text-gray-300 text-xs">—</span>;
  const h = Number(hours);
  if (h >= 48) {
    const days = Math.round(h / 24);
    return <span className="text-xs font-semibold text-red-500">{days}d waiting</span>;
  }
  if (h >= 24) return <span className="text-xs font-semibold text-orange-500">{Math.round(h)}h waiting</span>;
  return <span className="text-xs font-semibold text-amber-500">{Math.round(h)}h waiting</span>;
}

function ResponseTime({ hours }) {
  if (hours == null) return <span className="text-gray-300 text-xs">—</span>;
  const h = Number(hours);
  const color = h <= 4 ? "text-green-600" : h <= 24 ? "text-amber-600" : "text-red-500";
  return <span className={`text-xs font-semibold ${color}`}>{h < 1 ? "<1h" : `${h}h`}</span>;
}

export default function Scores() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView]     = useState("sender");

  useEffect(() => {
    fetch("/api/dashboard/scores", { credentials: "include" })
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" />
      </div>
    );
  }

  const depts   = data?.departments || [];
  const senders = data?.senders     || [];
  const domain  = data?.domain      || "your domain";

  const totalEmails    = depts.reduce((s, d) => s + Number(d.total_emails), 0);
  const totalAction    = depts.reduce((s, d) => s + Number(d.action_needed), 0);
  const totalEscalated = depts.reduce((s, d) => s + Number(d.escalations), 0);
  const totalCritical  = depts.reduce((s, d) => s + Number(d.critical), 0);

  return (
    <div className="space-y-6">
      {/* Top summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total emails",   value: totalEmails,    color: "text-gray-800" },
          { label: "Need action",    value: totalAction,    color: totalAction > 0 ? "text-amber-600" : "text-gray-400" },
          { label: "Escalations",    value: totalEscalated, color: totalEscalated > 0 ? "text-orange-600" : "text-gray-400" },
          { label: "Critical",       value: totalCritical,  color: totalCritical > 0 ? "text-red-600" : "text-gray-400" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-xs text-gray-400">{s.label}</p>
            <p className={`text-2xl font-bold mt-0.5 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* View toggle */}
      <div className="flex rounded-lg border border-gray-200 overflow-hidden w-fit">
        {[["sender", `Team (${domain})`], ["dept", "By Department"]].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 text-sm transition-colors ${view === v ? "bg-brand text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Employee view — posbank.in only */}
      {view === "sender" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {senders.length === 0 ? (
            <p className="text-center py-10 text-gray-400 text-sm">No emails from {domain} found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Employee</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Emails</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Escalations</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Pending Response</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Avg Response Time</th>
                </tr>
              </thead>
              <tbody>
                {senders.map((s) => (
                  <tr key={s.from_email} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-4">
                      <p className="font-medium text-gray-800">{s.sender}</p>
                      <p className="text-xs text-gray-400">{s.from_email}</p>
                      {s.role_label && <p className="text-xs text-brand">{s.role_label}</p>}
                      {s.department && <p className="text-xs text-gray-400">{s.department}</p>}
                    </td>
                    <td className="py-3 px-4 text-right text-gray-700 font-medium">{s.total_emails}</td>
                    <td className="py-3 px-4 text-right">
                      <Badge value={s.escalations} color="text-orange-500" />
                    </td>
                    <td className="py-3 px-4 text-right">
                      <PendingTime hours={s.longest_pending_hours} />
                    </td>
                    <td className="py-3 px-4 text-right">
                      <ResponseTime hours={s.avg_response_hours} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Department view */}
      {view === "dept" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Department</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Emails</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Escalations</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Critical</th>
                <th className="py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide min-w-36">Escalation Rate</th>
                <th className="py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide min-w-36">Action Needed Rate</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Pending Response</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Avg Response</th>
              </tr>
            </thead>
            <tbody>
              {depts.map((d) => (
                <tr key={d.department} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="py-3 px-4 font-medium text-gray-800">{d.department}</td>
                  <td className="py-3 px-4 text-right text-gray-700 font-medium">{d.total_emails}</td>
                  <td className="py-3 px-4 text-right">
                    <Badge value={d.escalations} color="text-orange-500" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Badge value={d.critical} color="text-red-600" />
                  </td>
                  <td className="py-3 px-4">
                    <RateBar value={d.escalations} total={d.total_emails}
                      color={pct(d.escalations, d.total_emails) > 20 ? "bg-red-400" : "bg-orange-300"} />
                  </td>
                  <td className="py-3 px-4">
                    <RateBar value={d.action_needed} total={d.total_emails}
                      color={pct(d.action_needed, d.total_emails) > 30 ? "bg-amber-500" : "bg-amber-300"} />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <PendingTime hours={d.longest_pending_hours} />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <ResponseTime hours={d.avg_response_hours} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        <strong>Pending Response</strong>: how long the oldest unanswered action-needed email has been waiting.
        <strong> Avg Response Time</strong>: average turnaround time per email thread (computed from consecutive messages in the same thread).
      </p>
    </div>
  );
}
