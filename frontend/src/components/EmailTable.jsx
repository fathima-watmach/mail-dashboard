import React, { useState } from "react";
import { toggleAction, getReplysuggestions } from "../api";
import ReplyCompose from "./ReplyCompose";
import ThreadSummary from "./ThreadSummary";

const URGENCY_BADGE = {
  action_needed: "bg-amber-100 text-amber-700",
  fyi: "bg-gray-100 text-gray-500",
};

function fmt(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function applyFilters(emails, f) {
  return emails.filter(email => {
    if (f.text) {
      const q = f.text.toLowerCase();
      if (!(
        (email.subject || "").toLowerCase().includes(q) ||
        (email.from_name || "").toLowerCase().includes(q) ||
        (email.from_email || "").toLowerCase().includes(q) ||
        (email.summary || "").toLowerCase().includes(q) ||
        (email.to_recipients || "").toLowerCase().includes(q)
      )) return false;
    }
    if (f.department && email.department !== f.department) return false;
    if (f.urgency && email.urgency !== f.urgency) return false;
    if (f.directOnly && !email.is_direct_to_owner) return false;
    return true;
  });
}

function FilterBar({ filters, onChange, departments }) {
  const active = filters.text || filters.department || filters.urgency || filters.directOnly;
  return (
    <div className="flex flex-wrap gap-2 mb-4 pb-3 border-b border-gray-100 items-center">
      <div className="relative flex-1 min-w-[180px]">
        <input
          type="text"
          placeholder="Search subject, sender, summary…"
          value={filters.text}
          onChange={e => onChange({ ...filters, text: e.target.value })}
          className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:border-brand"
        />
        <svg className="absolute left-2.5 top-2 w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
      </div>
      {departments.length > 0 && (
        <select
          value={filters.department}
          onChange={e => onChange({ ...filters, department: e.target.value })}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-600 focus:outline-none focus:border-brand"
        >
          <option value="">All Departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      )}
      <select
        value={filters.urgency}
        onChange={e => onChange({ ...filters, urgency: e.target.value })}
        className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-600 focus:outline-none focus:border-brand"
      >
        <option value="">All Urgency</option>
        <option value="action_needed">Action Needed</option>
        <option value="fyi">FYI</option>
      </select>
      <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={filters.directOnly}
          onChange={e => onChange({ ...filters, directOnly: e.target.checked })}
          className="rounded border-gray-300 accent-brand"
        />
        Direct to me
      </label>
      {active && (
        <button
          onClick={() => onChange({ text: "", department: "", urgency: "", directOnly: false })}
          className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-100"
        >
          Clear ✕
        </button>
      )}
    </div>
  );
}

function Row({ email, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [actioned, setActioned] = useState(!!email.actioned_at);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");

  const handleAction = async (e) => {
    e.stopPropagation();
    setLoading(true);
    const res = await toggleAction(email.id);
    setActioned(res.actioned);
    setLoading(false);
    if (onToggle) onToggle(email.id, res.actioned);
  };

  const handleReplied = () => {
    setReplying(false);
    setReplyDraft("");
    setActioned(true);
    if (onToggle) onToggle(email.id, true);
  };

  const loadSuggestions = async (e) => {
    e.stopPropagation();
    setSuggestLoading(true);
    try {
      const data = await getReplysuggestions(email.id);
      setSuggestions(data.suggestions || []);
    } catch {
      setSuggestions([]);
    }
    setSuggestLoading(false);
  };

  const useSuggestion = (text) => {
    setReplyDraft(text);
    setReplying(true);
    setExpanded(false);
    setSuggestions(null);
  };

  return (
    <>
      <tr
        onClick={() => !replying && setExpanded(x => !x)}
        className={`border-b border-gray-50 cursor-pointer transition-colors
          ${email.is_critical ? "bg-red-50 hover:bg-red-100" : "hover:bg-gray-50"}
          ${actioned ? "opacity-50" : ""}`}
      >
        <td className="py-2.5 px-3 w-8">
          <button
            onClick={handleAction}
            disabled={loading}
            title={actioned ? "Mark as pending" : "Mark as actioned"}
            className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors flex-shrink-0
              ${actioned ? "bg-green-500 border-green-500 text-white" : "border-gray-300 hover:border-green-400"}`}
          >
            {actioned && (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        </td>

        <td className="py-2.5 px-3">
          <div className="flex items-center gap-2">
            {email.is_critical && (
              <span className="flex-shrink-0 text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">CRITICAL</span>
            )}
            <span className={`font-medium truncate max-w-xs ${email.is_critical ? "text-red-800" : "text-gray-800"}`}>
              {email.subject || "(no subject)"}
            </span>
          </div>
          {email.is_direct_to_owner && <span className="text-xs text-brand">Direct to you</span>}
        </td>

        <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap text-sm">{email.from_name || email.from_email}</td>
        <td className="py-2.5 px-3 text-gray-600 whitespace-nowrap text-sm">{email.department || "—"}</td>

        <td className="py-2.5 px-3">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${URGENCY_BADGE[email.urgency] || "bg-gray-100 text-gray-500"}`}>
            {email.urgency === "action_needed" ? "Action" : "FYI"}
          </span>
        </td>

        <td className="py-2.5 px-3 text-gray-400 whitespace-nowrap text-xs">
          <div className="flex items-center gap-2">
            <span>{fmt(email.received_at)}</span>
            {email.is_direct_to_owner && (
              <button
                onClick={e => { e.stopPropagation(); setReplying(x => !x); setExpanded(false); }}
                className="text-xs text-brand hover:text-brand-hover bg-brand-light px-2 py-0.5 rounded transition-colors font-medium"
              >
                {replying ? "Cancel" : "Reply"}
              </button>
            )}
          </div>
        </td>
      </tr>

      {expanded && !replying && (
        <tr className={`border-b border-gray-100 ${email.is_critical ? "bg-red-50" : "bg-gray-50"}`}>
          <td />
          <td colSpan={5} className="px-3 py-2 text-xs text-gray-500 space-y-1">
            <p><span className="font-medium text-gray-700 w-6 inline-block">From</span> {email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}</p>
            {email.to_recipients && <p><span className="font-medium text-gray-700 w-6 inline-block">To</span> {email.to_recipients}</p>}
            {email.cc_recipients && email.cc_recipients !== "Not Provided" && (
              <p><span className="font-medium text-gray-700 w-6 inline-block">Cc</span> {email.cc_recipients}</p>
            )}
            {email.summary && <p className="pt-1 text-gray-600 italic border-t border-gray-100 mt-1">{email.summary}</p>}

            {/* Auto-reply suggestions */}
            {email.is_direct_to_owner && (
              <div className="pt-1 border-t border-gray-100 mt-1">
                {suggestions === null ? (
                  <button
                    onClick={loadSuggestions}
                    disabled={suggestLoading}
                    className="text-xs text-brand hover:underline flex items-center gap-1 disabled:opacity-50"
                  >
                    {suggestLoading ? (
                      <>
                        <span className="inline-block w-2.5 h-2.5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                        Generating suggestions…
                      </>
                    ) : "✨ Suggest reply"}
                  </button>
                ) : suggestions.length === 0 ? (
                  <p className="text-xs text-gray-400">Could not generate suggestions.</p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-gray-400 font-medium">Suggested replies — click to use:</p>
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        onClick={e => { e.stopPropagation(); useSuggestion(s); }}
                        className="block w-full text-left text-xs bg-brand-light text-brand border border-brand-light rounded-lg px-3 py-2 hover:bg-blue-100 hover:border-brand transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="pt-1 border-t border-gray-100 mt-1">
              <ThreadSummary emailId={email.id} />
            </div>
          </td>
        </tr>
      )}

      {replying && (
        <tr className="border-b border-brand-light">
          <td />
          <td colSpan={5} className="px-3 py-3">
            <ReplyCompose
              email={email}
              onSent={handleReplied}
              onCancel={() => { setReplying(false); setReplyDraft(""); }}
              initialText={replyDraft}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export default function EmailTable({ emails, loading, onActionToggle }) {
  const [filters, setFilters] = useState({ text: "", department: "", urgency: "", directOnly: false });

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" /></div>;
  }

  const departments = [...new Set(emails.map(e => e.department).filter(Boolean))].sort();
  const filtered = applyFilters(emails, filters);

  return (
    <div>
      <FilterBar filters={filters} onChange={setFilters} departments={departments} />

      {filtered.length === 0 ? (
        <p className="text-center py-10 text-gray-400 text-sm">
          {emails.length === 0 ? "No emails found." : "No emails match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="py-2 px-3 w-8" />
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Subject</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-400 uppercase tracking-wide">From</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Department</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Urgency</th>
                <th className="text-left py-2 px-3 text-xs font-medium text-gray-400 uppercase tracking-wide">Received</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => <Row key={e.id} email={e} onToggle={onActionToggle} />)}
            </tbody>
          </table>
          <p className="text-xs text-gray-400 mt-3 px-1">
            Showing {filtered.length} of {emails.length} emails. Click a row to expand.
          </p>
        </div>
      )}
    </div>
  );
}
