import React, { useEffect, useState, useCallback } from "react";
import { getSummary, getBuckets, getEscalations, getActionNeeded, getEmails, logout } from "../api";
import StatCard from "../components/StatCard";
import DepartmentGrid from "../components/DepartmentGrid";
import EscalationList from "../components/EscalationList";
import EmailTable from "../components/EmailTable";
import People from "./People";
import Calendar from "./Calendar";
import Scores from "./Scores";

const TABS = ["overview", "action needed", "escalations", "all emails", "calendar", "people", "scores"];

export default function Dashboard({ user, onLogout }) {
  const [summary, setSummary] = useState({ total: 0, critical: 0, actionNeeded: 0, escalations: 0 });
  const [buckets, setBuckets] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [actionEmails, setActionEmails] = useState([]);
  const [allEmails, setAllEmails] = useState([]);
  const [selectedDept, setSelectedDept] = useState(null);
  const [allEmailsLoading, setAllEmailsLoading] = useState(false);
  const [tab, setTab] = useState("overview");

  const loadSummary = useCallback(() =>
    getSummary().then(setSummary).catch(console.error), []);

  useEffect(() => {
    loadSummary();
    getBuckets().then((d) => setBuckets(d.buckets)).catch(console.error);
    getEscalations().then((d) => setEscalations(d.escalations)).catch(console.error);
    getActionNeeded().then((d) => setActionEmails(d.emails)).catch(console.error);
  }, []);

  useEffect(() => {
    if (tab !== "all emails") return;
    setAllEmailsLoading(true);
    getEmails(selectedDept)
      .then((d) => setAllEmails(d.emails))
      .catch(console.error)
      .finally(() => setAllEmailsLoading(false));
  }, [tab, selectedDept]);

  const handleLogout = async () => { await logout(); onLogout(); };

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="bg-brand px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <span className="font-semibold text-white tracking-wide">WATMACH</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-white/70 hidden sm:block">{user.email}</span>
          <button onClick={handleLogout} className="text-sm text-white/70 hover:text-white transition-colors">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {/* Tabs */}
        <div className="flex gap-0.5 mb-6 border-b border-gray-100 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium capitalize whitespace-nowrap transition-colors border-b-2 -mb-px
                ${tab === t ? "border-brand text-brand" : "border-transparent text-gray-400 hover:text-gray-700"}`}
            >
              {t}
              {t === "escalations" && summary.escalations > 0 && (
                <span className="ml-2 bg-orange-100 text-orange-600 text-xs px-1.5 py-0.5 rounded-full">
                  {summary.escalations}
                </span>
              )}
              {t === "action needed" && summary.actionNeeded > 0 && (
                <span className="ml-2 bg-amber-100 text-amber-700 text-xs px-1.5 py-0.5 rounded-full">
                  {summary.actionNeeded}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <div className="space-y-6">
            {/* Data range badge */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-full px-3 py-1">
                Showing emails: <span className="font-medium text-gray-600">{(() => {
                  const now = new Date();
                  const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
                  return `Apr ${fyYear}`;
                })()} – Present</span>
              </span>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Total emails"   value={summary.total}        color="blue"  onClick={() => setTab("all emails")} />
              <StatCard label="Highly Critical" value={summary.critical}    color="red"   sub="Action today"    onClick={() => setTab("action needed")} />
              <StatCard label="Action Needed"  value={summary.actionNeeded} color="amber" sub="Direct to you"   onClick={() => setTab("action needed")} />
              <StatCard label="Escalations"    value={summary.escalations}  color="green" sub="Needs attention" onClick={() => setTab("escalations")} />
            </div>

            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-4">By Department</h2>
              <DepartmentGrid buckets={buckets} selected={selectedDept}
                onSelect={(d) => { setSelectedDept(d); setTab("all emails"); }} />
            </div>

            {escalations.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-700">Recent Escalations</h2>
                  <button onClick={() => setTab("escalations")} className="text-xs text-brand hover:underline">
                    View all
                  </button>
                </div>
                <EscalationList escalations={escalations.slice(0, 3)} />
              </div>
            )}
          </div>
        )}

        {/* ── ACTION NEEDED ── */}
        {tab === "action needed" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-sm font-semibold text-gray-700">Action Needed</h2>
              <span className="text-xs text-gray-400">— emails directly addressed to you requiring a response</span>
            </div>
            <p className="text-xs text-gray-400 mb-4">Critical items are highlighted. Click a row to read the AI summary. Check ✓ once actioned.</p>
            <EmailTable emails={actionEmails} loading={false} onActionToggle={loadSummary} />
          </div>
        )}

        {/* ── ESCALATIONS ── */}
        {tab === "escalations" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Escalations</h2>
            <EscalationList escalations={escalations} showTabs />
          </div>
        )}

        {/* ── ALL EMAILS ── */}
        {tab === "all emails" && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-semibold text-gray-700">
                {selectedDept ? `Emails — ${selectedDept}` : "All Emails"}
              </h2>
              {selectedDept && (
                <button onClick={() => setSelectedDept(null)}
                  className="text-xs bg-brand-light text-brand px-3 py-1 rounded-full hover:bg-brand hover:text-white transition-colors">
                  {selectedDept} ✕
                </button>
              )}
            </div>
            <EmailTable emails={allEmails} loading={allEmailsLoading} onActionToggle={loadSummary} />
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
      </main>
    </div>
  );
}
