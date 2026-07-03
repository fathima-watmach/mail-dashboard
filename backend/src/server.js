require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const session    = require("express-session");
const path       = require("path");
const pgSession  = require("connect-pg-simple")(session);
const pool       = require("./db/pool");
const cron = require("node-cron");

const authRoutes     = require("./routes/auth");
const zohoAuthRoutes = require("./routes/zohoAuth");
const dashboardRoutes = require("./routes/dashboard");
const peopleRoutes   = require("./routes/people");
const calendarRoutes = require("./routes/calendar");
const { ingestAll, reclassifyUnclassified } = require("./services/ingest");

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

// Serve the built React frontend for all non-API routes
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");
app.use(express.static(FRONTEND_DIST));
app.get("*", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIST, "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Mail dashboard backend running on http://localhost:${PORT}`);
  console.log(`Login at http://localhost:${PORT}/auth/login`);
});

// Hourly: fetch new emails (last 7 days only — fast, small batch)
cron.schedule("0 * * * *", () => {
  ingestAll().catch((err) => console.error("[cron] Ingestion run failed:", err.message));
});

// Every 2 hours: slowly reclassify any emails that failed classification (rate-limit recovery)
cron.schedule("0 */2 * * *", () => {
  reclassifyUnclassified().catch((err) => console.error("[reclassify] Cron failed:", err.message));
});

// On startup: historical ingest only for NEW users (0 emails); existing users get 7-day catch-up
setTimeout(() => {
  console.log("[startup] Running ingestion...");
  ingestAll({ historical: true }).catch((err) => console.error("[startup] Ingestion failed:", err.message));
}, 5000);
