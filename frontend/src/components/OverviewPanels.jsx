import React, { useState } from "react";
import { RateBar, pct, ResponseTime, InitialsAvatar, SEVERITY_STYLE, SEVERITY_LABEL } from "./shared";
import InfoTip from "./InfoTip";
import { Row, propertyLabel } from "./EmailTable";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

// Threads that genuinely need action but no known coordinator has ever
// replied to (see GET /unattended) — surfaced only when there's something to
// flag, not as a permanent empty panel, matching how this was asked for:
// "if no action is needed, leave it be." Same Client -> Property -> Criticality
// funnel as the Inbox's EmailTable.jsx (dropdowns for the first two steps,
// severity tiles for the third) so Unassigned isn't a visually different
// pattern from the rest of the Inbox.
export function UnattendedThreads({ threads, onActionToggle, currentUserEmail }) {
  const [selectedClient, setSelectedClient] = useState("");
  const [selectedProperty, setSelectedProperty] = useState("");
  const [selectedSeverity, setSelectedSeverity] = useState("");
  const [labelMode, setLabelMode] = useState("project");

  if (!threads || threads.length === 0) return null;

  // Step 1: Client
  const byClient = new Map();
  const clientless = [];
  for (const t of threads) {
    const client = t.property_customer || t.customer_name_hint;
    if (!client) { clientless.push(t); continue; }
    if (!byClient.has(client)) byClient.set(client, []);
    byClient.get(client).push(t);
  }
  const clientTiles = [...byClient.entries()]
    .map(([client, list]) => ({ key: `client-${client}`, label: client, threads: list, count: list.length }))
    .sort((a, b) => b.count - a.count);
  if (clientless.length > 0) {
    clientTiles.push({ key: "unclassified", label: "Unclassified", threads: clientless, count: clientless.length });
  }
  const selectedClientTile = clientTiles.find((t) => t.key === selectedClient);
  const isUnclassifiedClient = selectedClientTile?.key === "unclassified";

  // Step 2: Project No./Building No.
  let propertyTiles = [];
  let clientUngrouped = [];
  if (selectedClientTile && !isUnclassifiedClient) {
    const byProperty = new Map();
    for (const t of selectedClientTile.threads) {
      if (!t.property_id) continue;
      const key = `pid-${t.property_id}`;
      if (!byProperty.has(key)) byProperty.set(key, []);
      byProperty.get(key).push(t);
    }
    propertyTiles = [...byProperty.entries()]
      .map(([key, list]) => ({ key, label: propertyLabel(list[0], labelMode), threads: list, count: list.length }))
      .sort((a, b) => b.count - a.count);
    const propertyGroupedIds = new Set(propertyTiles.flatMap((g) => g.threads.map((t) => t.id)));
    clientUngrouped = selectedClientTile.threads.filter((t) => !propertyGroupedIds.has(t.id));
  } else if (selectedClientTile) {
    clientUngrouped = selectedClientTile.threads;
  }
  const selectedPropertyTile = propertyTiles.find((t) => t.key === selectedProperty);

  let propertyScope = [];
  if (selectedProperty === "none") propertyScope = clientUngrouped;
  else if (selectedPropertyTile) propertyScope = selectedPropertyTile.threads;
  else if (selectedClientTile) propertyScope = selectedClientTile.threads;

  // Step 3: Criticality
  let severityTiles = [];
  if (selectedClientTile) {
    const bySeverity = new Map();
    let noSeverity = 0;
    for (const t of propertyScope) {
      if (!t.severity) { noSeverity++; continue; }
      bySeverity.set(t.severity, (bySeverity.get(t.severity) || 0) + 1);
    }
    severityTiles = SEVERITY_ORDER
      .filter((s) => bySeverity.get(s) > 0)
      .map((s) => ({ key: s, label: SEVERITY_LABEL[s], count: bySeverity.get(s) }));
    if (noSeverity > 0) severityTiles.push({ key: "none", label: "Not Yet Classified", count: noSeverity });
  }

  const visibleThreads = selectedSeverity
    ? propertyScope.filter((t) => (selectedSeverity === "none" ? !t.severity : t.severity === selectedSeverity))
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
              No threads match this selection.
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

      {!selectedClientTile ? (
        <p className="text-center py-10 text-gray-400 text-sm">Select a client above to see its threads.</p>
      ) : (
        <div>
          <div className="space-y-2">
            {visibleThreads.map((t) => <Row key={t.id} email={t} onToggle={onActionToggle} currentUserEmail={currentUserEmail} />)}
          </div>
          <p className="text-xs text-gray-400 mt-3 px-1">
            Showing {visibleThreads.length} threads for "{selectedClientTile.label}"
            {selectedPropertyTile
              ? ` · "${selectedPropertyTile.label}"`
              : selectedProperty === "none" ? " · not linked to a specific property" : ""}
            {selectedSeverity ? ` · ${selectedSeverity === "none" ? "not yet classified" : SEVERITY_LABEL[selectedSeverity]} severity` : ""}.
          </p>
        </div>
      )}
    </div>
  );
}

