import React, { useEffect, useState, useCallback } from "react";
import { discoverPeople, saveDomain, deleteDomain, saveContact, deleteContact, suggestContact } from "../api";

const ORG_TYPES = [
  { value: "own_company",  label: "Our Company",       color: "bg-brand-light text-brand border-brand" },
  { value: "client",       label: "Client",            color: "bg-green-100 text-green-700 border-green-200" },
  { value: "vendor",       label: "Vendor",            color: "bg-purple-100 text-purple-700 border-purple-200" },
  { value: "distributor",  label: "Distributor",       color: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  { value: "partner",      label: "Partner",           color: "bg-teal-100 text-teal-700 border-teal-200" },
  { value: "prospect",     label: "Prospect",          color: "bg-amber-100 text-amber-700 border-amber-200" },
  { value: "consultant",   label: "Consultant",        color: "bg-orange-100 text-orange-700 border-orange-200" },
  { value: "bank",         label: "Bank / Finance",    color: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  { value: "regulatory",   label: "Regulatory Body",   color: "bg-red-100 text-red-700 border-red-200" },
  { value: "logistics",    label: "Logistics",         color: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  { value: "media",        label: "Media / PR",        color: "bg-pink-100 text-pink-700 border-pink-200" },
  { value: "other",        label: "Other",             color: "bg-gray-100 text-gray-600 border-gray-200" },
];

const INTERNAL_DEPTS = [
  "Sales", "Pre-sales", "Service", "Operations & Procurement",
  "Finance", "Projects", "HR", "IT", "Management", "Marketing",
];

function typeBadge(type) {
  const t = ORG_TYPES.find((o) => o.value === type);
  if (!t) return null;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${t.color}`}>
      {t.label}
    </span>
  );
}

// ─── Domain Map Form ──────────────────────────────────────────────────────────
function DomainMapForm({ domain, existing, onSave, onCancel }) {
  const [label, setLabel] = useState(existing?.label || "");
  const [type, setType] = useState(existing?.type || "client");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!label.trim()) return;
    setSaving(true);
    await saveDomain({ domain, label: label.trim(), type });
    setSaving(false);
    onSave();
  };

  return (
    <div className="flex flex-wrap gap-2 items-end mt-2 p-3 bg-white rounded-lg border border-dashed border-gray-300">
      <div className="flex-1 min-w-36">
        <label className="text-xs text-gray-500 mb-1 block">Company / Org name</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`e.g. "MRF Limited"`}
          className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </div>
      <div className="min-w-40">
        <label className="text-xs text-gray-500 mb-1 block">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand bg-white"
        >
          {ORG_TYPES.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving || !label.trim()}
          className="px-3 py-1.5 bg-brand text-white text-sm rounded hover:bg-brand-hover disabled:opacity-40 transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Contact Map Form ─────────────────────────────────────────────────────────
function ContactMapForm({ contact, domainType, onSave, onCancel }) {
  const [name, setName] = useState(contact.display_name || "");
  const [dept, setDept] = useState(contact.department || "");
  const [role, setRole] = useState(contact.role_label || "");
  const [saving, setSaving] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [suggesting, setSuggesting] = useState(false);

  const isInternal = domainType === "own_company";

  // Fetch suggestion on open (only for unmapped contacts)
  useEffect(() => {
    if (contact.contact_id) return;
    setSuggesting(true);
    suggestContact(contact.email)
      .then(({ suggestion: s }) => {
        if (s && (s.display_name || s.role_label)) setSuggestion(s);
      })
      .catch(() => {})
      .finally(() => setSuggesting(false));
  }, [contact.email]);

  const applySuggestion = () => {
    if (!suggestion) return;
    if (suggestion.display_name) setName(suggestion.display_name);
    if (suggestion.role_label) setRole(suggestion.role_label);
  };

  const handleSave = async () => {
    setSaving(true);
    await saveContact({ email: contact.email, display_name: name, department: dept, role_label: role });
    setSaving(false);
    onSave();
  };

  return (
    <div className="mt-1 p-2 bg-white border border-dashed border-gray-200 rounded-lg space-y-2">
      {/* Suggestion banner */}
      {suggesting && (
        <p className="text-xs text-gray-400 italic">Looking for info in emails…</p>
      )}
      {suggestion && !suggesting && (
        <div className="flex items-start justify-between gap-2 bg-brand-light border border-brand-light rounded px-2 py-1.5">
          <div className="text-xs text-brand space-y-0.5">
            <p className="font-medium">Suggested from {suggestion.sources?.join(", ")}:</p>
            {suggestion.display_name && <p>Name: <span className="font-semibold">{suggestion.display_name}</span></p>}
            {suggestion.role_label  && <p>Role: <span className="font-semibold">{suggestion.role_label}</span></p>}
          </div>
          <button
            onClick={applySuggestion}
            className="flex-shrink-0 text-xs text-brand hover:text-navy font-medium underline"
          >
            Use
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-28">
          <label className="text-xs text-gray-400 mb-0.5 block">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        {isInternal ? (
          <div className="min-w-36">
            <label className="text-xs text-gray-400 mb-0.5 block">Department</label>
            <select
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand bg-white"
            >
              <option value="">Select dept…</option>
              {INTERNAL_DEPTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        ) : (
          <div className="min-w-28">
            <label className="text-xs text-gray-400 mb-0.5 block">Role / Title</label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Account Manager"
              className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
        )}
        <div className="flex gap-1.5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-2.5 py-1 bg-brand text-white text-xs rounded hover:bg-brand-hover disabled:opacity-40"
          >
            {saving ? "…" : "Save"}
          </button>
          <button onClick={onCancel} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-600">✕</button>
        </div>
      </div>
    </div>
  );
}

// ─── Single Contact Row ───────────────────────────────────────────────────────
function ContactRow({ contact, domainType, onRefresh }) {
  const [editing, setEditing] = useState(false);

  const isMapped = !!contact.contact_id;

  const handleDelete = async () => {
    if (!contact.contact_id) return;
    await deleteContact(contact.contact_id);
    onRefresh();
  };

  if (editing) {
    return (
      <ContactMapForm
        contact={contact}
        domainType={domainType}
        onSave={() => { setEditing(false); onRefresh(); }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`flex items-center justify-between py-1.5 px-2 rounded text-xs group
      ${isMapped ? "hover:bg-gray-50" : "bg-amber-50 border border-amber-100"}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isMapped ? "bg-green-400" : "bg-amber-400"}`} />
        <span className="text-gray-700 truncate">{contact.email}</span>
        {contact.display_name && (
          <span className="text-gray-500 hidden sm:inline">· {contact.display_name}</span>
        )}
        {contact.department && (
          <span className="text-brand hidden sm:inline">· {contact.department}</span>
        )}
        {contact.role_label && !contact.department && (
          <span className="text-gray-400 hidden sm:inline">· {contact.role_label}</span>
        )}
        {!isMapped && (
          <span className="text-amber-600 font-medium">unmapped</span>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button onClick={() => setEditing(true)}
          className="px-2 py-0.5 text-brand hover:bg-brand-light rounded text-xs">
          {isMapped ? "Edit" : "Map"}
        </button>
        {isMapped && (
          <button onClick={handleDelete}
            className="px-2 py-0.5 text-red-400 hover:bg-red-50 rounded text-xs">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Domain Card ──────────────────────────────────────────────────────────────
function DomainCard({ item, onRefresh }) {
  const [expanded, setExpanded] = useState(!item.domain_id);
  const [editingDomain, setEditingDomain] = useState(false);

  const unmappedContacts = item.contacts.filter((c) => !c.contact_id);
  const mappedContacts   = item.contacts.filter((c) => !!c.contact_id);
  const isMapped = !!item.domain_id;

  const handleDeleteDomain = async () => {
    await deleteDomain(item.domain_id);
    onRefresh();
  };

  return (
    <div className={`rounded-xl border ${isMapped ? "border-gray-100 bg-white" : "border-amber-200 bg-amber-50"} overflow-hidden`}>
      {/* Domain header */}
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded((x) => !x)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`text-sm transition-transform ${expanded ? "rotate-90" : ""}`}>›</span>
          <span className="font-mono text-sm font-medium text-gray-700">{item.domain}</span>
          {isMapped && typeBadge(item.type)}
          {isMapped && <span className="text-sm text-gray-500">{item.label}</span>}
          {!isMapped && (
            <span className="text-xs text-amber-600 font-medium">⚠ Not mapped</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 flex-shrink-0">
          <span>{item.contacts.length} contact{item.contacts.length !== 1 ? "s" : ""}</span>
          {unmappedContacts.length > 0 && (
            <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
              {unmappedContacts.length} unmapped
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-50">
          {/* Domain mapping form */}
          {(!isMapped || editingDomain) ? (
            <DomainMapForm
              domain={item.domain}
              existing={isMapped ? item : null}
              onSave={() => { setEditingDomain(false); onRefresh(); }}
              onCancel={isMapped ? () => setEditingDomain(false) : null}
            />
          ) : (
            <div className="flex items-center gap-2 mt-2 mb-3">
              <button onClick={() => setEditingDomain(true)}
                className="text-xs text-gray-400 hover:text-brand transition-colors">
                Edit mapping
              </button>
              <span className="text-gray-200">|</span>
              <button onClick={handleDeleteDomain}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors">
                Remove mapping
              </button>
            </div>
          )}

          {/* Contacts */}
          {item.contacts.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Contacts</p>
              {/* Unmapped first */}
              {unmappedContacts.map((c) => (
                <ContactRow key={c.email} contact={c} domainType={item.type} onRefresh={onRefresh} />
              ))}
              {mappedContacts.map((c) => (
                <ContactRow key={c.email} contact={c} domainType={item.type} onRefresh={onRefresh} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main People Page ─────────────────────────────────────────────────────────
export default function People() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | unmapped | mapped

  const load = useCallback(() => {
    setLoading(true);
    discoverPeople()
      .then((d) => setData(d.domains))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = data
    .filter((d) => {
      if (filter === "unmapped") return !d.domain_id;
      if (filter === "mapped")   return !!d.domain_id;
      return true;
    })
    .filter((d) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        d.domain.includes(q) ||
        (d.label || "").toLowerCase().includes(q) ||
        d.contacts.some((c) => c.email.includes(q) || (c.display_name || "").toLowerCase().includes(q))
      );
    });

  const unmappedDomains  = data.filter((d) => !d.domain_id).length;
  const mappedDomains    = data.filter((d) => !!d.domain_id).length;
  const totalContacts    = data.reduce((s, d) => s + d.contacts.length, 0);
  const unmappedContacts = data.reduce((s, d) => s + d.contacts.filter((c) => !c.contact_id).length, 0);

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Domains discovered", value: data.length, color: "text-gray-800" },
          { label: "Domains mapped",     value: mappedDomains,    color: "text-green-700" },
          { label: "Contacts seen",      value: totalContacts,    color: "text-gray-800" },
          { label: "Contacts unmapped",  value: unmappedContacts, color: unmappedContacts > 0 ? "text-amber-600" : "text-gray-400" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-xs text-gray-400">{s.label}</p>
            <p className={`text-2xl font-bold mt-0.5 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters & search */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search domain or email…"
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm flex-1 min-w-48 focus:outline-none focus:ring-2 focus:ring-brand"
        />
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {[["all","All"],["unmapped","Unmapped"],["mapped","Mapped"]].map(([v,l]) => (
            <button
              key={v}
              onClick={() => setFilter(v)}
              className={`px-3 py-2 text-sm transition-colors ${filter === v ? "bg-brand text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              {l}
            </button>
          ))}
        </div>
        <button onClick={load} className="text-sm text-gray-400 hover:text-brand transition-colors px-2">
          ↻ Refresh
        </button>
      </div>

      {/* Domain list */}
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center py-10 text-gray-400 text-sm">No domains found.</p>
      ) : (
        <div className="space-y-3">
          {/* Unmapped at the top */}
          {filtered.filter((d) => !d.domain_id).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">
                ⚠ Needs mapping ({filtered.filter((d) => !d.domain_id).length})
              </p>
              <div className="space-y-2">
                {filtered.filter((d) => !d.domain_id).map((d) => (
                  <DomainCard key={d.domain} item={d} onRefresh={load} />
                ))}
              </div>
            </div>
          )}
          {/* Mapped domains */}
          {filtered.filter((d) => !!d.domain_id).length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 mt-4">
                Mapped domains ({filtered.filter((d) => !!d.domain_id).length})
              </p>
              <div className="space-y-2">
                {filtered.filter((d) => !!d.domain_id).map((d) => (
                  <DomainCard key={d.domain} item={d} onRefresh={load} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
