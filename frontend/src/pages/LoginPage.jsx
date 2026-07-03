import React from "react";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-navy flex items-center justify-center">
      {/* Subtle grid pattern overlay */}
      <div className="absolute inset-0 opacity-5"
        style={{ backgroundImage: "linear-gradient(#3B5CE8 1px, transparent 1px), linear-gradient(90deg, #3B5CE8 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

      <div className="relative bg-navy-light border border-navy-border rounded-2xl shadow-2xl p-10 max-w-md w-full text-center">
        {/* Logo mark */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 bg-brand rounded-xl flex items-center justify-center">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="text-left">
            <p className="text-white font-bold text-xl tracking-wide leading-none">WATMACH</p>
            <p className="text-brand-muted text-xs tracking-widest uppercase">Mail Dashboard</p>
          </div>
        </div>

        <p className="text-gray-400 mb-8 text-sm leading-relaxed">
          Connect your mailbox to classify emails by department,<br />track escalations, and respond directly.
        </p>

        <div className="space-y-3">
          {/* Microsoft Outlook */}
          <a
            href="/auth/login"
            className="flex items-center justify-center gap-3 bg-brand hover:bg-brand-hover text-white px-6 py-3 rounded-lg font-medium transition-colors w-full"
          >
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 23 23" fill="none">
              <rect x="1"  y="1"  width="10" height="10" fill="#f25022" />
              <rect x="12" y="1"  width="10" height="10" fill="#7fba00" />
              <rect x="1"  y="12" width="10" height="10" fill="#00a4ef" />
              <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
            </svg>
            Sign in with Microsoft Outlook
          </a>

          {/* Zoho Mail */}
          <a
            href="/auth/zoho/login"
            className="flex items-center justify-center gap-3 bg-navy-muted border border-navy-border text-gray-300 hover:border-brand hover:text-white px-6 py-3 rounded-lg font-medium transition-colors w-full"
          >
            <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="20" fill="#E8490F"/>
              <text x="50%" y="55%" dominantBaseline="middle" textAnchor="middle" fill="white" fontSize="16" fontWeight="bold" fontFamily="sans-serif">Z</text>
            </svg>
            Sign in with Zoho Mail
          </a>
        </div>

        <p className="text-xs text-gray-600 mt-6">
          Each user connects their own mailbox. Your data stays separate.
        </p>
      </div>
    </div>
  );
}
