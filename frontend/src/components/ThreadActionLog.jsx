import React, { useState } from "react";
import { StatusBadge, ACTION_TYPE_LABEL } from "./shared";

async function fetchThreadContext(emailId, refresh = false) {
  const url = `/api/dashboard/emails/${emailId}/thread-context${refresh ? "?refresh=true" : ""}`;
  const res = await fetch(url, { credentials: "include" });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("server-starting");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "request-failed");
  return data;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// Thread-level status + narrative + a log of what each coordinator actually
// did and when — only meaningful for shared inboxes (see AGENTS.md's
// coordinator_roster note), unlike <ThreadSummary> which applies everywhere.
export default function ThreadActionLog({ emailId }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState("");

  const load = async (e, refresh = false) => {
    if (e) e.stopPropagation();
    setState("loading");
    try {
      const data = await fetchThreadContext(emailId, refresh);
      setResult(data);
      setState("done");
    } catch (err) {
      setErrMsg(err.message === "server-starting" ? "Server is starting up — please try again in 30 seconds" : (err.message || "Unknown error"));
      setState("error");
    }
  };

  if (state === "idle") {
    return (
      <button
        type="button"
        onClick={load}
        className="text-xs text-brand hover:text-brand underline underline-offset-2"
      >
        Thread status &amp; actions
      </button>
    );
  }

  if (state === "loading") {
    return (
      <span className="text-xs text-gray-400 flex items-center gap-1">
        <span className="inline-block w-3 h-3 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        Reading full thread…
      </span>
    );
  }

  if (state === "error") {
    return <span className="text-xs text-red-400">Could not build thread context{errMsg ? `: ${errMsg}` : "."}</span>;
  }

  const { status, narrative, messageCount, actions } = result;

  return (
    <div className="mt-2 space-y-2" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          <span className="text-[11px] text-gray-400">{messageCount} message{messageCount !== 1 ? "s" : ""}</span>
        </div>
        <button
          onClick={e => load(e, true)}
          className="text-[10px] text-gray-300 hover:text-gray-500 transition-colors"
          title="Regenerate"
        >
          ↺ Refresh
        </button>
      </div>

      {narrative && <p className="text-xs text-gray-700 leading-relaxed">{narrative}</p>}

      {actions.length === 0 ? (
        <p className="text-xs text-gray-400 italic">No coordinator replies identified in this thread yet.</p>
      ) : (
        <div>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Coordinator actions</p>
          <ol className="relative border-l border-gray-200 ml-2 space-y-2">
            {actions.map((a, i) => (
              <li key={i} className="ml-4">
                <div className="absolute -left-1.5 w-3 h-3 rounded-full bg-brand-light border border-white" />
                <p className="text-xs text-gray-400">
                  {fmtDateTime(a.actionAt)} · <span className="font-medium text-gray-600">{a.coordinatorName}</span>
                  {" · "}<span className="text-brand">{ACTION_TYPE_LABEL[a.actionType] || a.actionType}</span>
                </p>
                {a.description && <p className="text-xs text-gray-700 mt-0.5">{a.description}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