// Shared table shell for "Per-Person Load" and "Department Load" — both read
// from GET /scores (already fetched elsewhere), just with a different row set
// and label. Default "Load %" = action_needed / total_emails, same ratio
// Scores.jsx's own RateBar already uses for its "Action Needed Rate" column —
// still correct for Department Load. Per-Person Load overrides this via
// loadValue/loadTotal (2026-09-05: changed from "escalation share of this
// person's own replies" to "this person's share of everyone's reply volume" —
// the latter is what "load" actually means for a person's workload).
// Sorted here by total_emails (actual volume), not trusted from the backend's
// own order — /scores sorts departments by longest-pending-time for its own
// table, which pushes "Unclassified" (no pending time set at all) to the very
// end regardless of size, silently clipping it out of this panel's top-N
// despite it often being the single largest bucket.
export function LoadPanel({ rows, nameKey, nameLabel, loadTooltip, loadValue, loadTotal }) {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">No data yet.</p>;
  }
  const sorted = [...rows].sort((a, b) => Number(b.total_emails) - Number(a.total_emails));
  const getValue = loadValue || ((r) => r.action_needed);
  const getTotal = loadTotal || ((r) => r.total_emails);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-gray-400 border-b border-gray-100">
          <th className="text-left font-medium py-1.5 text-xs uppercase tracking-wide">{nameLabel}</th>
          <th className="py-1.5 text-xs uppercase tracking-wide min-w-28">
            <span className="inline-flex items-center gap-1">
              Load{loadTooltip && <InfoTip text={loadTooltip} />}
            </span>
          </th>
          <th className="text-right font-medium py-1.5 text-xs uppercase tracking-wide">Emails</th>
        </tr>
      </thead>
      <tbody>
        {sorted.slice(0, 8).map((r) => {
          const v = getValue(r, sorted), t = getTotal(r, sorted);
          return (
            <tr key={r[nameKey] || r.from_email} className="border-b border-gray-50">
              <td className="py-2 text-gray-700 truncate max-w-[10rem]">{r[nameKey]}</td>
              <td className="py-2">
                <RateBar value={v} total={t}
                  color={pct(v, t) > 60 ? "bg-red-400" : pct(v, t) > 30 ? "bg-amber-500" : "bg-brand"} />
              </td>
              <td className="py-2 text-right text-gray-600 font-medium">{r.total_emails}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Top responders by avg response time, ascending (fastest first) — reuses the
// same ResponseTime color/threshold convention as Scores.jsx.
export function ResponderPerformance({ senders }) {
  const ranked = senders
    .filter((s) => s.avg_response_hours != null)
    .sort((a, b) => Number(a.avg_response_hours) - Number(b.avg_response_hours))
    .slice(0, 3);

  if (ranked.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">Not enough reply data yet.</p>;
  }
  return (
    <div className="space-y-2.5">
      {ranked.map((s, i) => (
        <div key={s.from_email} className="flex items-center gap-3">
          <span className="w-5 text-xs text-gray-400 flex-shrink-0">{i + 1}</span>
          <InitialsAvatar name={s.sender} email={s.from_email} />
          <span className="flex-1 min-w-0 text-sm text-gray-700 truncate">{s.sender}</span>
          <ResponseTime hours={s.avg_response_hours} />
        </div>
      ))}
    </div>
  );
}
