const BASE = "";

async function apiFetch(path) {
  const res = await fetch(BASE + path, { credentials: "include" });
  if (res.status === 401) throw new Error("unauthenticated");
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export const getMe = () => apiFetch("/auth/me");
export const getSummary = () => apiFetch("/api/dashboard/summary");
export const getBuckets = () => apiFetch("/api/dashboard/buckets");
export const getEscalations = (directOnly = false) =>
  apiFetch(`/api/dashboard/escalations${directOnly ? "?direct=true" : ""}`);
export const getActionNeeded = () => apiFetch("/api/dashboard/action-needed");
export const getEmails = (department) =>
  apiFetch(`/api/dashboard/emails${department ? `?department=${encodeURIComponent(department)}` : ""}`);
export const getScores = () => apiFetch("/api/dashboard/scores");

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

export const toggleAction = (id) =>
  fetch(`/api/dashboard/emails/${id}/action`, { method: "POST", credentials: "include" }).then((r) => r.json());
export const replyToEmail = (id, text) =>
  fetch(`/api/dashboard/emails/${id}/reply`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }).then((r) => r.json());
export const logout = () =>
  fetch("/auth/logout", { method: "POST", credentials: "include" });
