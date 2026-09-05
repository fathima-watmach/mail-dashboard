import React from "react";
import StatCard from "./StatCard";
import TrendsChart from "./TrendsChart";
import ResponseTrendChart from "./ResponseTrendChart";
import ActivityHeatmap from "./ActivityHeatmap";
import { deltaSub } from "./shared";

const CATEGORY_LABEL = { urgent: "Urgent", reply: "Reply", fyi: "FYI" };
const CATEGORY_BADGE = {
  urgent: "bg-orange-50 text-orange-600",
  reply: "bg-blue-50 text-brand",
  fyi: "bg-gray-100 text-gray-500",
};

export default function AnalyticsView({ analytics, loading }) {
  if (loading || !analytics) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" /></div>;
  }

  const { kpis, volumeByDay, topSenders, responseTrend, heatmap } = analytics;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Emails processed" value={kpis.emailsProcessed.value} color="blue"
          sub={deltaSub(kpis.emailsProcessed.deltaPct)} />
        <StatCard label="Avg first response"
          value={kpis.avgFirstResponseHours.value != null ? `${kpis.avgFirstResponseHours.value}h` : "—"}
          color="blue" sub={deltaSub(kpis.avgFirstResponseHours.deltaPct)} />
        <StatCard label="Classification coverage"
          value={kpis.classificationCoverage.value != null ? `${kpis.classificationCoverage.value}%` : "—"}
          color="blue" sub="Successfully auto-classified" />
        <StatCard label="Open backlog" value={kpis.openBacklog.value} color="orange"
          sub={deltaSub(kpis.openBacklog.deltaPct)} />
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Volume by category</h2>
        <p className="text-xs text-gray-400 mb-4">Emails received per day</p>
        <TrendsChart
          days={volumeByDay}
          series={[
            { key: "low", color: "#9ca3af", label: "Low" },
            { key: "medium", color: "#f59e0b", label: "Medium" },
            { key: "high", color: "#fb923c", label: "High" },
            { key: "critical", color: "#dc2626", label: "Critical" },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Response time trend</h2>
          <p className="text-xs text-gray-400 mb-4">Avg. hours to first reply, daily</p>
          <ResponseTrendChart weeks={responseTrend} unitLabel="On" />
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Top senders</h2>
          <p className="text-xs text-gray-400 mb-4">By volume, in this range</p>
          {topSenders.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No email data in this range.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-left font-medium py-1.5">Sender</th>
                  <th className="text-left font-medium py-1.5">Mostly</th>
                  <th className="text-right font-medium py-1.5">Count</th>
                </tr>
              </thead>
              <tbody>
                {topSenders.map((s) => (
                  <tr key={s.fromEmail} className="border-b border-gray-50">
                    <td className="py-2 text-gray-700">{s.fromName || s.fromEmail}</td>
                    <td className="py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_BADGE[s.dominantCategory] || ""}`}>
                        {CATEGORY_LABEL[s.dominantCategory] || s.dominantCategory}
                      </span>
                    </td>
                    <td className="py-2 text-right text-gray-600 font-medium">{s.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Activity by hour</h2>
        <p className="text-xs text-gray-400 mb-4">When email actually lands, in this range</p>
        <ActivityHeatmap cells={heatmap} />
      </div>
    </div>
  );
}
