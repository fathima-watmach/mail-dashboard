import React, { useState, useEffect } from "react";
import { getDepartments, submitClassificationFeedback } from "../api";

const SEVERITIES = ["critical", "high", "medium", "low"];
const URGENCIES = [["action_needed", "Action Needed"], ["fyi", "FYI"]];

// Correction form for a wrong AI classification — every field is editable,
// not just severity. Submitting fixes this email immediately AND stores the
// correction (embedded) so similar future emails can be classified with it
// in mind — retrieval, not literal reinforcement learning (see
// classifier.js's getFeedbackGrounding for why that distinction matters:
// Gemini's weights aren't ours to retrain over an API).
export default function ClassificationFeedback({ email, onCorrected, onCancel }) {
  const [departments, setDepartments] = useState([]);
  const [department, setDepartment] = useState(email.department || "");
  const [severity, setSeverity] = useState(email.severity || "medium");
  const [urgency, setUrgency] = useState(email.urgency || "fyi");
  const [isCritical, setIsCritical] = useState(!!email.is_critical);
  const [isEscalation, setIsEscalation] = useState(!!email.is_escalation);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState("idle"); // idle | saving | saved | error

  useEffect(() => {
    getDepartments().then((d) => setDepartments(d.departments || [])).catch(() => {});
  }, []);

  const handleSubmit = async () => {
    setStatus("saving");
    const res = await submitClassificationFeedback(email.id, {
      department, severity, urgency, isCritical, isEscalation,
      comment: comment.trim() || null,
    });
    if (res.ok) {
      setStatus("saved");
      setTimeout(() => onCorrected({ department, severity, urgency, is_critical: isCritical, is_escalation: isEscalation }), 700);
    } else {
      setStatus("error");
    }
  };

  if (status === "saved") {
    return (
      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 font-medium" onClick={(e) => e.stopPropagation()}>
        ✓ Correction saved — this email is updated, and similar future emails will be classified with this in mind.
      </div>
    );
  }

  return (
    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2.5" onClick={(e) => e.stopPropagation()}>
      <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Correct this classification</p>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">Department</label>
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="w-full text-sm border border-amber-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:border-amber-400"
          >
            {!departments.some((d) => d.name === department) && department && (
              <option value={department}>{department}</option>
            )}
            {departments.map((d) => (
              <option key={d.id} value={d.name}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">Urgency</label>
          <select
            value={urgency}
            onChange={(e) => setUrgency(e.target.value)}
            className="w-full text-sm border border-amber-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:border-amber-400"
          >
            {URGENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">Severity</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="w-full text-sm border border-amber-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:border-amber-400"
          >
            {SEVERITIES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
        <div className="flex items-end gap-4 pb-1.5">
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={isCritical} onChange={(e) => setIsCritical(e.target.checked)} className="accent-amber-600" />
            Critical
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <input type="checkbox" checked={isEscalation} onChange={(e) => setIsEscalation(e.target.checked)} className="accent-amber-600" />
            Escalation
          </label>
        </div>
      </div>

      <div>
        <label className="block text-[11px] text-gray-500 mb-1">Comment (optional) — helps explain the correction</label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="e.g. this is routine, not an escalation — vendor sends this update weekly"
          className="w-full text-sm border border-amber-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:border-amber-400 resize-none"
        />
      </div>

      {status === "error" && <p className="text-xs text-red-500">Failed to save — try again.</p>}

      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={status === "saving"}
          className="px-4 py-1.5 bg-amber-600 text-white text-sm rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
        >
          {status === "saving" ? "Saving…" : "Save correction"}
        </button>
      </div>
    </div>
  );
}
