import React, { useState } from "react";
import { toggleAction, getReplysuggestions } from "../api";
import ReplyCompose from "./ReplyCompose";
import ThreadSummary from "./ThreadSummary";
import ThreadActionLog from "./ThreadActionLog";
import ClassificationFeedback from "./ClassificationFeedback";
import { SeverityBadge, SlaBadge, SEVERITY_STYLE, SEVERITY_LABEL } from "./shared";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

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

// Exported so UnattendedThreads (OverviewPanels.jsx) can render Unassigned
// rows through the exact same clickable/expandable component as every other
// Inbox tab, instead of a separate read-only summary row.
export function Row({ email, onToggle, currentUserEmail }) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [actioned, setActioned] = useState(!!email.actioned_at);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [correctionOverride, setCorrectionOverride] = useState(null);

  // Reflects a saved correction immediately, without waiting on a refetch —
  // same pattern as `actioned` above (local state layered over the fetched row).
  const displayEmail = correctionOverride ? { ...email, ...correctionOverride } : email;

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

  // Reply is always available now — it's sent from the logged-in dashboard
  // user's own mailbox (never "as" the original mailbox, see dashboard.js's
  // /reply route), so it no longer needs is_shared_inbox/is_direct_to_owner
  // gating the way an in-place Graph/Zoho reply would have.
  const canReply = true;

  return (
    <div className={`rounded-lg border transition-opacity
      ${displayEmail.is_critical ? "bg-red-50 border-red-200" : "bg-white border-gray-100"}
      ${actioned ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-3 p-3 cursor-pointer" onClick={() => !replying && setExpanded(x => !x)}>
        <button
          onClick={handleAction}
          disabled={loading}
          title={actioned ? "Mark as pending" : "Mark as actioned"}
          className={`w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center transition-colors flex-shrink-0
            ${actioned ? "bg-green-500 border-green-500 text-white" : "border-gray-300 hover:border-green-400"}`}
        >
          {actioned && (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              {/* Severity / status / subject line */}
              <div className="flex items-center gap-2 flex-wrap">
                {displayEmail.severity
                  ? <SeverityBadge severity={displayEmail.severity} />
                  : displayEmail.is_critical && (
                    <span className="text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">CRITICAL</span>
                  )}
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${URGENCY_BADGE[displayEmail.urgency] || "bg-gray-100 text-gray-500"}`}>
                  {displayEmail.urgency === "action_needed" ? "Action Needed" : "FYI"}
                </span>
                <span className={`font-medium truncate max-w-md ${displayEmail.is_critical ? "text-red-800" : "text-gray-800"}`}>
                  {email.subject || "(no subject)"}
                </span>
                {correctionOverride && (
                  <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Corrected</span>
                )}
              </div>

              {/* Sender / source line */}
              <p className="text-xs text-gray-500 mt-0.5">
                {email.from_name || email.from_email}
                {email.is_shared_inbox
                  ? <span className="ml-2 text-gray-400">{email.mailbox_email}</span>
                  : email.is_direct_to_owner && <span className="ml-2 text-brand">Direct to you</span>}
              </p>

              {/* AI summary — first-class, always visible, not hidden behind expand */}
              {email.summary && (
                <p className="text-xs text-gray-600 mt-1.5 leading-relaxed line-clamp-2">{email.summary}</p>
              )}

              {/* Footer: department · assignee · thread size · SLA · received */}
              <div className="flex items-center gap-2 mt-2 text-[11px] text-gray-400 flex-wrap">
                <span>{displayEmail.department || "Unclassified"}</span>
                {email.handled_by_name && <span>&middot; {email.handled_by_name}</span>}
                {Number(email.thread_message_count) > 1 && (
                  <span className="text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">{email.thread_message_count} messages</span>
                )}
                <SlaBadge deadline={email.sla_deadline} met={email.sla_met} severity={displayEmail.severity} />
                <span className="ml-auto">{fmt(email.received_at)}</span>
              </div>
            </div>

            {canReply && (
              <button
                onClick={e => { e.stopPropagation(); setReplying(x => !x); setExpanded(false); }}
                className="text-xs text-brand hover:text-brand-hover bg-brand-light px-2 py-1 rounded transition-colors font-medium flex-shrink-0"
              >
                {replying ? "Cancel" : "Reply"}
              </button>
            )}
          </div>
        </div>
      </div>

      {expanded && !replying && !correcting && (
        <div className="px-3 pb-3 text-xs text-gray-500 space-y-1 border-t border-gray-100 pt-2 ml-8">
          <p><span className="font-medium text-gray-700 w-6 inline-block">From</span> {email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}</p>
          {(email.handled_by_name || email.handled_by_role) && (
            <p><span className="font-medium text-gray-700 inline-block">Handled by</span> {[email.handled_by_name, email.handled_by_role].filter(Boolean).join(" — ")}</p>
          )}
          {email.to_recipients && <p><span className="font-medium text-gray-700 w-6 inline-block">To</span> {email.to_recipients}</p>}
          {email.cc_recipients && email.cc_recipients !== "Not Provided" && (
            <p><span className="font-medium text-gray-700 w-6 inline-block">Cc</span> {email.cc_recipients}</p>
          )}

          <div className="pt-1 border-t border-gray-100 mt-1">
            <button
              onClick={(e) => { e.stopPropagation(); setCorrecting(true); }}
              className="text-xs text-amber-700 hover:underline font-medium"
            >
              🏷️ Not classified right? Correct it
            </button>
          </div>

          {canReply && (
            <div className="pt-1 border-t border-gray-100 mt-1 space-y-1.5">
              {/* Writing your own is always available here, not just via the
                  top-right Reply button — suggestions are an optional
                  shortcut, never the only path to a reply. */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={e => { e.stopPropagation(); setExpanded(false); setReplying(true); }}
                  className="text-xs text-brand hover:underline font-medium"
                >
                  ✍️ Write your own reply
                </button>
                {suggestions === null && (
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
                )}
              </div>
              {suggestions !== null && (
                suggestions.length === 0 ? (
                  <p className="text-xs text-gray-400">Could not generate suggestions.</p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-gray-400 font-medium">Suggested replies — click to use, or edit after:</p>
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        onClick={e => { e.stopPropagation(); useSuggestion(s); }}
                        className="block w-full text-left text-xs bg-brand-light text-brand border border-brand-light rounded-lg px-3 py-2 hover:bg-brand-light hover:border-brand transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          )}

          <div className="pt-1 border-t border-gray-100 mt-1">
            <ThreadSummary emailId={email.id} />
          </div>
          {email.is_shared_inbox && (
            <div className="pt-1 border-t border-gray-100 mt-1">
              <ThreadActionLog emailId={email.id} />
            </div>
          )}
        </div>
      )}

      {replying && (
        <div className="px-3 pb-3 ml-8">
          <ReplyCompose
            email={email}
            onSent={handleReplied}
            onCancel={() => { setReplying(false); setReplyDraft(""); }}
            initialText={replyDraft}
            currentUserEmail={currentUserEmail}
          />
        </div>
      )}

      {correcting && (
        <div className="px-3 pb-3 ml-8">
          <ClassificationFeedback
            email={displayEmail}
            onCorrected={(fields) => { setCorrectionOverride(fields); setCorrecting(false); }}
            onCancel={() => setCorrecting(false)}
          />
        </div>
      )}
    </div>
  );
}

// Picks the display label for a property tile per the dropdown's mode —
// falls back to whatever's actually populated, since real data is
// inconsistent (Asteco mostly has a numeric project_no, Colliers (Fab)
// mostly has only a UBS code + site_name, Relaam has both project_no AND a
// separate site_name). Grouping itself is always by property_id (exact DB
// match, unaffected by this) — this only changes what text shows on the tile.
export function propertyLabel(sample, mode) {
  if (mode === "site") {
    if (sample.property_site_name) return sample.property_site_name;
    if (sample.property_no) return `Project ${sample.property_no}`;
    if (sample.property_ubs) return `UBS ${sample.property_ubs}`;
  } else {
    if (sample.property_no) return `Project ${sample.property_no}`;
    if (sample.property_ubs) return `UBS ${sample.property_ubs}`;
    if (sample.property_site_name) return sample.property_site_name;
  }
  return "(unnamed property)";
}

export default function EmailTable({ emails, loading, onActionToggle, groupByProperty = false, currentUserEmail }) {
  const [filters, setFilters] = useState({ text: "", department: "", urgency: "", directOnly: false });
  const [selectedClient, setSelectedClient] = useState("");
  const [selectedProperty, setSelectedProperty] = useState("");
  const [selectedSeverity, setSelectedSeverity] = useState("");
  const [labelMode, setLabelMode] = useState("project"); // "project" | "site" — client's dropdown, per Asteco Allocation.xlsx

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" /></div>;
  }

  const departments = [...new Set(emails.map(e => e.department).filter(Boolean))].sort();
  const filtered = applyFilters(emails, filters);

  // Step 1: Client (property_customer when we know the exact property, else
  // customer_name_hint from a known sender — see propertyMatcher.js /
  // customerMatcher.js). Every email with either signal lands in a client
  // group, even a single mention — clients are few enough (the 9 real Sariah
  // customer segments) that this isn't clutter the way per-property tiling
  // would be. Genuinely signal-less mail gets its own explicit option.
  let clientTiles = [];
  if (groupByProperty) {
    const byClient = new Map();
    const clientless = [];
    for (const e of filtered) {
      const client = e.property_customer || e.customer_name_hint;
      if (!client) { clientless.push(e); continue; }
      if (!byClient.has(client)) byClient.set(client, []);
      byClient.get(client).push(e);
    }
    clientTiles = [...byClient.entries()]
      .map(([client, list]) => ({ key: `client-${client}`, label: client, emails: list, count: list.length }))
      .sort((a, b) => b.count - a.count);
    if (clientless.length > 0) {
      clientTiles.push({ key: "unclassified", label: "Unclassified", emails: clientless, count: clientless.length });
    }
  }
  const selectedClientTile = clientTiles.find((t) => t.key === selectedClient);
  const isUnclassifiedClient = selectedClientTile?.key === "unclassified";

  // Step 2: Project No./Building No. — property-level options within the
  // selected client, grouped by property_id so the label dropdown (project
  // no. vs. site name) never affects which emails land together, only what
  // text is shown for each option.
  let propertyTiles = [];
  let clientUngrouped = [];
  if (selectedClientTile && !isUnclassifiedClient) {
    const byProperty = new Map();
    for (const e of selectedClientTile.emails) {
      if (!e.property_id) continue;
      const key = `pid-${e.property_id}`;
      if (!byProperty.has(key)) byProperty.set(key, []);
      byProperty.get(key).push(e);
    }
    propertyTiles = [...byProperty.entries()]
      .map(([key, list]) => ({ key, label: propertyLabel(list[0], labelMode), emails: list, count: list.length }))
      .sort((a, b) => b.count - a.count);
    const propertyGroupedIds = new Set(propertyTiles.flatMap((g) => g.emails.map((e) => e.id)));
    clientUngrouped = selectedClientTile.emails.filter((e) => !propertyGroupedIds.has(e.id));
  } else if (selectedClientTile) {
    clientUngrouped = selectedClientTile.emails; // Unclassified: nothing to drill into at step 2
  }
  const selectedPropertyTile = propertyTiles.find((t) => t.key === selectedProperty);

  // Scope after client + property narrowing — what step 3's criticality
  // tiles are counted over, and (absent a severity pick) what's shown below.
  let propertyScope = [];
  if (selectedProperty === "none") propertyScope = clientUngrouped;
  else if (selectedPropertyTile) propertyScope = selectedPropertyTile.emails;
  else if (selectedClientTile) propertyScope = selectedClientTile.emails;

  // Step 3: Criticality — severity tiles over the client+property scope.
  let severityTiles = [];
  if (selectedClientTile) {
    const bySeverity = new Map();
    let noSeverity = 0;
    for (const e of propertyScope) {
      if (!e.severity) { noSeverity++; continue; }
      bySeverity.set(e.severity, (bySeverity.get(e.severity) || 0) + 1);
    }
    severityTiles = SEVERITY_ORDER
      .filter((s) => bySeverity.get(s) > 0)
      .map((s) => ({ key: s, label: SEVERITY_LABEL[s], count: bySeverity.get(s) }));
    if (noSeverity > 0) severityTiles.push({ key: "none", label: "Not Yet Classified", count: noSeverity });
  }

  const visibleRows = !groupByProperty
    ? filtered
    : selectedSeverity
      ? propertyScope.filter((e) => (selectedSeverity === "none" ? !e.severity : e.severity === selectedSeverity))
      : propertyScope;

  const handleClientChange = (value) => {
    setSelectedClient(value);
    setSelectedProperty("");
    setSelectedSeverity("");
  };
  const handlePropertyChange = (value) => {
    setSelectedProperty(value);
    setSelectedSeverity("");
  };

  return (
    <div>
      <FilterBar filters={filters} onChange={setFilters} departments={departments} />

      {groupByProperty && (
        <div className="mb-5 border border-gray-100 rounded-xl bg-gray-50/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Narrow Down</h3>
            <span className="hidden sm:inline text-[10px] text-gray-400 uppercase tracking-wide">Client &rarr; Property &rarr; Criticality</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-gray-500 mb-1">1 &middot; Client</label>
              <select
                value={selectedClient}
                onChange={(e) => handleClientChange(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand"
              >
                <option value="">Select client...</option>
                {clientTiles.map((t) => (
                  <option key={t.key} value={t.key}>{t.label} ({t.count})</option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] font-medium text-gray-500">2 &middot; Project No./Building No.</label>
                {selectedClientTile && !isUnclassifiedClient && propertyTiles.length > 0 && (
                  <select
                    value={labelMode}
                    onChange={(e) => setLabelMode(e.target.value)}
                    className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 text-gray-500 focus:outline-none focus:border-brand"
                  >
                    <option value="project">Project No.</option>
                    <option value="site">Site Name</option>
                  </select>
                )}
              </div>
              <select
                value={selectedProperty}
                disabled={!selectedClientTile || isUnclassifiedClient}
                onChange={(e) => handlePropertyChange(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white disabled:bg-gray-100 disabled:text-gray-400 focus:outline-none focus:border-brand"
              >
                <option value="">
                  {!selectedClientTile ? "Select a client first" : isUnclassifiedClient ? "No properties (unclassified)" : "All properties"}
                </option>
                {propertyTiles.map((t) => (
                  <option key={t.key} value={t.key}>{t.label} ({t.count})</option>
                ))}
                {clientUngrouped.length > 0 && selectedClientTile && !isUnclassifiedClient && (
                  <option value="none">Not linked to a specific property ({clientUngrouped.length})</option>
                )}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-[11px] font-medium text-gray-500 mb-1.5">3 &middot; Criticality</label>
            {!selectedClientTile ? (
              <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-4 text-center">
                Pick a client and a property to see criticality tiles.
              </p>
            ) : severityTiles.length === 0 ? (
              <p className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-4 text-center">
                No emails match this selection.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {severityTiles.map((t) => {
                  const isSelected = selectedSeverity === t.key;
                  const style = SEVERITY_STYLE[t.key];
                  return (
                    <button
                      key={t.key}
                      onClick={() => setSelectedSeverity(isSelected ? "" : t.key)}
                      className={`text-left rounded-lg px-3 py-2 border transition-all
                        ${isSelected ? "border-brand ring-1 ring-brand" : "border-transparent hover:border-gray-200"}
                        ${style ? style.row : "bg-gray-100"}`}
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{t.label}</p>
                      <p className="text-lg font-bold text-gray-800">{t.count}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="text-center py-10 text-gray-400 text-sm">
          {emails.length === 0 ? "No emails found." : "No emails match the current filters."}
        </p>
      ) : groupByProperty && !selectedClientTile ? (
        <p className="text-center py-10 text-gray-400 text-sm">Select a client above to see its emails.</p>
      ) : (
        <div>
          <div className="space-y-2">
            {visibleRows.map(e => <Row key={e.id} email={e} onToggle={onActionToggle} currentUserEmail={currentUserEmail} />)}
          </div>
          <p className="text-xs text-gray-400 mt-3 px-1">
            Showing {visibleRows.length} emails
            {selectedClientTile ? ` for "${selectedClientTile.label}"` : ""}
            {selectedPropertyTile
              ? ` · "${selectedPropertyTile.label}"`
              : selectedProperty === "none" ? " · not linked to a specific property" : ""}
            {selectedSeverity ? ` · ${selectedSeverity === "none" ? "not yet classified" : SEVERITY_LABEL[selectedSeverity]} severity` : ""}
            . Click a row to expand.
          </p>
        </div>
      )}
    </div>
  );
}
