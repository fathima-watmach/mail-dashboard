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
const { ingestAll } = require("./services/ingest");

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

// ---- Periodic ingestion ----
// Runs every hour. Adjust the cron expression as needed once you have a
// feel for how fresh the data needs to be vs. how much it costs to refresh.
cron.schedule("0 * * * *", () => {
  console.log("[cron] Running scheduled ingestion...");
  ingestAll().catch((err) => console.error("[cron] Ingestion run failed:", err.message));
});

// Also do one ingestion run shortly after server start, so you don't have
// to wait an hour to see data during testing.
setTimeout(() => {
  console.log("[startup] Running initial ingestion pass...");
  ingestAll().catch((err) => console.error("[startup] Initial ingestion failed:", err.message));
}, 5000);
