import React from "react";
import watmachLogo from "../assets/watmach-logo.png";
import { InitialsAvatar } from "./shared";

const ICONS = {
  overview: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />,
  escalations: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />,
  departments: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m-1 4h1m4-4h1m-1 4h1M9 21v-4a1 1 0 011-1h2a1 1 0 011 1v4" />,
  people: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 20h5v-1a4 4 0 00-3-3.87M9 20H4v-1a4 4 0 013-3.87m5-3a4 4 0 100-8 4 4 0 000 8zm7 1a3 3 0 10-3-3m-13 3a3 3 0 013-3" />,
  action: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 12l2 2 4-4m5 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
  mail: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />,
  calendar: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
  scores: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 19V6m0 13H5.5A1.5 1.5 0 014 17.5V16a1 1 0 011-1h4m0 4h6m0 0h3.5a1.5 1.5 0 001.5-1.5V15a1 1 0 00-1-1h-4m0 5V10a1 1 0 011-1h3a1 1 0 011 1v8" />,
  analytics: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 3v18h18M8 17V10m5 7V6m5 11v-4" />,
};

function Icon({ name }) {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {ICONS[name]}
    </svg>
  );
}

const PRIMARY = [
  { key: "overview", label: "Overview", icon: "overview" },
  { key: "departments", label: "Departments", icon: "departments" },
  { key: "people", label: "People", icon: "people" },
];

const SECONDARY = [
  { key: "inbox", label: "Inbox", icon: "mail", badge: "actionNeeded" },
  { key: "calendar", label: "Calendar", icon: "calendar" },
  { key: "scores", label: "Scores", icon: "scores" },
];

function NavRow({ item, active, count, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
        ${active ? "bg-white/10 text-white font-medium" : "text-white/60 hover:text-white hover:bg-white/5"}`}
    >
      <Icon name={item.icon} />
      <span className="flex-1 text-left truncate">{item.label}</span>
      {count > 0 && (
        <span className="text-[10px] bg-white/15 text-white px-1.5 py-0.5 rounded-full">{count}</span>
      )}
    </button>
  );
}

export default function Sidebar({ tab, setTab, summary, user, onLogout }) {
  const counts = { escalations: summary.escalations, actionNeeded: summary.actionNeeded };

  return (
    <aside className="w-60 flex-shrink-0 bg-brand min-h-screen sticky top-0 flex flex-col px-3 py-4">
      <div className="flex items-center gap-2 px-2 mb-6">
        <img src={watmachLogo} alt="Watmach" className="h-8 w-auto" />
        <span className="text-white font-semibold tracking-wide">Beacon</span>
      </div>

      <nav className="space-y-1">
        {PRIMARY.map((item) => (
          <NavRow key={item.key} item={item} active={tab === item.key}
            count={item.badge ? counts[item.badge] : 0} onClick={() => setTab(item.key)} />
        ))}
      </nav>

      <div className="h-px bg-white/10 my-4" />

      <nav className="space-y-1">
        {SECONDARY.map((item) => (
          <NavRow key={item.key} item={item} active={tab === item.key}
            count={item.badge ? counts[item.badge] : 0} onClick={() => setTab(item.key)} />
        ))}
      </nav>

      <div className="flex-1" />

      <div className="flex items-center gap-2.5 px-2 pt-4 border-t border-white/10">
        <InitialsAvatar email={user.email} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white truncate">{user.email}</p>
          <button onClick={onLogout} className="text-xs text-white/50 hover:text-white transition-colors">
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
