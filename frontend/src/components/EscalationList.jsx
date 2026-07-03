import React, { useState } from "react";
import { toggleAction } from "../api";
import ReplyCompose from "./ReplyCompose";
import ThreadSummary from "./ThreadSummary";

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function EscalationCard({ e }) {
  const [actioned, setActioned] = useState(!!e.actioned_at);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleAction = async (evt) => {
    evt.stopPropagation();
    const res = await toggleAction(e.id);
    setActioned(res.actioned);
  };

  const handleReplied = () => {
    setReplying(false);
    setActioned(true);
  };

  return (
    <div className={`rounded-lg border transition-opacity
      ${e.is_critical ? "bg-red-50 border-red-200" : "bg-orange-50 border-orange-100"}
      ${actioned ? "opacity-40" : ""}`}
    >
      {/* Main card row */}
      <div className="flex items-start gap-3 p-3 cursor-pointer" onClick={() => !replying && setExpanded(x => !x)}>
        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${e.is_critical ? "bg-red-600" : "bg-orange-400"}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {e.is_critical && (
                  <span className="text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">CRITICAL</span>
                )}
                {e.is_direct_to_owner && (
                  <span className="text-xs text-brand bg-brand-light px-1.5 py-0.5 rounded">Direct</span>
                )}
                <p className="text-sm font-medium text-gray-900 truncate">{e.subject}</p>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {e.from_name || e.from_email}
                {e.department && <span className="ml-2 text-orange-600">· {e.department}</span>}
                <span className="ml-2">{timeAgo(e.received_at)}</span>
              </p>
              {e.summary && (
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">{e.summary}</p>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setReplying((x) => !x)}
                className={`text-xs px-2 py-0.5 rounded font-medium transition-colors
                  ${replying ? "bg-brand-light text-navy" : "bg-brand-light text-brand hover:bg-brand-light"}`}
              >
                {replying ? "Cancel" : "Reply"}
              </button>
              <button
                type="button"
                onClick={handleAction}
                title={actioned ? "Mark as pending" : "Mark as actioned"}
                className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors
                  ${actioned ? "bg-green-500 border-green-500 text-white" : "border-gray-300 hover:border-green-400"}`}
              >
                {actioned && (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Expanded: From / To / CC + summary */}
      {expanded && !replying && (
        <div className="px-3 pb-2 text-xs text-gray-500 space-y-0.5 border-t border-orange-100">
          <p className="pt-2"><span className="font-medium text-gray-700 w-6 inline-block">From</span> {e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email}</p>
          {e.to_recipients && <p><span className="font-medium text-gray-700 w-6 inline-block">To</span> {e.to_recipients}</p>}
          {e.cc_recipients && e.cc_recipients !== "Not Provided" && <p><span className="font-medium text-gray-700 w-6 inline-block">Cc</span> {e.cc_recipients}</p>}
          {e.summary && <p className="pt-1 italic text-gray-600 border-t border-orange-100 mt-1">{e.summary}</p>}
          <div className="pt-1 border-t border-orange-100 mt-1">
            <ThreadSummary emailId={e.id} />
          </div>
        </div>
      )}

      {/* Inline reply compose */}
      {replying && (
        <div className="px-3 pb-3">
          <ReplyCompose
            email={e}
            onSent={handleReplied}
            onCancel={() => setReplying(false)}
          />
        </div>
      )}
    </div>
  );
}

export default function EscalationList({ escalations, showTabs = false }) {
  const [tab, setTab] = useState("all");

  const displayed = tab === "direct"
    ? escalations.filter((e) => e.is_direct_to_owner)
    : escalations;

  return (
    <div>
      {showTabs && (
        <div className="flex gap-1 mb-4 border-b border-gray-100 pb-0">
          {["all", "direct"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t capitalize transition-colors border-b-2 -mb-px
                ${tab === t ? "border-orange-500 text-orange-600" : "border-transparent text-gray-400 hover:text-gray-600"}`}
            >
              {t === "all" ? "All escalations" : "Direct to me"}
              <span className="ml-1.5 bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full text-xs">
                {t === "direct" ? escalations.filter((e) => e.is_direct_to_owner).length : escalations.length}
              </span>
            </button>
          ))}
        </div>
      )}

      {!displayed.length ? (
        <div className="text-center py-8 text-gray-400 text-sm">No escalations here.</div>
      ) : (
        <div className="space-y-2">
          {displayed.map((e) => <EscalationCard key={e.id} e={e} />)}
        </div>
      )}
    </div>
  );
}
