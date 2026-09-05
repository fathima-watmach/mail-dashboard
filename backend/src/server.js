require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const session    = require("express-session");
const pgSession  = require("connect-pg-simple")(session);
const pool       = require("./db/pool");
const cron = require("node-cron");

const authRoutes     = require("./routes/auth");
const zohoAuthRoutes = require("./routes/zohoAuth");
const dashboardRoutes = require("./routes/dashboard");
const peopleRoutes   = require("./routes/people");
const calendarRoutes = require("./routes/calendar");
const { ingestAll, reclassifyUnclassified } = require("./services/ingest");

// Real crash hit twice in one evening 2026-09-05, same root cause: Express 4
// doesn't auto-catch a rejected promise inside an async route handler — a
// transient Postgres `ETIMEDOUT` (network blip, not a code bug) inside
// dashboard.js's /summary route went unhandled and killed the ENTIRE server
// process, taking every route down for every user until manually restarted.
// AGENTS.md already flagged this exact class of bug for /analytics's own
// try/catch — this is the global backstop for every OTHER route that isn't
// individually guarded: log it and keep the process alive (the one request
// that hit the error still fails for its caller, but nobody else's session
// gets taken down with it). Doesn't replace fixing hot-path routes with
// their own try/catch where it matters, just stops one bad query from ever
// being a full-outage event again.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection] Caught, server staying up:", err?.message || err);
});

const app = express();
const isProd = process.env.NODE_ENV === "production";

// Trust Render's reverse proxy so secure cookies work over HTTPS
if (isProd) app.set("trust proxy", 1);

app.use(
  cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true,
  })
);
app.use(express.json());
app.use(
  session({
    store: new pgSession({ pool, tableName: "session", createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,   // HTTPS only in production
      sameSite: isProd ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use("/auth",          authRoutes);
app.use("/auth/zoho",     zohoAuthRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/people",    peopleRoutes);
app.use("/api/calendar",  calendarRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

// Split deployment as of 2026-09-05: the frontend deploys separately to
// Vercel (see frontend/vercel.json) instead of being built and served here
// as static files — this backend is API-only now. Removed the old
// express.static + catch-all sendFile(index.html) block along with it
// (render.yaml's buildCommand no longer builds the frontend either, so
// frontend/dist won't even exist here). A request to an unknown path now
// gets a real 404 instead of always being handed index.html.
app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Mail dashboard backend running on http://localhost:${PORT}`);
  console.log(`Login at http://localhost:${PORT}/auth/login`);
});

// AUTO_INGEST_DISABLED=true skips the startup/hourly ingest and the 2-hourly
// reclassify cron entirely — for when the server needs to be up (frontend
// access, manual DB checks) but a manual backfill/reclassify script is
// already running standalone and would otherwise collide with these (two
// processes hitting the same Gemini key trigger real 429 contention — hit
// this for real earlier). Remove/unset once there's no manual script running.
const AUTO_INGEST_DISABLED = process.env.AUTO_INGEST_DISABLED === "true";
if (AUTO_INGEST_DISABLED) {
  console.log("[startup] AUTO_INGEST_DISABLED=true — skipping startup ingest, hourly ingest cron, and reclassify cron.");
} else {
  // Hourly: fetch new emails (last 7 days only — fast, small batch)
  cron.schedule("0 * * * *", () => {
    ingestAll().catch((err) => console.error("[cron] Ingestion run failed:", err.message));
  });

  // Every 2 hours: slowly reclassify any emails that failed classification (rate-limit recovery)
  // TEMPORARILY DISABLED 2026-09-05 at the user's explicit request: Sariah
  // mail from Aug 1 onward is being pulled in deliberately unclassified
  // (classified_at IS NULL) while classification corrections are still in
  // progress. This cron doesn't distinguish "failed" from "deliberately
  // held back" — left running, it would auto-classify that mail within 2
  // hours regardless, defeating the point. Re-enable once corrections are
  // done and the reclassify pass should actually run.
  // cron.schedule("0 */2 * * *", () => {
  //   reclassifyUnclassified().catch((err) => console.error("[reclassify] Cron failed:", err.message));
  // });

  // On startup: historical ingest only for NEW users (0 emails); existing users get 7-day catch-up
  setTimeout(() => {
    console.log("[startup] Running ingestion...");
    ingestAll({ historical: true }).catch((err) => console.error("[startup] Ingestion failed:", err.message));
  }, 5000);
}
