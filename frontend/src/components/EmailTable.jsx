import React, { useState } from "react";
import { toggleAction } from "../api";
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

function Row({ email, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const [actioned, setActioned] = useState(!!email.actioned_at);
  const [loading, setLoading] = useState(false);

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
    setActioned(true);
    if (onToggle) onToggle(email.id, true);
  };

  return (
    <>
      <tr
        onClick={() => !replying && setExpanded((x) => !x)}
        className={`border-b border-gray-50 cursor-pointer transition-colors
          ${email.is_critical ? "bg-red-50 hover:bg-red-100" : "hover:bg-gray-50"}
          ${actioned ? "opacity-50" : ""}`}
      >
        {/* Action toggle */}
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

        {/* Subject */}
        <td className="py-2.5 px-3">
          <div className="flex items-center gap-2">
            {email.is_critical && (
              <span className="flex-shrink-0 text-xs font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">
                CRITICAL
              </span>
            )}
            <span className={`font-medium truncate max-w-xs ${email.is_critical ? "text-red-800" : "text-gray-800"}`}>
              {email.subject || "(no subject)"}
            </span>
          </div>
          {email.is_direct_to_owner && (
            <span className="text-xs text-brand">Direct to you</span>
          )}
        </td>

        {/* From */}
        <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap text-sm">
          {email.from_name || email.from_email}
        </td>

        {/* Department */}
        <td className="py-2.5 px-3 text-gray-600 whitespace-nowrap text-sm">{email.department || "—"}</td>

        {/* Urgency */}
        <td className="py-2.5 px-3">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${URGENCY_BADGE[email.urgency] || "bg-gray-100 text-gray-500"}`}>
            {email.urgency === "action_needed" ? "Action" : "FYI"}
          </span>
        </td>

        {/* Date + Reply button */}
        <td className="py-2.5 px-3 text-gray-400 whitespace-nowrap text-xs">
          <div className="flex items-center gap-2">
            <span>{fmt(email.received_at)}</span>
            {email.is_direct_to_owner && (
              <button
                onClick={(e) => { e.stopPropagation(); setReplying((x) => !x); setExpanded(false); }}
                className="text-xs text-brand hover:text-brand-hover bg-brand-light hover:bg-brand-light px-2 py-0.5 rounded transition-colors font-medium"
              >
                {replying ? "Cancel" : "Reply"}
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded detail row — recipients + summary */}
      {expanded && !replying && (
        <tr className={`border-b border-gray-100 ${email.is_critical ? "bg-red-50" : "bg-gray-50"}`}>
          <td />
          <td colSpan={5} className="px-3 py-2 text-xs text-gray-500 space-y-0.5">
            <p><span className="font-medium text-gray-700 w-6 inline-block">From</span> {email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}</p>
            {email.to_recipients  && <p><span className="font-medium text-gray-700 w-6 inline-block">To</span> {email.to_recipients}</p>}
            {email.cc_recipients  && email.cc_recipients !== "Not Provided" && <p><span className="font-medium text-gray-700 w-6 inline-block">Cc</span> {email.cc_recipients}</p>}
            {email.summary && <p className="pt-1 text-gray-600 italic border-t border-gray-100 mt-1">{email.summary}</p>}
            <div className="pt-1 border-t border-gray-100 mt-1">
              <ThreadSummary emailId={email.id} />
            </div>
          </td>
        </tr>
      )}

      {/* Reply compose row */}
      {replying && (
        <tr className="border-b border-brand-light">
          <td />
          <td colSpan={5} className="px-3 py-3">
            <ReplyCompose
              email={email}
              onSent={handleReplied}
              onCancel={() => setReplying(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export default function EmailTable({ emails, loading, onActionToggle }) {
  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" />
      </div>
    );
  }

  if (!emails.length) {
    return <p className="text-center py-10 text-gray-400 text-sm">No emails found.</p>;
  }

  return (
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
          {emails.map((e) => (
            <Row key={e.id} email={e} onToggle={onActionToggle} />
          ))}
        </tbody>
      </table>
      <p className="text-xs text-gray-400 mt-3 px-3">Click a row to expand the AI summary. Direct emails have a Reply button.</p>
    </div>
  );
}
