import React, { useState } from "react";

async function fetchThreadSummary(emailId) {
  const res = await fetch(`/api/dashboard/emails/${emailId}/thread-summary`, { credentials: "include" });
  return res.json();
}

export default function ThreadSummary({ emailId }) {
  const [state, setState] = useState("idle"); // idle | loading | done | error | single
  const [entries, setEntries] = useState([]);
  const [errMsg, setErrMsg] = useState("");

  const load = async (e) => {
    e.stopPropagation();
    setState("loading");
    try {
      const res = await fetch(`/api/dashboard/emails/${emailId}/thread-summary`, { credentials: "include" });

      // Render's free tier serves an HTML wakeup page on cold start —
      // catch that before trying to parse as JSON
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        setErrMsg("Server is starting up — please try again in 30 seconds");
        setState("error");
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        setErrMsg(data.error || `Error ${res.status}`);
        setState("error");
        return;
      }
      if (data.entries && data.entries.length > 0) {
        setEntries(data.entries);
        setState("done");
      } else {
        setState("single");
      }
    } catch (err) {
      setErrMsg("Server is starting up — please try again in 30 seconds");
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
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Thread timeline</p>
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
