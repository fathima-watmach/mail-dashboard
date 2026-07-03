import React, { useState } from "react";

async function fetchThreadSummary(emailId, refresh = false) {
  const url = `/api/dashboard/emails/${emailId}/thread-summary${refresh ? "?refresh=true" : ""}`;
  const res = await fetch(url, { credentials: "include" });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("server-starting");
  return res.json();
}

export default function ThreadSummary({ emailId }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error | single
  const [entries, setEntries] = useState([]);
  const [errMsg, setErrMsg] = useState("");

  const load = async (e, refresh = false) => {
    if (e) e.stopPropagation();
    setState("loading");
    try {
      const data = await fetchThreadSummary(emailId, refresh);
      if (data.entries && data.entries.length > 0) {
        setEntries(data.entries);
        setState("done");
      } else {
        setState("single");
      }
    } catch (err) {
      if (err.message === "server-starting") {
        setErrMsg("Server is starting up — please try again in 30 seconds");
      } else {
        setErrMsg(err.message || "Unknown error");
      }
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
        Summarize thread
      </button>
    );
  }

  if (state === "loading") {
    return (
      <span className="text-xs text-gray-400 flex items-center gap-1">
        <span className="inline-block w-3 h-3 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        Analysing thread…
      </span>
    );
  }

  if (state === "error") {
    return <span className="text-xs text-red-400">Could not summarise thread{errMsg ? `: ${errMsg}` : "."}</span>;
  }

  if (state === "single") {
    return <span className="text-xs text-gray-400 italic">Single message — no thread to summarise.</span>;
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Thread timeline</p>
        <button
          onClick={e => load(e, true)}
          className="text-[10px] text-gray-300 hover:text-gray-500 transition-colors"
          title="Regenerate summary"
        >
          ↺ Refresh
        </button>
      </div>
      <ol className="relative border-l border-gray-200 ml-2 space-y-2">
        {entries.map((entry, i) => (
          <li key={i} className="ml-4">
            <div className="absolute -left-1.5 w-3 h-3 rounded-full bg-brand-light border border-white" />
            <p className="text-xs text-gray-400">{entry.date} · <span className="font-medium text-gray-600">{entry.from}</span></p>
            <p className="text-xs text-gray-700 mt-0.5">{entry.summary}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
