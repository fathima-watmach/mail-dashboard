import React, { useEffect, useState, useCallback } from "react";
import { getSummary, getBuckets, getEscalations, getActionNeeded, getEmails, getTrends, getAnalytics, getScores, getUnattended, getAttentionSummary, getThreadStatusSummary, getThreadStatusTrend, getSlaBreaches, getCriticalEscalations, getNeedsReview, logout, searchEmails } from "../api";
import StatCard from "../components/StatCard";
import DepartmentGrid from "../components/DepartmentGrid";
import EscalationList from "../components/EscalationList";
import EmailTable from "../components/EmailTable";
import AnalyticsView from "../components/AnalyticsView";
import { LoadPanel, ResponderPerformance, UnattendedThreads } from "../components/OverviewPanels";
import AttentionChart from "../components/AttentionChart";
import { deltaSub } from "../components/shared";
import AreaTrendChart from "../components/AreaTrendChart";
import TrendsChart from "../components/TrendsChart";
import Sidebar from "../components/Sidebar";
import People from "./People";
import Calendar from "./Calendar";
import Scores from "./Scores";

function financialYearStart() {
  const now = new Date();
  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(fyYear, 3, 1).toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function startOfWeek() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

const DATE_PRESETS = [
  { label: "Today", from: () => today(), to: () => today() },
  { label: "Yesterday", from: () => daysAgo(1), to: () => daysAgo(1) },
  { label: "This Week", from: () => startOfWeek(), to: () => today() },
];

// SLA target hours per severity — mirrors SLA_CASE in backend/src/routes/dashboard.js exactly.
const SLA_RULES_TOOLTIP = "SLA targets (per Sariah's own targets): Critical 24h · High 2 days · Medium 2-3 days · Low 3-5 days (deadline uses the upper bound of a range)";

const INBOX_SUBTABS = [
  { key: "action", label: "Action Needed", attentionKey: null },
  { key: "all", label: "All Emails", attentionKey: null },
  { key: "unassigned", label: "Unattended", attentionKey: "unassigned" },
  { key: "sla", label: "SLA Breaches", attentionKey: "slaBreaches", title: SLA_RULES_TOOLTIP },
  { key: "critical", label: "Critical Escalations", attentionKey: "criticalEscalations", title: "Only escalations tagged CRITICAL severity that haven't been actioned yet — narrower than the Overview 'Active Escalations' KPI, which includes every open escalation regardless of severity." },
  { key: "review", label: "Needs Review", attentionKey: "needsReview" },
];

export default function Dashboard({ user, onLogout }) {
  const [summary, setSummary] = useState({ total: 0, critical: 0, actionNeeded: 0, escalations: 0 });
  const [buckets, setBuckets] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [actionEmails, setActionEmails] = useState([]);
  const [allEmails, setAllEmails] = useState([]);
  const [trends, setTrends] = useState([]);
  const [selectedDept, setSelectedDept] = useState(null);
  const [allEmailsLoading, setAllEmailsLoading] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [scores, setScores] = useState({ departments: [], senders: [], coordinators: [] });
  const [unattended, setUnattended] = useState([]);
  const [attention, setAttention] = useState(null);
  const [threadStatus, setThreadStatus] = useState(null);
  const [threadStatusTrend, setThreadStatusTrend] = useState([]);
  const [inboxSubTab, setInboxSubTab] = useState("action");
  const [slaBreaches, setSlaBreaches] = useState([]);
  const [slaBreachesLoading, setSlaBreachesLoading] = useState(false);
  const [criticalEsc, setCriticalEsc] = useState([]);
  const [criticalEscLoading, setCriticalEscLoading] = useState(false);
  const [needsReview, setNeedsReview] = useState([]);
  const [needsReviewLoading, setNeedsReviewLoading] = useState(false);

  // Coordinators (shared-inbox staff identified by signature — see AGENTS.md's
  // coordinator_roster note) take priority over the domain-based `senders` list
  // for per-person views, since for a client like Sariah the real per-person
  // breakdown lives there, not in `senders` (which reflects mail from internal
  // colleagues' own addresses, a different and mostly-empty concept for a
  // shared-inbox-only client). Falls back to `senders` when there are none.
  const perPersonRows = (scores.coordinators?.length > 0
    ? scores.coordinators.map((c) => ({
        sender: c.coordinator,
        from_email: c.mailbox,
        total_emails: Number(c.replies_sent),
        action_needed: Number(c.escalations_handled),
        avg_response_hours: c.avg_response_hours,
      }))
    : scores.senders) || [];
  const [tab, setTab] = useState("overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [range, setRange] = useState({ from: financialYearStart(), to: today() });
  const [askBeaconTip, setAskBeaconTip] = useState(false);

  const loadSummary = useCallback(() =>
    getSummary(range).then(setSummary).catch(console.error), [range]);

  useEffect(() => {
    loadSummary();
    getBuckets(range).then((d) => setBuckets(d.buckets)).catch(console.error);
    getEscalations(false, range).then((d) => setEscalations(d.escalations)).catch(console.error);
    getActionNeeded(range).then((d) => setActionEmails(d.emails)).catch(console.error);
    getTrends(range).then((d) => setTrends(d.days)).catch(console.error);
    // Overview's KPIs (AI confidence, SLA rate, severity chart) and the
    // Analytics tab both read from the same /analytics response — one shared
    // fetch, kept in sync with the date range regardless of which tab is open.
    setAnalyticsLoading(true);
    getAnalytics(range).then(setAnalytics).catch(console.error).finally(() => setAnalyticsLoading(false));
    // Now genuinely range-scoped (real bug fixed 2026-09-05: filtering
    // Overview to a single day still showed all-time SLA Breaches/
    // Unassigned/Critical Escalations/Needs Review counts and all-time
    // Responder Performance/Per-Person/Department Load — neither
    // /attention-summary nor /scores accepted from/to at all server-side,
    // and this effect never asked for it even after that was fixed).
    getScores(range).then(setScores).catch(console.error);
    getUnattended(range).then((d) => setUnattended(d.unattended)).catch(console.error);
    getAttentionSummary(range).then(setAttention).catch(console.error);
    getThreadStatusSummary(range).then(setThreadStatus).catch(console.error);
    getThreadStatusTrend(range).then((d) => setThreadStatusTrend(d.days)).catch(console.error);
  }, [range]);

  useEffect(() => {
    if (tab !== "inbox" || inboxSubTab !== "all") return;
    setAllEmailsLoading(true);
    getEmails(selectedDept, range)
      .then((d) => setAllEmails(d.emails))
      .catch(console.error)
      .finally(() => setAllEmailsLoading(false));
  }, [tab, inboxSubTab, selectedDept, range]);

  useEffect(() => {
    if (tab !== "inbox" || inboxSubTab !== "sla") return;
    setSlaBreachesLoading(true);
    getSlaBreaches(range).then((d) => setSlaBreaches(d.emails)).catch(console.error).finally(() => setSlaBreachesLoading(false));
  }, [tab, inboxSubTab, range]);

  useEffect(() => {
    if (tab !== "inbox" || inboxSubTab !== "critical") return;
    setCriticalEscLoading(true);
    getCriticalEscalations(range).then((d) => setCriticalEsc(d.emails)).catch(console.error).finally(() => setCriticalEscLoading(false));
  }, [tab, inboxSubTab, range]);

  useEffect(() => {
    if (tab !== "inbox" || inboxSubTab !== "review") return;
    setNeedsReviewLoading(true);
    getNeedsReview(range).then((d) => setNeedsReview(d.emails)).catch(console.error).finally(() => setNeedsReviewLoading(false));
  }, [tab, inboxSubTab, range]);

  const handleLogout = async () => { await logout(); onLogout(); };

  const ATTENTION_KEY_TO_SUBTAB = { slaBreaches: "sla", unassigned: "unassigned", criticalEscalations: "critical", needsReview: "review" };
  const goToInbox = (subTab) => { setTab("inbox"); setInboxSubTab(subTab); };

  const handleSearch = async (q) => {
    const trimmed = q.trim();
    if (!trimmed) { setSearchActive(false); setSearchResults([]); return; }
    setSearchActive(true);
    setSearchLoading(true);
    try {
      const data = await searchEmails(trimmed);
      setSearchResults(data.emails || []);
    } catch {}
    setSearchLoading(false);
  };

  const clearSearch = () => {
    setSearchActive(false);
    setSearchQuery("");
    setSearchResults([]);
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar tab={tab} setTab={setTab} summary={summary} user={user} onLogout={handleLogout} />

      <main className="flex-1 min-w-0 px-4 sm:px-6 py-6">
        {/* Global search */}
        <div className="flex items-start gap-2 mb-6">
          <div className="relative max-w-xl flex-1">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSearch(searchQuery); if (e.key === "Escape") clearSearch(); }}
              placeholder="Search emails…"
              className="w-full bg-white text-gray-700 placeholder-gray-400 border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-brand shadow-sm"
            />
            <svg className="absolute left-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setAskBeaconTip((x) => !x)}
              className="flex items-center gap-1.5 text-sm font-medium text-brand bg-brand-light border border-brand-light hover:border-brand rounded-lg px-3 py-2 shadow-sm transition-colors"
            >
              ✨ Ask Beacon
            </button>
            {askBeaconTip && (
              <div className="absolute right-0 mt-2 w-56 bg-navy text-white text-xs rounded-lg shadow-lg p-3 z-10">
                Ask questions in plain English about your inbox — coming soon.
              </div>
            )}
          </div>
        </div>

        {/* Shared date range — was Overview-only; Inbox reads the exact same
            `range` state (see the fetch effects above), so the control
            needs to be reachable from there too, not just Overview. */}
        {!searchActive && (tab === "overview" || tab === "inbox") && (
          <div className="flex items-center gap-2 flex-wrap mb-6">
            <span className="text-xs text-gray-400">Showing emails:</span>
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-full px-3 py-1 focus:outline-none focus:border-brand"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              max={today()}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-full px-3 py-1 focus:outline-none focus:border-brand"
            />
            <div className="h-4 w-px bg-gray-200 mx-1" />
            {DATE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setRange({ from: p.from(), to: p.to() })}
                className="text-xs text-gray-500 bg-gray-50 hover:bg-brand-light hover:text-brand border border-gray-100 rounded-full px-3 py-1 transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* Search results panel */}
        {searchActive && (
          <div className="mb-6 bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-gray-700">
                Search: <span className="text-brand">"{searchQuery}"</span>
                {!searchLoading && (
                  <span className="font-normal text-gray-400 ml-2">— {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}</span>
                )}
              </h2>
              <button onClick={clearSearch} className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-100">
                Clear ✕
              </button>
            </div>
            <EmailTable emails={searchResults} loading={searchLoading} onActionToggle={loadSummary} currentUserEmail={user?.email} />
          </div>
        )}

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatCard label="Total Volume" value={summary.total} color="blue"
                sub={analytics ? deltaSub(analytics.kpis.emailsProcessed.deltaPct) : "Action today"}
                onClick={() => goToInbox("all")} />
              <StatCard label="Active Escalations" value={summary.escalations} color="orange"
                sub={
                  analytics?.kpis.escalationAvgResolutionMinutes.value != null
                    ? `${analytics.kpis.escalationAvgResolutionMinutes.value}min avg resolution`
                    : "Needs attention"
                }
                onClick={() => setTab("escalations")} />
              <StatCard label="AI Confidence"
                value={analytics?.kpis.aiConfidence.value != null ? `${analytics.kpis.aiConfidence.value}%` : "—"}
                color="green" sub={analytics ? (deltaSub(analytics.kpis.aiConfidence.deltaPct) || "Avg. classifier confidence") : undefined} />
              <StatCard label="SLA Response Rate"
                value={analytics?.kpis.slaResponseRate.value != null ? `${analytics.kpis.slaResponseRate.value}%` : "—"}
                color={analytics?.kpis.slaResponseRate.value >= 80 ? "green" : analytics?.kpis.slaResponseRate.value >= 50 ? "amber" : "red"}
                sub={analytics ? (deltaSub(analytics.kpis.slaResponseRate.deltaPct) || "Replied within target") : undefined} />
              <StatCard label="Classification Coverage"
                value={analytics?.kpis.classificationCoverage.value != null ? `${analytics.kpis.classificationCoverage.value}%` : "—"}
                color={analytics?.kpis.classificationCoverage.value >= 90 ? "green" : "amber"}
                sub={analytics ? `${analytics.kpis.classificationCoverage.unclassifiedCount ?? 0} unclassified` : undefined} />
            </div>

            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-1">Mail Volume</h2>
              <p className="text-xs text-gray-400 mb-4">Received vs. replied, per day</p>
              <AreaTrendChart days={trends} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-semibold text-gray-700">Volume by Category</h2>
                  <button onClick={() => setTab("escalations")} className="text-xs text-brand hover:underline">
                    View escalations
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-4">Critical / high / medium / low, per day</p>
                {analyticsLoading || !analytics ? (
                  <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand" /></div>
                ) : (
                  <TrendsChart
                    days={analytics.volumeByDay}
                    series={[
                      { key: "low", color: "#9ca3af", label: "Low" },
                      { key: "medium", color: "#f59e0b", label: "Medium" },
                      { key: "high", color: "#fb923c", label: "High" },
                      { key: "critical", color: "#dc2626", label: "Critical" },
                    ]}
                  />
                )}
              </div>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-1">Thread Status Trend</h2>
                <p className="text-xs text-gray-400 mb-4">Latest status per thread, per day it received mail</p>
                {threadStatusTrend.length > 0 ? (
                  <TrendsChart
                    days={threadStatusTrend}
                    series={[
                      { key: "pending", color: "#6b7280", label: "Pending" },
                      { key: "ongoing", color: "#2563eb", label: "Ongoing" },
                      { key: "escalated", color: "#ea580c", label: "Escalated" },
                      { key: "resolved", color: "#16a34a", label: "Resolved" },
                      { key: "reopened", color: "#dc2626", label: "Reopened" },
                    ]}
                  />
                ) : (
                  <p className="text-sm text-gray-400 text-center py-8">No analyzed threads in this range yet — status is generated as threads are opened or backfilled.</p>
                )}
              </div>
            </div>

            {attention && (
              <div className="bg-white rounded-xl border border-orange-200 shadow-sm p-5">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-semibold text-gray-700">Needs Attention</h2>
                  <button onClick={() => goToInbox("action")} className="text-xs text-brand hover:underline">
                    Open Inbox
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-4">Click a bar to jump to that view. Categories overlap — bars compare magnitude, not share of a whole.</p>
                <AttentionChart summary={attention} onSelect={(key) => goToInbox(ATTENTION_KEY_TO_SUBTAB[key])} />
              </div>
            )}

            {threadStatus && (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-semibold text-gray-700">Thread Status</h2>
                  {threadStatus.totalThreads > 0 && (
                    <span className="text-xs text-gray-400">
                      {threadStatus.analyzed} of {threadStatus.totalThreads} threads analyzed
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mb-4">
                  Coordinator-facing status of each thread, generated on demand as threads are opened — coverage grows as more get viewed, not a full count of every thread yet.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {[
                    { key: "pending", label: "Pending", color: "text-gray-500" },
                    { key: "ongoing", label: "Ongoing", color: "text-blue-600" },
                    { key: "escalated", label: "Escalated", color: "text-orange-600" },
                    { key: "resolved", label: "Resolved", color: "text-green-600" },
                    { key: "reopened", label: "Reopened", color: "text-red-600" },
                  ].map(({ key, label, color }) => (
                    <div key={key} className="text-center">
                      <p className={`text-2xl font-bold ${color}`}>{threadStatus.byStatus[key] ?? 0}</p>
                      <p className="text-xs text-gray-400 mt-1">{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-1">Responder Performance</h2>
                <p className="text-xs text-gray-400 mb-4">Fastest average reply time</p>
                <ResponderPerformance senders={perPersonRows} />
              </div>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-1">Per-Person Load</h2>
                <p className="text-xs text-gray-400 mb-4">Share of total reply volume handled by each person</p>
                <LoadPanel rows={perPersonRows} nameKey="sender" nameLabel="Person"
                  loadValue={(r) => r.total_emails}
                  loadTotal={(r, rows) => rows.reduce((sum, x) => sum + Number(x.total_emails), 0)}
                  loadTooltip="Load % = replies this person sent ÷ total replies sent by everyone. A high % means they're handling a large share of the team's total reply workload." />
              </div>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-1">Department Load</h2>
                <p className="text-xs text-gray-400 mb-4">Action-needed share of each department's mail</p>
                <LoadPanel rows={scores.departments} nameKey="department" nameLabel="Department"
                  loadTooltip="Load % = action-needed emails ÷ total emails for this department." />
              </div>
            </div>
          </div>
        )}

        {/* ── DEPARTMENTS ── */}
        {tab === "departments" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">By Department</h2>
            <DepartmentGrid buckets={buckets} selected={selectedDept}
              onSelect={(d) => { setSelectedDept(d); goToInbox("all"); }} />
          </div>
        )}

        {/* ── ESCALATIONS ── */}
        {tab === "escalations" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Escalations</h2>
            <EscalationList escalations={escalations} currentUserEmail={user?.email} />
          </div>
        )}

        {/* ── INBOX (merged All Emails / Action Needed, with attention sub-views) ── */}
        {tab === "inbox" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-1 mb-4 border-b border-gray-100 pb-0 overflow-x-auto">
              {INBOX_SUBTABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setInboxSubTab(t.key)}
                  title={t.title}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t whitespace-nowrap transition-colors border-b-2 -mb-px
                    ${inboxSubTab === t.key ? "border-brand text-brand" : "border-transparent text-gray-400 hover:text-gray-600"}`}
                >
                  {t.label}
                  {attention && t.attentionKey != null && (
                    <span className="ml-1.5 bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full text-[10px]">{attention[t.attentionKey]}</span>
                  )}
                </button>
              ))}
              {selectedDept && (
                <button onClick={() => setSelectedDept(null)}
                  className="ml-auto text-xs bg-brand-light text-brand px-3 py-1 rounded-full hover:bg-brand hover:text-white transition-colors flex-shrink-0">
                  {selectedDept} ✕
                </button>
              )}
            </div>

            {inboxSubTab === "action" && (
              <EmailTable emails={actionEmails} loading={false} onActionToggle={loadSummary} groupByProperty currentUserEmail={user?.email} />
            )}
            {inboxSubTab === "all" && (
              <EmailTable emails={allEmails} loading={allEmailsLoading} onActionToggle={loadSummary} groupByProperty currentUserEmail={user?.email} />
            )}
            {inboxSubTab === "unassigned" && (
              <UnattendedThreads threads={unattended} onActionToggle={loadSummary} currentUserEmail={user?.email} />
            )}
            {inboxSubTab === "sla" && (
              <EmailTable emails={slaBreaches} loading={slaBreachesLoading} onActionToggle={loadSummary} groupByProperty currentUserEmail={user?.email} />
            )}
            {inboxSubTab === "critical" && (
              <EmailTable emails={criticalEsc} loading={criticalEscLoading} onActionToggle={loadSummary} groupByProperty currentUserEmail={user?.email} />
            )}
            {inboxSubTab === "review" && (
              <EmailTable emails={needsReview} loading={needsReviewLoading} onActionToggle={loadSummary} groupByProperty currentUserEmail={user?.email} />
            )}
          </div>
        )}

        {/* ── CALENDAR ── */}
        {tab === "calendar" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <Calendar user={user} />
          </div>
        )}

        {/* ── PEOPLE ── */}
        {tab === "people" && <People />}

        {/* ── SCORES ── */}
        {tab === "scores" && <Scores />}

        {/* ── ANALYTICS ── */}
        {tab === "analytics" && <AnalyticsView analytics={analytics} loading={analyticsLoading} />}
      </main>
    </div>
  );
}
