import React, { useState, useEffect, useRef } from "react";

async function fetchContacts() {
  const res = await fetch("/api/people/contacts", { credentials: "include" });
  const d = await res.json();
  return d.contacts || [];
}

async function sendReply(emailId, { text, replyAll, cc }) {
  const res = await fetch(`/api/dashboard/emails/${emailId}/reply`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, replyAll, cc }),
  });
  return res.json();
}

// ── CC Tag Input ──────────────────────────────────────────────────────────────
function CcInput({ value, onChange }) {
  const [input, setInput] = useState("");
  const [contacts, setContacts] = useState([]);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    fetchContacts().then(setContacts).catch(() => {});
  }, []);

  const filtered = input.length > 0
    ? contacts
        .filter((c) =>
          c.email.includes(input.toLowerCase()) ||
          (c.display_name || "").toLowerCase().includes(input.toLowerCase())
        )
        .slice(0, 6)
    : [];

  const add = (email, name) => {
    if (!value.find((c) => c.email === email)) {
      onChange([...value, { email, name: name || email }]);
    }
    setInput("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const addFromInput = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed.includes("@")) add(trimmed, trimmed);
  };

  const remove = (email) => onChange(value.filter((c) => c.email !== email));

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-1 items-center border border-gray-200 rounded px-2 py-1 min-h-[30px] bg-white focus-within:ring-1 focus-within:ring-brand">
        {value.map((c) => (
          <span key={c.email} className="flex items-center gap-1 bg-brand-light text-brand text-xs px-2 py-0.5 rounded-full">
            {c.name !== c.email ? c.name : c.email}
            <button type="button" onClick={() => remove(c.email)} className="hover:text-navy leading-none">×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); filtered.length ? add(filtered[0].email, filtered[0].display_name) : addFromInput(); }
            if (e.key === "," || e.key === " ") { e.preventDefault(); addFromInput(); }
            if (e.key === "Backspace" && !input && value.length) remove(value[value.length - 1].email);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={value.length ? "" : "Add people…"}
          className="flex-1 min-w-20 text-xs outline-none bg-transparent"
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {filtered.map((c) => (
            <button
              key={c.email}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); add(c.email, c.display_name); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-brand-light flex items-center gap-2"
            >
              <div>
                <p className="font-medium text-gray-800">{c.display_name || c.email}</p>
                <p className="text-gray-400">{c.email}{c.company ? ` · ${c.company}` : ""}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ReplyCompose ─────────────────────────────────────────────────────────
export default function ReplyCompose({ email, onSent, onCancel }) {
  const [mode, setMode] = useState("reply");      // reply | replyAll
  const [text, setText] = useState("");
  const [cc, setCc] = useState([]);
  const [status, setStatus] = useState("idle");   // idle | sending | sent | error

  // Build the visible "To:" list for each mode
  const toRecipients = React.useMemo(() => {
    const sender = { email: email.from_email, name: email.from_name || email.from_email };
    if (mode === "reply") return [sender];

    const parse = (str) =>
      (str || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((e) => ({ email: e, name: e }));

    const others = [...parse(email.to_recipients), ...parse(email.cc_recipients)];
    const all = [sender, ...others];
    // deduplicate by email
    const seen = new Set();
    return all.filter((r) => {
      if (seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });
  }, [mode, email]);

  const handleSend = async () => {
    if (!text.trim()) return;
    setStatus("sending");
    const res = await sendReply(email.id, {
      text,
      replyAll: mode === "replyAll",
      cc: cc.map((c) => c.email),
    });
    if (res.ok) {
      setStatus("sent");
      setTimeout(onSent, 1200);
    } else {
      setStatus("error");
    }
  };

  return (
    <div
      className="p-3 bg-brand-light border border-brand-light rounded-lg space-y-2"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Original email context */}
      <div className="bg-white border border-brand-light rounded-lg px-3 py-2 text-xs text-gray-500 space-y-0.5">
        <p><span className="font-medium text-gray-700 w-6 inline-block">From</span> {email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}</p>
        {email.to_recipients  && <p><span className="font-medium text-gray-700 w-6 inline-block">To</span> {email.to_recipients}</p>}
        {email.cc_recipients  && email.cc_recipients !== "Not Provided" && <p><span className="font-medium text-gray-700 w-6 inline-block">Cc</span> {email.cc_recipients}</p>}
        {email.subject        && <p className="pt-0.5 border-t border-gray-100 mt-0.5"><span className="font-medium text-gray-700">Sub </span>{email.subject}</p>}
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-white border border-brand-light rounded-lg p-0.5 self-start w-fit">
        {[["reply", "Reply"], ["replyAll", "Reply All"]].map(([v, l]) => (
          <button
            key={v}
            type="button"
            onClick={() => setMode(v)}
            className={`px-2.5 py-1 text-xs rounded-md transition-colors font-medium
              ${mode === v ? "bg-brand text-white" : "text-gray-500 hover:text-gray-700"}`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* To: row — shows where reply will go */}
      <div className="flex items-start gap-2">
        <span className="text-xs text-gray-400 pt-1 flex-shrink-0 w-5">To</span>
        <div className="flex flex-wrap gap-1">
          {toRecipients.map((r) => (
            <span key={r.email} className="flex items-center bg-white border border-brand-light text-brand text-xs px-2 py-0.5 rounded-full">
              {r.name !== r.email ? r.name : r.email}
            </span>
          ))}
        </div>
      </div>

      {/* CC field */}
      <div className="flex items-start gap-2">
        <span className="text-xs text-gray-400 pt-1 flex-shrink-0 w-5">Cc</span>
        <div className="flex-1">
          <CcInput value={cc} onChange={setCc} />
        </div>
      </div>

      {/* Body */}
      {status === "sent" ? (
        <p className="text-sm text-green-600 font-medium py-2">Reply sent successfully.</p>
      ) : (
        <>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder="Type your reply…"
            className="w-full border border-brand-light rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand bg-white resize-none"
          />
          {status === "error" && (
            <p className="text-xs text-red-500">
              Failed to send. Ensure Mail.Send permission is granted and try again.
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={status === "sending" || !text.trim()}
              className="px-4 py-1.5 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-40 transition-colors flex items-center gap-1.5"
            >
              {status === "sending" ? (
                <>
                  <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                  Sending…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                  Send
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
