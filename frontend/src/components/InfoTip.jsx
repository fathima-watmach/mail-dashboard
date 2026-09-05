import React, { useState } from "react";

// Click-to-toggle info tooltip — not hover-only, since the native `title`
// attribute doesn't respond to a click/tap at all (no-op on touch devices,
// and easy to miss as "nothing happened" even on desktop). Matches the
// existing Ask Beacon button's toggle pattern.
export default function InfoTip({ text, className = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((x) => !x); }}
        className="text-gray-300 hover:text-gray-500 leading-none align-middle"
        aria-label="More info"
      >
        ⓘ
      </button>
      {open && (
        <span
          onClick={(e) => e.stopPropagation()}
          className="absolute z-20 left-0 top-5 w-56 bg-navy text-white text-[11px] leading-relaxed rounded-lg shadow-lg p-2.5 normal-case font-normal"
        >
          {text}
        </span>
      )}
    </span>
  );
}
