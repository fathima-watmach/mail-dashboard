import React, { useEffect, useState } from "react";
import { pct, RateBar, Badge, PendingTime, ResponseTime } from "../components/shared";
import { BASE } from "../api";

export default function Scores() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView]     = useState("sender");

  useEffect(() => {
    fetch(`${BASE}/api/dashboard/scores`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        // Coordinator scores (shared-inbox staff identified by signature) are
        // the primary Phase 1 view when they exist — default straight to it
        // instead of the domain-based sender view, which is mostly empty for
        // a shared-inbox-only client.
        if (d.coordinators?.length > 0) setView("coordinator");
      })
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

  const depts        = data?.departments  || [];
  const senders      = data?.senders      || [];
  const coordinators = data?.coordinators || [];
  const directRecipients = data?.directRecipients || [];
  const domain       = data?.domain       || "your domain";

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
        {[
          ...(coordinators.length > 0 ? [["coordinator", "Coordinators"]] : []),
          // Domain-based "Team" view isn't meaningful for a shared-inbox-only
          // client like Sariah — coordinators don't have their own @domain
          // mailboxes, so this stays empty. Only shown when there are no
          // coordinators to begin with (e.g. POSBank, where it's real).
          ...(coordinators.length === 0 ? [["sender", `Team (${domain})`]] : []),
          ["dept", "By Department"],
          ...(directRecipients.length > 0 ? [["direct", "Direct Recipients"]] : []),
        ].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 text-sm transition-colors ${view === v ? "bg-brand text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Coordinator view — shared-inbox staff identified by signature */}
      {view === "coordinator" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {coordinators.length === 0 ? (
            <p className="text-center py-10 text-gray-400 text-sm">No coordinator-attributed replies found.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Coordinator</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Mailbox</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Replies Sent</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Escalations</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Critical</th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Avg Response Time</th>
                </tr>
              </thead>
              <tbody>
                {coordinators.map((c) => (
                  <tr key={c.coordinator} className={`border-b border-gray-50 hover:bg-gray-50 transition-colors ${c.is_unattributed ? "bg-gray-50/60" : ""}`}>
                    <td className="py-3 px-4">
                      <p className={c.is_unattributed ? "italic text-gray-500" : "font-medium text-gray-800"}>{c.coordinator}</p>
                      {c.is_unattributed && (
                        <p className="text-xs text-gray-400">Real reply sent, but no name in the signature to match</p>
                      )}
                      {c.role && <p className="text-xs text-brand">{c.role}</p>}
                    </td>
                    <td className="py-3 px-4 text-gray-500 text-xs">{c.mailbox}</td>
                    <td className="py-3 px-4 text-right text-gray-700 font-medium">{c.replies_sent}</td>
                    <td className="py-3 px-4 text-right">
                      <Badge value={c.escalations_handled} color="text-orange-500" />
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Badge value={c.critical_handled} color="text-red-600" />
                    </td>
                    <td className="py-3 px-4 text-right">
                      <ResponseTime hours={c.avg_response_hours} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

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

      {/* Direct Recipients — Sariah's own list of individual staff mailboxes
          that need monitoring (Action_Taken_MoM_01-09-2026.pdf, "Email
          Addresses — Office Staff Attention"). Counts mail where that
          address is directly in the To: line of a shared-inbox email —
          distinct from Coordinators (who signed a reply) and Departments
          (classification-based): this is "how much mail is really meant
          for this specific person," regardless of who ends up replying. */}
      {view === "direct" && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Staff Mailbox</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Emails</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Action Needed</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Escalations</th>
                <th className="text-right py-3 px-4 text-xs font-semibold text-gray-400 uppercase tracking-wide">Critical</th>
              </tr>
            </thead>
            <tbody>
              {directRecipients.map((r) => (
                <tr key={r.address} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                  <td className="py-3 px-4 font-medium text-gray-800">{r.address}</td>
                  <td className="py-3 px-4 text-right text-gray-700 font-medium">{r.total_emails}</td>
                  <td className="py-3 px-4 text-right">
                    <Badge value={r.action_needed} color="text-amber-600" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Badge value={r.escalations} color="text-orange-500" />
                  </td>
                  <td className="py-3 px-4 text-right">
                    <Badge value={r.critical} color="text-red-600" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 px-4 py-3 border-t border-gray-100">
            Emails where this address is directly in the To: line of a contactus@/maintenance@ email — per Sariah's own list of staff mailboxes needing attention.
          </p>
        </div>
      )}

      <p className="text-xs text-gray-400">
        <strong>Pending Response</strong>: how long the oldest unanswered action-needed email has been waiting.
        <strong> Avg Response Time</strong>: average turnaround time per email thread (computed from consecutive messages in the same thread).
      </p>
    </div>
  );
}
