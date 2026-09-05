// Empty string keeps same-origin behavior for local dev (Vite's proxy in
// vite.config.js forwards /api and /auth to localhost:3001) and for the old
// combined-serving setup. Once the backend and frontend deploy to separate
// origins (Render + Vercel), VITE_API_BASE_URL points this at the Render
// backend's own URL instead — set it in Vercel's project env vars, not
// committed here. Exported so every other file that calls fetch() directly
// (LoginPage.jsx, ReplyCompose.jsx, Calendar.jsx, Scores.jsx) uses the same
// value instead of each hardcoding its own relative path.
export const BASE = import.meta.env.VITE_API_BASE_URL || "";

async function apiFetch(path) {
  const res = await fetch(BASE + path, { credentials: "include" });
  if (res.status === 401) throw new Error("unauthenticated");
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// Builds a "?from=...&to=..." query string from an optional {from, to} range,
// merged with any params already present on the base query string.
function withRange(query, range) {
  const params = new URLSearchParams(query);
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const getMe = () => apiFetch("/auth/me");
export const getSummary = (range) => apiFetch(`/api/dashboard/summary${withRange("", range)}`);
export const getBuckets = (range) => apiFetch(`/api/dashboard/buckets${withRange("", range)}`);
export const getEscalations = (directOnly = false, range) =>
  apiFetch(`/api/dashboard/escalations${withRange(directOnly ? "direct=true" : "", range)}`);
export const getActionNeeded = (range) => apiFetch(`/api/dashboard/action-needed${withRange("", range)}`);
export const getEmails = (department, range) =>
  apiFetch(`/api/dashboard/emails${withRange(department ? `department=${encodeURIComponent(department)}` : "", range)}`);
export const getTrends = (range) => apiFetch(`/api/dashboard/trends${withRange("", range)}`);
export const getAnalytics = (range) => apiFetch(`/api/dashboard/analytics${withRange("", range)}`);
export const getUnattended = (range) => apiFetch(`/api/dashboard/unattended${withRange("", range)}`);
export const getAttentionSummary = (range) => apiFetch(`/api/dashboard/attention-summary${withRange("", range)}`);
export const getThreadStatusSummary = (range) => apiFetch(`/api/dashboard/thread-status-summary${withRange("", range)}`);
export const getThreadStatusTrend = (range) => apiFetch(`/api/dashboard/thread-status-trend${withRange("", range)}`);
export const getSlaBreaches = (range) => apiFetch(`/api/dashboard/sla-breaches${withRange("", range)}`);
export const getCriticalEscalations = (range) => apiFetch(`/api/dashboard/critical-escalations${withRange("", range)}`);
export const getNeedsReview = (range) => apiFetch(`/api/dashboard/needs-review${withRange("", range)}`);
export const getScores = (range) => apiFetch(`/api/dashboard/scores${withRange("", range)}`);

// People & domains
export const discoverPeople = () => apiFetch("/api/people/discover");
export const suggestContact = (email) => apiFetch(`/api/people/suggest?email=${encodeURIComponent(email)}`);
export const saveDomain = (data) =>
  fetch("/api/people/domains", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json());
export const deleteDomain = (id) =>
  fetch(`/api/people/domains/${id}`, { method: "DELETE", credentials: "include" }).then((r) => r.json());
export const saveContact = (data) =>
  fetch("/api/people/contacts", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json());
export const deleteContact = (id) =>
  fetch(`/api/people/contacts/${id}`, { method: "DELETE", credentials: "include" }).then((r) => r.json());

export const searchEmails = (q) => apiFetch(`/api/dashboard/search?q=${encodeURIComponent(q)}`);
export const getReplysuggestions = (id) => apiFetch(`/api/dashboard/emails/${id}/reply-suggestions`);

export const toggleAction = (id) =>
  fetch(`/api/dashboard/emails/${id}/action`, { method: "POST", credentials: "include" }).then((r) => r.json());
export const getDepartments = () => apiFetch("/api/dashboard/departments");
export const submitClassificationFeedback = (id, payload) =>
  fetch(`/api/dashboard/emails/${id}/feedback`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then((r) => r.json());
export const replyToEmail = (id, text) =>
  fetch(`/api/dashboard/emails/${id}/reply`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).then((r) => r.json());
export const logout = () =>
  fetch("/auth/logout", { method: "POST", credentials: "include" });
