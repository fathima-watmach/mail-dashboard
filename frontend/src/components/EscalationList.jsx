import React, { useState } from "react";
import { toggleAction } from "../api";
import ReplyCompose from "./ReplyCompose";
import ThreadSummary from "./ThreadSummary";
import ThreadActionLog from "./ThreadActionLog";
import ClassificationFeedback from "./ClassificationFeedback";
import { SlaBadge } from "./shared";

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function EscalationCard({ e, currentUserEmail }) {
  const [actioned, setActioned] = useState(!!e.actioned_at);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionOverride, setCorrectionOverride] = useState(null);
  const displayEmail = correctionOverride ? { ...e, ...correctionOverride } : e;

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
      ${displayEmail.is_critical ? "bg-red-50 border-red-200" : "bg-orange-50 border-orange-100"}
      ${actioned ? "opacity-40" : ""}`}
    >
      {/* Main card row */}
      <div className="flex items-start gap-3 p-3 cursor-pointer" onClick={() => !replying && setExpanded(x => !x)}>
        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${displayEmail.is_critical ? "bg-red-600" : "bg-orange-400"}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                {displayEmail.is_critical && (
                  <span className="text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">CRITICAL</span>
                )}
                {e.is_shared_inbox
                  ? <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{e.mailbox_email}</span>
                  : e.is_direct_to_owner && (
                    <span className="text-xs text-brand bg-brand-light px-1.5 py-0.5 rounded">Direct</span>
                  )}
                <p className="text-sm font-medium text-gray-900 truncate">{e.subject}</p>
                {correctionOverride && (
                  <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Corrected</span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {e.from_name || e.from_email}
                {displayEmail.department && <span className="ml-2 text-orange-600">· {displayEmail.department}</span>}
                {e.handled_by_name && <span className="ml-2">· {e.handled_by_name}</span>}
                {Number(e.thread_message_count) > 1 && <span className="ml-2">· {e.thread_message_count} messages</span>}
                <span className="ml-2">{timeAgo(e.received_at)}</span>
              </p>
              {e.summary && (
                <p className="text-xs text-gray-500 mt-1 leading-relaxed">{e.summary}</p>
              )}
              <div className="mt-1.5">
                <SlaBadge deadline={e.sla_deadline} met={e.sla_met} severity={displayEmail.severity} />
              </div>
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
      {expanded && !replying && !correcting && (
        <div className="px-3 pb-2 text-xs text-gray-500 space-y-0.5 border-t border-orange-100">
          <p className="pt-2"><span className="font-medium text-gray-700 w-6 inline-block">From</span> {e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email}</p>
          {(e.handled_by_name || e.handled_by_role) && (
            <p><span className="font-medium text-gray-700 inline-block">Handled by</span> {[e.handled_by_name, e.handled_by_role].filter(Boolean).join(" — ")}</p>
          )}
          {e.to_recipients && <p><span className="font-medium text-gray-700 w-6 inline-block">To</span> {e.to_recipients}</p>}
          {e.cc_recipients && e.cc_recipients !== "Not Provided" && <p><span className="font-medium text-gray-700 w-6 inline-block">Cc</span> {e.cc_recipients}</p>}
          {e.summary && <p className="pt-1 italic text-gray-600 border-t border-orange-100 mt-1">{e.summary}</p>}
          <div className="pt-1 border-t border-orange-100 mt-1">
            <button
              onClick={(evt) => { evt.stopPropagation(); setCorrecting(true); }}
              className="text-xs text-amber-700 hover:underline font-medium"
            >
              🏷️ Not classified right? Correct it
            </button>
          </div>
          <div className="pt-1 border-t border-orange-100 mt-1">
            <ThreadSummary emailId={e.id} />
          </div>
          {e.is_shared_inbox && (
            <div className="pt-1 border-t border-orange-100 mt-1">
              <ThreadActionLog emailId={e.id} />
            </div>
          )}
        </div>
      )}

      {/* Inline reply compose */}
      {replying && (
        <div className="px-3 pb-3">
          <ReplyCompose
            email={e}
            onSent={handleReplied}
            onCancel={() => setReplying(false)}
            currentUserEmail={currentUserEmail}
          />
        </div>
      )}

      {correcting && (
        <div className="px-3 pb-3">
          <ClassificationFeedback
            email={{ ...displayEmail, is_escalation: displayEmail.is_escalation ?? true }}
            onCorrected={(fields) => { setCorrectionOverride(fields); setCorrecting(false); }}
            onCancel={() => setCorrecting(false)}
          />
        </div>
      )}
    </div>
  );
}

export default function EscalationList({ escalations, currentUserEmail }) {
  return (
    <div>
      {!escalations.length ? (
        <div className="text-center py-8 text-gray-400 text-sm">No escalations here.</div>
      ) : (
        <div className="space-y-2">
          {escalations.map((e) => <EscalationCard key={e.id} e={e} currentUserEmail={currentUserEmail} />)}
        </div>
      )}
    </div>
  );
}
