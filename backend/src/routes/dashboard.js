const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../db/pool");
const { requireLogin, attachVisibility } = require("../middleware/auth");
const { getValidAccessToken: getMsToken }   = require("../services/msAuth");
const { getValidAccessToken: getZohoToken } = require("../services/zohoAuth");
const { sendNewMail: zohoSendNewMail }      = require("../services/zohoMail");
const { graphBaseFor, sendNewMail: graphSendNewMail } = require("../services/graphMail");
const { resolveMailboxAccess }              = require("../services/mailboxAccess");
const { callLLM, extractJson }              = require("../services/llm");
const { getOrGenerateThreadSummary }        = require("../services/threadTracking");
const { embedText, toVectorLiteral }        = require("../services/embeddings");

router.use(requireLogin, attachVisibility);

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Standard-ops SLA targets per severity tier, hours-to-first-response.
// Real targets from Sariah's own MoM (Action_Taken_MoM_01-09-2026.pdf, "SLA
// Targets" table) — replaces the placeholder values (1/4/24/72h) used
// before the client actually specified these. Medium ("within 2-3 days")
// and Low ("within 3-5 days") are given as ranges in the MoM, not single
// numbers — using the upper bound as the deadline (the promise is "no
// later than X days"), consistent with how Critical/High are already
// unambiguous single values.
const SLA_HOURS = { critical: 24, high: 48, medium: 72, low: 120 };
const SLA_CASE = `CASE severity WHEN 'critical' THEN 24 WHEN 'high' THEN 48 WHEN 'medium' THEN 72 WHEN 'low' THEN 120 END`;

// Collapses a `filtered` CTE (must expose id, conversation_id,
// internet_message_id, received_at) down to one representative row per
// thread, for list views (Escalations/Action Needed/All Emails) — a real
// thread can have dozens of messages, and showing every one as a separate
// row read as "duplicates" to a user even though each Graph message is
// technically distinct. Two different dedup keys, applied in sequence:
//  1. internet_message_id (RFC5322 Message-ID) collapses the SAME physical
//     email delivered to two DIFFERENT shared inboxes (Graph assigns a
//     different conversationId per mailbox, so conversation_id alone can't
//     catch this — verified on a real pair before adding this column).
//     COALESCE'd with a per-row fallback so a NULL internet_message_id
//     (most historical rows, backfilled only for known-duplicate pairs)
//     never accidentally collapses with anything else.
//  2. conversation_id collapses a genuine multi-message thread down to its
//     single latest matching message — deliberately NOT attempted across
//     mailboxes (no shared conversation_id to key on there), since fuzzy
//     subject/participant thread-merging is exactly the fragile approach
//     conversation_id was adopted to replace (see AGENTS.md).
const THREAD_DEDUP_CTE = `
     dedup_msg AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY COALESCE(internet_message_id, 'row-' || id::text)
         ORDER BY id
       ) AS msg_rn
       FROM filtered
     ),
     deduped AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY conversation_id ORDER BY received_at DESC
       ) AS thread_rn
       FROM dedup_msg WHERE msg_rn = 1
     )`;

// Appends an optional inclusive date-range filter (req.query.from/to, 'YYYY-MM-DD')
// to a query's WHERE clause, pushing bound params onto the given array. Omitted
// entirely when no range is given, so every route stays backward compatible.
function dateRangeFilter(req, params, column = "e.received_at") {
  let clause = "";
  if (req.query.from) {
    params.push(req.query.from);
    clause += ` AND ${column} >= $${params.length}`;
  }
  if (req.query.to) {
    params.push(req.query.to);
    clause += ` AND ${column} < $${params.length}::date + interval '1 day'`;
  }
  return clause;
}

router.get("/summary", async (req, res) => {
  const ids = req.visibleMailboxIds;
  const buildParams = () => [ids];
  const range = (params) => dateRangeFilter(req, params, "received_at");

  const p1 = buildParams(), p2 = buildParams(), p3 = buildParams(), p4 = buildParams();
  // Every count here is DISTINCT THREADS, not raw rows — total/critical used
  // to be plain COUNT(*), the one inconsistency left after actionNeeded/
  // escalations were already fixed: a single 10-message escalated thread
  // was counting as 10 toward "Total Volume" while showing as 1 card
  // everywhere else, which is exactly the "why does this look so bloated"
  // mismatch fixed everywhere at once on 2026-09-05 (Buckets, Trends,
  // Scores included).
  const [totalRes, criticalRes, actionRes, escalationRes] = await Promise.all([
    pool.query(`SELECT COUNT(DISTINCT conversation_id) FROM emails WHERE mailbox_owner_id = ANY($1::int[]) ${range(p1)}`, p1),
    pool.query(`SELECT COUNT(DISTINCT conversation_id) FROM emails WHERE mailbox_owner_id = ANY($1::int[]) AND is_critical = true ${range(p2)}`, p2),
    pool.query(
      `SELECT COUNT(DISTINCT conversation_id) FROM emails
       WHERE mailbox_owner_id = ANY($1::int[]) AND urgency = 'action_needed' AND is_direct_to_owner = true ${range(p3)}`,
      p3
    ),
    pool.query(
      `SELECT COUNT(DISTINCT conversation_id) FROM emails
       WHERE mailbox_owner_id = ANY($1::int[]) AND (classification_raw->>'isEscalation')::boolean = true ${range(p4)}`,
      p4
    ),
  ]);

  res.json({
    total: Number(totalRes.rows[0].count),
    critical: Number(criticalRes.rows[0].count),
    actionNeeded: Number(actionRes.rows[0].count),
    escalations: Number(escalationRes.rows[0].count),
  });
});

router.get("/buckets", async (req, res) => {
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params);
  const { rows } = await pool.query(
    `SELECT d.name AS department, e.urgency, COUNT(DISTINCT e.conversation_id) AS count
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.mailbox_owner_id = ANY($1::int[]) ${range}
     GROUP BY d.name, e.urgency
     ORDER BY d.name`,
    params
  );

  res.json({ buckets: rows });
});

router.get("/trends", async (req, res) => {
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params, "received_at");
  // Same date bounds, applied to actioned_at instead — reuses the params/$-indices
  // dateRangeFilter already pushed above rather than pushing (and renumbering) again.
  const actionedRange = range.replace(/received_at/g, "actioned_at");

  const { rows } = await pool.query(
    // action_needed/fyi/escalations count DISTINCT THREADS per day, not raw
    // rows — a 10-message escalated thread was inflating this chart the
    // same way it inflated Scores' department/sender totals (real bug
    // fixed 2026-09-05 across both at once — "one thread, one mail" only
    // held in the list views before this, not in any of the count/chart
    // routes).
    `WITH received AS (
       SELECT date_trunc('day', received_at) AS day,
              COUNT(DISTINCT conversation_id) FILTER (WHERE urgency = 'action_needed') AS action_needed,
              COUNT(DISTINCT conversation_id) FILTER (WHERE urgency = 'fyi') AS fyi,
              COUNT(DISTINCT conversation_id) FILTER (WHERE (classification_raw->>'isEscalation')::boolean) AS escalations
       FROM emails
       WHERE mailbox_owner_id = ANY($1::int[]) ${range}
       GROUP BY 1
     ),
     -- Two different real signals, by mailbox type — actioned_at ALONE
     -- undercounted shared inboxes down to zero (real bug: contactus@/
     -- maintenance@ have 583 genuine outgoing replies, 0 with actioned_at
     -- set, since the Reply button is disabled for shared inboxes by
     -- design — see AGENTS.md's read-only note). Shared inboxes: any
     -- outgoing message from the SAME DOMAIN as the mailbox counts, not
     -- just the mailbox's own literal address — real bug fixed 2026-09-05:
     -- a reply from a coordinator's own @sariahfm.com address (not
     -- literally contactus@/maintenance@) was invisible to this exact
     -- check, undercounting "responded" the same way it inflated
     -- Unassigned. Personal mailboxes: actioned_at still applies, since
     -- the in-app Reply button works there.
     responded_raw AS (
       SELECT e.conversation_id, e.received_at AS reply_at
       FROM emails e JOIN people p ON p.id = e.mailbox_owner_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND p.is_shared_inbox = true
         AND SPLIT_PART(e.from_email, '@', 2) = SPLIT_PART(p.email, '@', 2) ${range}
       UNION
       SELECT e.conversation_id, e.actioned_at AS reply_at
       FROM emails e JOIN people p ON p.id = e.mailbox_owner_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND p.is_shared_inbox = false AND e.actioned_at IS NOT NULL ${actionedRange}
     ),
     responded AS (
       SELECT date_trunc('day', reply_at) AS day, COUNT(DISTINCT conversation_id) AS responded
       FROM responded_raw
       GROUP BY 1
     )
     SELECT to_char(COALESCE(r.day, p.day), 'YYYY-MM-DD') AS day,
            COALESCE(r.action_needed, 0) AS action_needed,
            COALESCE(r.fyi, 0) AS fyi,
            COALESCE(r.escalations, 0) AS escalations,
            COALESCE(p.responded, 0) AS responded
     FROM received r FULL OUTER JOIN responded p ON r.day = p.day
     ORDER BY 1`,
    params
  );

  res.json({
    days: rows.map((r) => ({
      day: r.day,
      actionNeeded: Number(r.action_needed),
      fyi: Number(r.fyi),
      escalations: Number(r.escalations),
      responded: Number(r.responded),
    })),
  });
});

router.get("/analytics", async (req, res) => {
 try {
  const ids = req.visibleMailboxIds;
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || (() => {
    const d = new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 29);
    return d.toISOString().slice(0, 10);
  })();

  // Previous period of equal length immediately before `from`, for the KPI deltas.
  const fromDate = new Date(from + "T00:00:00Z");
  const toDate = new Date(to + "T00:00:00Z");
  const rangeDays = Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1);
  const prevTo = new Date(fromDate); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - rangeDays + 1);
  const prevFromStr = prevFrom.toISOString().slice(0, 10);
  const prevToStr = prevTo.toISOString().slice(0, 10);

  const params = [ids, from, to, prevFromStr, prevToStr];
  const currentPeriodParams = params.slice(0, 3); // queries that only need ids/from/to, not the previous-period pair
  const CATEGORY_CASE = "CASE WHEN is_critical THEN 'urgent' WHEN urgency = 'action_needed' THEN 'reply' ELSE 'fyi' END";

  const [kpiRes, respRes, volumeRes, sendersRes, trendRes, heatmapRes, slaRes, escResRes] = await Promise.all([
    pool.query(
      // current_total/prev_total and current_backlog/prev_backlog count
      // DISTINCT THREADS — consistent with /summary's Total Volume (which
      // this KPI's delta is shown alongside) and every other "how much mail"
      // figure fixed at the same time (2026-09-05). Classified/confidence
      // stay per-MESSAGE on purpose — classification coverage is about
      // whether an individual message got processed, not about threads.
      `SELECT
         COUNT(DISTINCT conversation_id) FILTER (WHERE received_at >= $2 AND received_at < $3::date + interval '1 day') AS current_total,
         COUNT(DISTINCT conversation_id) FILTER (WHERE received_at >= $4 AND received_at < $5::date + interval '1 day') AS prev_total,
         COUNT(*) FILTER (WHERE classified_at IS NOT NULL AND received_at >= $2 AND received_at < $3::date + interval '1 day') AS current_classified,
         COUNT(*) FILTER (WHERE classified_at IS NOT NULL AND received_at >= $4 AND received_at < $5::date + interval '1 day') AS prev_classified,
         COUNT(*) FILTER (WHERE received_at >= $2 AND received_at < $3::date + interval '1 day') AS current_total_msgs,
         COUNT(*) FILTER (WHERE received_at >= $4 AND received_at < $5::date + interval '1 day') AS prev_total_msgs,
         COUNT(DISTINCT conversation_id) FILTER (WHERE urgency = 'action_needed' AND actioned_at IS NULL AND received_at >= $2 AND received_at < $3::date + interval '1 day') AS current_backlog,
         COUNT(DISTINCT conversation_id) FILTER (WHERE urgency = 'action_needed' AND actioned_at IS NULL AND received_at >= $4 AND received_at < $5::date + interval '1 day') AS prev_backlog,
         ROUND(AVG(confidence) FILTER (WHERE received_at >= $2 AND received_at < $3::date + interval '1 day'), 1) AS current_confidence,
         ROUND(AVG(confidence) FILTER (WHERE received_at >= $4 AND received_at < $5::date + interval '1 day'), 1) AS prev_confidence
       FROM emails WHERE mailbox_owner_id = ANY($1::int[])`,
      params
    ),
    pool.query(
      // Customer message -> Sariah's own first reply only, not any-direction
      // thread activity — Sariah controls when e2 (its own outgoing message)
      // happens, not when a customer chooses to write back, so only e1
      // (incoming) -> e2 (outgoing, from the mailbox's own address) counts
      // as a "response time" in the sense this KPI/chart claims to measure.
      `WITH base AS (
         SELECT e.id, e.received_at, e.mailbox_owner_id, e.from_email, p.email AS mailbox_email,
                LOWER(REGEXP_REPLACE(e.subject, '^\\s*(re|fw|fwd)\\s*:\\s*', '', 'gi')) AS base_subject,
                CASE WHEN e.received_at >= $2 AND e.received_at < $3::date + interval '1 day' THEN 'current'
                     WHEN e.received_at >= $4 AND e.received_at < $5::date + interval '1 day' THEN 'previous'
                END AS period
         FROM emails e
         JOIN people p ON p.id = e.mailbox_owner_id
         WHERE e.mailbox_owner_id = ANY($1::int[])
           AND e.received_at >= $4 AND e.received_at < $3::date + interval '1 day'
       ),
       thread_gaps AS (
         SELECT e1.period, EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
         FROM base e1 JOIN base e2 ON
           e2.mailbox_owner_id = e1.mailbox_owner_id
           AND e2.base_subject = e1.base_subject
           AND e2.received_at > e1.received_at AND e2.received_at < e1.received_at + interval '14 days'
           AND SPLIT_PART(e2.from_email, '@', 2) = SPLIT_PART(e2.mailbox_email, '@', 2)
         WHERE e1.period IS NOT NULL AND SPLIT_PART(e1.from_email, '@', 2) != SPLIT_PART(e1.mailbox_email, '@', 2)
         GROUP BY e1.id, e1.period, e1.received_at
       )
       SELECT period, ROUND(AVG(gap_hours), 1) AS avg_hours FROM thread_gaps GROUP BY period`,
      params
    ),
    // Volume by day, bucketed by the 4-tier severity taxonomy (same one used
    // everywhere else on the dashboard — Priority Mix, escalation badges,
    // Scores) rather than the older is_critical/urgency-derived 3-tier scheme
    // this used to use. Excludes not-yet-classified emails (severity IS NULL),
    // same as every other severity-based query already does.
    pool.query(
      `SELECT to_char(date_trunc('day', received_at), 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'high') AS high,
              COUNT(*) FILTER (WHERE severity = 'medium') AS medium,
              COUNT(*) FILTER (WHERE severity = 'low') AS low
       FROM emails
       WHERE mailbox_owner_id = ANY($1::int[]) AND severity IS NOT NULL
         AND received_at >= $2 AND received_at < $3::date + interval '1 day'
       GROUP BY 1 ORDER BY 1`,
      currentPeriodParams
    ),
    pool.query(
      `WITH bucketed AS (
         SELECT from_email, from_name, ${CATEGORY_CASE} AS category
         FROM emails
         WHERE mailbox_owner_id = ANY($1::int[]) AND received_at >= $2 AND received_at < $3::date + interval '1 day'
       ),
       per_sender_cat AS (
         SELECT from_email, from_name, category, COUNT(*) AS cnt FROM bucketed GROUP BY from_email, from_name, category
       ),
       totals AS (
         SELECT from_email, MAX(from_name) AS from_name, SUM(cnt) AS total FROM per_sender_cat GROUP BY from_email
       )
       SELECT t.from_email, t.from_name, t.total,
         (SELECT psc.category FROM per_sender_cat psc WHERE psc.from_email = t.from_email ORDER BY psc.cnt DESC LIMIT 1) AS dominant_category
       FROM totals t
       ORDER BY t.total DESC
       LIMIT 8`,
      currentPeriodParams
    ),
    pool.query(
      // Same customer-message -> Sariah's-own-reply restriction as the KPI
      // query above — see its comment. Without this, the chart included any
      // reply direction (a customer replying back counts as much as Sariah
      // replying), which isn't "how fast is Sariah responding."
      `WITH base AS (
         SELECT e.id, e.received_at, e.mailbox_owner_id, e.from_email, p.email AS mailbox_email,
                LOWER(REGEXP_REPLACE(e.subject, '^\\s*(re|fw|fwd)\\s*:\\s*', '', 'gi')) AS base_subject
         FROM emails e
         JOIN people p ON p.id = e.mailbox_owner_id
         WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.received_at >= $2 AND e.received_at < $3::date + interval '1 day'
       ),
       thread_gaps AS (
         -- Daily, not weekly — with the real date range this app has seen so
         -- far, weekly buckets collapse to just 1-2 points (a "trend" line
         -- with barely any line to it). Daily gives a real shape immediately.
         SELECT e1.id, date_trunc('day', e1.received_at) AS week,
                EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
         FROM base e1 JOIN base e2 ON
           e2.mailbox_owner_id = e1.mailbox_owner_id
           AND e2.base_subject = e1.base_subject
           AND e2.received_at > e1.received_at AND e2.received_at < e1.received_at + interval '14 days'
           AND SPLIT_PART(e2.from_email, '@', 2) = SPLIT_PART(e2.mailbox_email, '@', 2)
         WHERE SPLIT_PART(e1.from_email, '@', 2) != SPLIT_PART(e1.mailbox_email, '@', 2)
         GROUP BY e1.id, e1.received_at
       )
       SELECT to_char(week, 'YYYY-MM-DD') AS week, ROUND(AVG(gap_hours), 1) AS avg_hours
       FROM thread_gaps GROUP BY week ORDER BY week`,
      currentPeriodParams
    ),
    pool.query(
      `SELECT EXTRACT(dow FROM received_at)::int AS dow, EXTRACT(hour FROM received_at)::int AS hour, COUNT(*) AS count
       FROM emails
       WHERE mailbox_owner_id = ANY($1::int[]) AND received_at >= $2 AND received_at < $3::date + interval '1 day'
       GROUP BY 1, 2`,
      currentPeriodParams
    ),
    // SLA response rate: among severity-tagged emails that got a matched reply
    // (same thread-gap technique as avgFirstResponseHours above), what fraction
    // replied within their tier's SLA_HOURS target. Emails with no severity
    // (pre-migration) or no matched reply are excluded from this rate, same
    // limitation avgFirstResponseHours already has.
    pool.query(
      // Real bug fixed 2026-09-05 (found while chasing a coordinator showing
      // an implausible ~0-minute average reply time): this thread_gaps, unlike
      // the KPI/trend versions above, never checked that e1 was genuinely
      // incoming and e2 genuinely outgoing — it matched ANY two same-subject
      // messages in order, so two customer messages in a row (or two Sariah
      // replies in a row) could get counted as a "response," including
      // near-instant gaps between messages that were never actually a
      // customer-to-Sariah exchange at all.
      `WITH base AS (
         SELECT e.id, e.received_at, e.severity, e.from_email, p.email AS mailbox_email,
                LOWER(REGEXP_REPLACE(e.subject, '^\\s*(re|fw|fwd)\\s*:\\s*', '', 'gi')) AS base_subject,
                CASE WHEN e.received_at >= $2 AND e.received_at < $3::date + interval '1 day' THEN 'current'
                     WHEN e.received_at >= $4 AND e.received_at < $5::date + interval '1 day' THEN 'previous'
                END AS period
         FROM emails e
         JOIN people p ON p.id = e.mailbox_owner_id
         WHERE e.mailbox_owner_id = ANY($1::int[])
           AND e.received_at >= $4 AND e.received_at < $3::date + interval '1 day'
       ),
       thread_gaps AS (
         SELECT e1.id, e1.period, e1.severity,
                EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
         FROM base e1 JOIN base e2 ON
           e2.base_subject = e1.base_subject AND e2.received_at > e1.received_at AND e2.received_at < e1.received_at + interval '14 days'
           AND SPLIT_PART(e2.from_email, '@', 2) = SPLIT_PART(e2.mailbox_email, '@', 2)
         WHERE e1.period IS NOT NULL AND e1.severity IS NOT NULL
           AND SPLIT_PART(e1.from_email, '@', 2) != SPLIT_PART(e1.mailbox_email, '@', 2)
         GROUP BY e1.id, e1.period, e1.severity, e1.received_at
       )
       SELECT period, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE gap_hours <= ${SLA_CASE}) AS met
       FROM thread_gaps GROUP BY period`,
      params
    ),
    // Average resolution time (minutes) for escalations in the current period,
    // same thread-gap technique, just scoped to isEscalation and in minutes
    // rather than hours for the wireframe's "14-minute average resolution" style.
    // Same incoming/outgoing direction fix as above applied here too.
    pool.query(
      `WITH base AS (
         SELECT e.id, e.received_at, e.from_email, p.email AS mailbox_email,
                (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
                LOWER(REGEXP_REPLACE(e.subject, '^\\s*(re|fw|fwd)\\s*:\\s*', '', 'gi')) AS base_subject
         FROM emails e
         JOIN people p ON p.id = e.mailbox_owner_id
         WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.received_at >= $2 AND e.received_at < $3::date + interval '1 day'
       ),
       thread_gaps AS (
         SELECT e1.id, EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 60 AS gap_minutes
         FROM base e1 JOIN base e2 ON
           e2.base_subject = e1.base_subject AND e2.received_at > e1.received_at AND e2.received_at < e1.received_at + interval '14 days'
           AND SPLIT_PART(e2.from_email, '@', 2) = SPLIT_PART(e2.mailbox_email, '@', 2)
         WHERE e1.is_escalation AND SPLIT_PART(e1.from_email, '@', 2) != SPLIT_PART(e1.mailbox_email, '@', 2)
         GROUP BY e1.id, e1.received_at
       )
       SELECT ROUND(AVG(gap_minutes)) AS avg_minutes FROM thread_gaps`,
      currentPeriodParams
    ),
  ]);

  const k = kpiRes.rows[0];
  const respByPeriod = Object.fromEntries(respRes.rows.map((r) => [r.period, r.avg_hours ? Number(r.avg_hours) : null]));
  const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

  const slaByPeriod = Object.fromEntries(slaRes.rows.map((r) => [
    r.period, Number(r.total) > 0 ? Math.round((Number(r.met) / Number(r.total)) * 1000) / 10 : null,
  ]));

  res.json({
    kpis: {
      emailsProcessed: { value: Number(k.current_total), deltaPct: pct(Number(k.current_total), Number(k.prev_total)) },
      avgFirstResponseHours: { value: respByPeriod.current, deltaPct: pct(respByPeriod.current, respByPeriod.previous) },
      // Per-MESSAGE, deliberately — current_total is now thread-deduped
      // (see kpiRes query comment), which would badly mismatch against
      // current_classified (a raw per-message count) if used here instead.
      classificationCoverage: {
        value: k.current_total_msgs > 0 ? Math.round((k.current_classified / k.current_total_msgs) * 1000) / 10 : null,
        deltaPct: null,
        unclassifiedCount: Number(k.current_total_msgs) - Number(k.current_classified),
      },
      openBacklog: { value: Number(k.current_backlog), deltaPct: pct(Number(k.current_backlog), Number(k.prev_backlog)) },
      aiConfidence: {
        value: k.current_confidence != null ? Number(k.current_confidence) : null,
        deltaPct: pct(Number(k.current_confidence), Number(k.prev_confidence)),
      },
      slaResponseRate: {
        value: slaByPeriod.current,
        deltaPct: pct(slaByPeriod.current, slaByPeriod.previous),
      },
      escalationAvgResolutionMinutes: {
        value: escResRes.rows[0]?.avg_minutes != null ? Number(escResRes.rows[0].avg_minutes) : null,
      },
    },
    volumeByDay: volumeRes.rows.map((r) => ({
      day: r.day, critical: Number(r.critical), high: Number(r.high), medium: Number(r.medium), low: Number(r.low),
    })),
    topSenders: sendersRes.rows.map((r) => ({
      fromEmail: r.from_email, fromName: r.from_name, total: Number(r.total), dominantCategory: r.dominant_category,
    })),
    responseTrend: trendRes.rows.map((r) => ({ week: r.week, avgHours: r.avg_hours ? Number(r.avg_hours) : null })),
    heatmap: heatmapRes.rows.map((r) => ({ dow: r.dow, hour: r.hour, count: Number(r.count) })),
  });
 } catch (err) {
  console.error("[analytics] failed:", err.message);
  res.status(500).json({ error: "Could not compute analytics" });
 }
});

router.get("/escalations", async (req, res) => {
  const directOnly = req.query.direct === "true";
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params);

  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
              e.to_recipients, e.cc_recipients, e.conversation_id, e.internet_message_id,
              e.is_direct_to_owner, e.is_critical, e.summary, e.actioned_at,
              d.name AS department, p.display_name AS attributed_to,
              e.handled_by_name, e.handled_by_role,
              e.classification_raw, e.severity, e.confidence,
              mb.email AS mailbox_email, mb.is_shared_inbox,
              CASE WHEN e.severity IS NOT NULL AND e.urgency = 'action_needed' THEN e.received_at + (${SLA_CASE}) * interval '1 hour' END AS sla_deadline,
              CASE WHEN mb.is_shared_inbox
                THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
                ELSE e.actioned_at IS NOT NULL
              END AS sla_met
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN people p ON p.id = e.attributed_person_id
       LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
       WHERE e.mailbox_owner_id = ANY($1::int[])
         AND (e.classification_raw->>'isEscalation')::boolean = true
         ${directOnly ? "AND e.is_direct_to_owner = true" : ""}
         ${range}
     ),
     ${THREAD_DEDUP_CTE}
     SELECT *, (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count
     FROM deduped
     WHERE thread_rn = 1
     ORDER BY is_critical DESC, received_at DESC
     LIMIT 5000`,
    params
  );

  res.json({ escalations: rows });
});

router.get("/action-needed", async (req, res) => {
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params);

  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
              e.to_recipients, e.cc_recipients, e.conversation_id, e.internet_message_id,
              e.is_direct_to_owner, e.is_critical, e.summary, e.actioned_at,
              d.name AS department, p.display_name AS attributed_to,
              e.handled_by_name, e.handled_by_role, e.severity, e.confidence,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              mb.email AS mailbox_email, mb.is_shared_inbox,
              pr.id AS property_id, pr.property_no, pr.ubs AS property_ubs, pr.site_name AS property_site_name, pr.customer_name AS property_customer,
              e.customer_name_hint,
              CASE WHEN e.severity IS NOT NULL AND e.urgency = 'action_needed' THEN e.received_at + (${SLA_CASE}) * interval '1 hour' END AS sla_deadline,
              CASE WHEN mb.is_shared_inbox
                THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
                ELSE e.actioned_at IS NOT NULL
              END AS sla_met
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN people p ON p.id = e.attributed_person_id
       LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
       LEFT JOIN properties pr ON pr.id = e.property_id
       WHERE e.mailbox_owner_id = ANY($1::int[])
         AND e.urgency = 'action_needed'
         AND e.is_direct_to_owner = true
         ${range}
     ),
     ${THREAD_DEDUP_CTE}
     SELECT *, (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count
     FROM deduped
     WHERE thread_rn = 1
     ORDER BY is_critical DESC, received_at DESC
     LIMIT 5000`,
    params
  );

  res.json({ emails: rows });
});

router.post("/emails/:id/reply", async (req, res) => {
  const { text, replyAll = false, cc = [] } = req.body;

  if (!text?.trim()) return res.status(400).json({ error: "Reply text is required" });

  const { rows } = await pool.query(
    `SELECT e.subject, e.from_email, e.from_name, e.to_recipients, e.cc_recipients,
            e.mailbox_owner_id, p.is_shared_inbox, p.email AS mailbox_email
     FROM emails e
     JOIN people p ON p.id = e.mailbox_owner_id
     WHERE e.id = $1 AND e.mailbox_owner_id = ANY($2::int[])`,
    [req.params.id, req.visibleMailboxIds]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const { subject, from_email, from_name, to_recipients, cc_recipients, is_shared_inbox, mailbox_email } = rows[0];

  // Always sent from the LOGGED-IN dashboard user's own mailbox — never "as"
  // the mailbox the email arrived in. This is a fresh compose+send (not an
  // in-thread Graph/Zoho reply on the original message), specifically so it
  // never needs Send-As on a shared inbox — those stay read-only exactly as
  // the client agreement requires (see AGENTS.md); this only ever uses the
  // Mail.Send scope the logged-in person already granted for their own
  // account when they logged in.
  const { personId } = req.session;
  const { rows: personRows } = await pool.query(
    `SELECT email, zoho_account_id FROM people WHERE id = $1`, [personId]
  );
  if (!personRows.length) return res.status(400).json({ error: "Could not resolve your own mailbox" });
  const { email: selfEmail, zoho_account_id: selfZohoAccountId } = personRows[0];

  const splitAddrs = (str) => (str || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const selfLower = (selfEmail || "").toLowerCase();
  const senderLower = (from_email || "").toLowerCase();

  const to = [from_email];
  const ccSet = new Set(cc.map((a) => a.toLowerCase()));
  if (replyAll) {
    for (const addr of [...splitAddrs(to_recipients), ...splitAddrs(cc_recipients)]) {
      if (addr !== senderLower && addr !== selfLower) ccSet.add(addr);
    }
  }
  // Keep the shared inbox's own thread history intact — it's still the
  // record of this conversation as far as that mailbox's other viewers are
  // concerned, even though the reply itself is sent as you, not as it.
  if (is_shared_inbox && mailbox_email) ccSet.add(mailbox_email.toLowerCase());
  ccSet.delete(selfLower);
  const ccList = [...ccSet];

  const replySubject = /^re:/i.test(subject || "") ? subject : `Re: ${subject || "(no subject)"}`;
  const quotedSubject = escapeHtml(subject || "(no subject)");
  const bodyHtml = `<div>${escapeHtml(text.trim()).replace(/\n/g, "<br>")}</div>
<p style="color:#888;font-size:12px;margin-top:16px;">Replying via Watmach Beacon to ${escapeHtml(from_name || from_email)}'s message, "${quotedSubject}".</p>`;

  const providerRow = await pool.query(
    `SELECT provider FROM oauth_tokens WHERE person_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [personId]
  );
  const provider = providerRow.rows[0]?.provider || "microsoft";

  if (provider === "zoho") {
    if (!selfZohoAccountId) return res.status(400).json({ error: "Your Zoho account isn't fully connected — reconnect and try again." });
    const accessToken = await getZohoToken(personId);
    await zohoSendNewMail(accessToken, selfZohoAccountId, {
      fromAddress: selfEmail, to, cc: ccList, subject: replySubject, text: text.trim(),
    });
  } else {
    const accessToken = await getMsToken(personId);
    await graphSendNewMail(accessToken, { to, cc: ccList, subject: replySubject, bodyHtml });
  }

  await pool.query(`UPDATE emails SET actioned_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// ── Thread summary (on-demand, cached) ────────────────────────────────────────
router.get("/emails/:id/thread-summary", async (req, res) => {
  console.log(`[thread-summary] email=${req.params.id}`);

  const { rows } = await pool.query(
    `SELECT graph_message_id, mail_provider, thread_summary, body_preview, zoho_folder_id, mailbox_owner_id
     FROM emails WHERE id = $1 AND mailbox_owner_id = ANY($2::int[])`,
    [req.params.id, req.visibleMailboxIds]
  );
  if (!rows.length) {
    console.log(`[thread-summary] email ${req.params.id} not visible to this session`);
    return res.status(404).json({ error: "Not found" });
  }

  // Clear cache if refresh requested
  if (req.query.refresh === "true") {
    await pool.query(`UPDATE emails SET thread_summary = NULL WHERE id = $1`, [req.params.id]);
  } else if (rows[0].thread_summary) {
    // Cached value may be the old bare-array shape (pre-narrative) or the
    // current {entries, narrative} object — normalize either way.
    const cached = rows[0].thread_summary;
    return res.json(Array.isArray(cached) ? { entries: cached, narrative: null } : cached);
  }

  // Fetch full body from the right provider, using the MAILBOX'S OWN access
  // (not the viewer's) — required once an admin can view a delegated/shared inbox.
  const { graph_message_id, mail_provider, body_preview, zoho_folder_id, mailbox_owner_id } = rows[0];
  let fullBody = body_preview || "";
  console.log(`[thread-summary] fetching full body provider=${mail_provider} bodyLen=${fullBody.length} folderId=${zoho_folder_id}`);

  try {
    if (mail_provider === "zoho") {
      const ownerRow = await pool.query(`SELECT zoho_account_id FROM people WHERE id = $1`, [mailbox_owner_id]);
      const accountId = ownerRow.rows[0]?.zoho_account_id;
      if (accountId) {
        const token = await getZohoToken(mailbox_owner_id);
        // Use folder-based URL (required by Zoho API)
        // If folderId not stored, fetch the message list to find it
        let folderId = zoho_folder_id;
        if (!folderId) {
          const listR = await axios.get(
            `https://mail.zoho.com/api/accounts/${accountId}/messages/view?limit=200`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
          );
          const found = (listR.data?.data || []).find(m => m.messageId === graph_message_id);
          folderId = found?.folderId || null;
          if (folderId) {
            await pool.query(`UPDATE emails SET zoho_folder_id = $1 WHERE id = $2`, [folderId, req.params.id]);
          }
        }
        if (folderId) {
          const r = await axios.get(
            `https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${graph_message_id}/content`,
            { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
          );
          fullBody = r.data?.data?.content || fullBody;
        }
      }
    } else {
      const { accessToken, mailboxTarget } = await resolveMailboxAccess(mailbox_owner_id);
      const r = await axios.get(
        `${graphBaseFor(mailboxTarget)}/messages/${graph_message_id}?$select=body`,
        { headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' } }
      );
      fullBody = r.data?.body?.content || fullBody;
    }
  } catch (e) {
    console.log(`[thread-summary] body fetch failed, using stored preview: ${e.message}`);
  }

  // Strip HTML — remove block content first, then tags, then decode entities
  const cleanBody = fullBody
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#\d+;/g, " ")
    .replace(/\s{3,}/g, "\n")
    .trim();

  const prompt = `You are analysing an email thread (newest message at top, older replies quoted below).
Extract each distinct message in CHRONOLOGICAL ORDER (oldest first).
For each message return: date (from the text, e.g. "25 Jun 2026"), from (sender name or email as written), summary (one sentence).
Then write a separate flowing narrative (2-4 sentences) synthesizing the whole thread's progression — what happened first, what followed, and where things currently stand — as one connected story rather than a list.

STRICT RULES — violations are worse than returning fewer entries:
- ONLY include messages explicitly present in the text below. Do NOT invent any.
- Do NOT use placeholder names like "John Doe", "Jane Smith", or any name not in the text.
- If you cannot find a clear sender name, use their email address.
- Ignore signatures, legal disclaimers, and quoted text that repeats earlier messages.
- If only one distinct message exists, "entries" should have one item and "narrative" should just describe that one message.
- When uncertain whether a message boundary exists, skip it.
Return ONLY valid JSON, no markdown, in this exact shape:
{"entries":[{"date":"...","from":"...","summary":"..."}],"narrative":"..."}

Email thread:
${cleanBody.slice(0, 8000)}`;

  let entries = [];
  let narrative = null;
  try {
    const raw = await callLLM(prompt, { maxTokens: 1000 });
    console.log(`[thread-summary] LLM raw (first 300): ${raw.slice(0, 300)}`);

    // Guard: LLM echoed back HTML from the email body
    if (raw.trimStart().startsWith("<")) {
      console.error("[thread-summary] LLM returned HTML instead of JSON — body likely not cleaned properly");
      return res.status(500).json({ error: "Could not parse thread — try again" });
    }

    const parsed = extractJson(raw);
    entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    narrative = typeof parsed?.narrative === "string" ? parsed.narrative : null;
  } catch (e) {
    console.error(`[thread-summary] LLM/parse error: ${e.message}`);
    return res.status(500).json({ error: "LLM failed to parse thread", detail: e.message });
  }

  console.log(`[thread-summary] extracted ${entries.length} entries, narrative=${narrative ? "yes" : "no"}`);

  // Cache even empty results to avoid re-running LLM for emails with single messages
  if (entries.length > 0) {
    await pool.query(`UPDATE emails SET thread_summary = $1 WHERE id = $2`, [JSON.stringify({ entries, narrative }), req.params.id]);
  }

  res.json({ entries, narrative });
});

// ── Thread status + coordinator action log (on-demand, cached) ────────────────
router.get("/emails/:id/thread-context", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT mailbox_owner_id, conversation_id FROM emails
     WHERE id = $1 AND mailbox_owner_id = ANY($2::int[])`,
    [req.params.id, req.visibleMailboxIds]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const { mailbox_owner_id, conversation_id } = rows[0];
  if (!conversation_id) return res.status(404).json({ error: "No conversation thread for this email" });

  try {
    const result = await getOrGenerateThreadSummary(mailbox_owner_id, conversation_id, {
      refresh: req.query.refresh === "true",
    });
    res.json(result);
  } catch (e) {
    console.error(`[thread-context] failed for email ${req.params.id}:`, e.message);
    res.status(500).json({ error: "Could not build thread context", detail: e.message });
  }
});

// Threads in a shared inbox that genuinely need action (action_needed /
// escalation / high-or-critical severity, from a real incoming sender) but
// have NO coordinator-attributed reply anywhere in the thread — not "nobody
// has replied in N hours" (thread-gap matching by subject is fragile, see
// AGENTS.md), but "none of the known coordinators have ever touched this,
// full stop," grouped by Graph's own conversation_id (confirmed reliable —
// zero nulls, cleanly groups real multi-message threads).
router.get("/unattended", async (req, res) => {
  const ids = req.visibleMailboxIds;
  const params = [ids];
  const range = dateRangeFilter(req, params);
  const { rows } = await pool.query(
    `WITH thread_incoming_flags AS (
       SELECT e.id, e.conversation_id, e.mailbox_owner_id, e.severity, e.received_at, e.subject, e.internet_message_id,
              e.from_name, e.from_email, e.to_recipients, e.cc_recipients, e.summary, e.urgency, e.is_critical,
              e.actioned_at, e.handled_by_name, e.handled_by_role, e.confidence, e.is_direct_to_owner,
              d.name AS department,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              pr.id AS property_id, pr.property_no, pr.ubs AS property_ubs, pr.site_name AS property_site_name, pr.customer_name AS property_customer, e.customer_name_hint,
              ROW_NUMBER() OVER (PARTITION BY e.conversation_id ORDER BY e.received_at DESC) AS rn
       FROM emails e
       JOIN people p ON p.id = e.mailbox_owner_id
       LEFT JOIN properties pr ON pr.id = e.property_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE p.is_shared_inbox = true AND e.mailbox_owner_id = ANY($1::int[])
         AND e.from_email != p.email
         AND (e.urgency = 'action_needed' OR (e.classification_raw->>'isEscalation')::boolean OR e.severity IN ('critical','high'))
         ${range}
     ),
     latest_incoming AS (SELECT * FROM thread_incoming_flags WHERE rn = 1),
     -- Any outgoing message from the mailbox's own address counts as "replied
     -- to", regardless of whether matchRoster/extractHandler could pin down
     -- WHICH coordinator sent it (many real replies carry no text signature
     -- at all -- pure-image signoffs -- so handled_by_name alone
     -- under-counts real responses; see BEACON_BACKLOG.md-adjacent note in
     -- signatureParser.js).
     thread_replies AS (
       SELECT DISTINCT e.conversation_id
       FROM emails e
       JOIN people p ON p.id = e.mailbox_owner_id
       WHERE SPLIT_PART(e.from_email, '@', 2) = SPLIT_PART(p.email, '@', 2)
     ),
     unreplied AS (
       SELECT li.*, p.email AS mailbox_email, p.is_shared_inbox
       FROM latest_incoming li
       JOIN people p ON p.id = li.mailbox_owner_id
       WHERE li.conversation_id NOT IN (SELECT conversation_id FROM thread_replies)
     ),
     -- Same physical email cc'd to two shared inboxes gets a different
     -- conversation_id in each (Graph scopes it per-mailbox), so two
     -- otherwise-independent "latest incoming" rows above can be the exact
     -- same message — collapse those via internetMessageId (verified stable
     -- across mailbox copies), same dedup key as the list routes.
     deduped AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY COALESCE(internet_message_id, 'thread-' || conversation_id)
         ORDER BY received_at DESC
       ) AS cross_rn
       FROM unreplied
     )
     -- Was LIMIT 100 — this route is now the full Unassigned tab (grouped
     -- into property/client boxes on the frontend), not a small Overview
     -- preview, so capping at 100 silently truncated the list while the
     -- attention-summary badge (a real, uncapped COUNT) kept showing the
     -- true total — real bug: badge said 890, the list (and therefore every
     -- group built from it) could only ever show 100.
     --
     -- Same column shape as /emails, /action-needed etc. now (id, from_name,
     -- to_recipients, summary, actioned_at, ...) instead of a stripped-down
     -- thread summary — needed so the frontend can render these rows through
     -- the exact same clickable/expandable <Row> as every other Inbox tab.
     -- Real bug this fixes: the old lightweight shape had no id column and no
     -- body/reply fields at all, so Unassigned rows were never clickable —
     -- there was nothing for a click handler to open.
     SELECT *,
            (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count,
            CASE WHEN severity IS NOT NULL AND urgency = 'action_needed' THEN received_at + (${SLA_CASE}) * interval '1 hour' END AS sla_deadline,
            false AS sla_met -- every row here is, by this route's own definition, unreplied
     FROM deduped
     WHERE cross_rn = 1
     ORDER BY received_at DESC
     LIMIT 2000`,
    params
  );
  res.json({ unattended: rows });
});

// Four headline counts for the Overview "Needs Attention" panel — a single
// lightweight bundle rather than four separate round trips.
// The three "Needs Attention" categories that previously only had a COUNT
// (via /attention-summary) — full row lists, in the merged Inbox's
// sub-tabs, same shape/columns as /emails so they render through the same
// EmailTable component.
router.get("/sla-breaches", async (req, res) => {
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params);
  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
              e.to_recipients, e.cc_recipients, e.conversation_id, e.internet_message_id,
              e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
              d.name AS department, p.display_name AS attributed_to,
              e.handled_by_name, e.handled_by_role, e.severity, e.confidence,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              mb.email AS mailbox_email, mb.is_shared_inbox,
              pr.id AS property_id, pr.property_no, pr.ubs AS property_ubs, pr.site_name AS property_site_name, pr.customer_name AS property_customer,
              e.customer_name_hint,
              e.received_at + (${SLA_CASE}) * interval '1 hour' AS sla_deadline,
              CASE WHEN mb.is_shared_inbox
                THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
                ELSE e.actioned_at IS NOT NULL
              END AS sla_met
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN people p ON p.id = e.attributed_person_id
       LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
       LEFT JOIN properties pr ON pr.id = e.property_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.severity IS NOT NULL
         -- FYI-classified mail was never meant to need a reply at all, so it
         -- shouldn't be held to a response deadline — real bug found via
         -- direct query: 518 of 2225 "breach" rows were FYI, not
         -- action_needed, inflating this count with mail nobody was
         -- ever going to (or should) reply to.
         AND e.urgency = 'action_needed'
         AND e.received_at + (${SLA_CASE}) * interval '1 hour' < now()
         AND NOT (CASE WHEN mb.is_shared_inbox
           THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
           ELSE e.actioned_at IS NOT NULL END)
         ${range}
     ),
     ${THREAD_DEDUP_CTE}
     SELECT *, (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count
     FROM deduped WHERE thread_rn = 1
     ORDER BY sla_deadline ASC
     LIMIT 5000`,
    params
  );
  res.json({ emails: rows });
});

router.get("/critical-escalations", async (req, res) => {
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params);
  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
              e.to_recipients, e.cc_recipients, e.conversation_id, e.internet_message_id,
              e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
              d.name AS department, p.display_name AS attributed_to,
              e.handled_by_name, e.handled_by_role, e.severity, e.confidence,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              mb.email AS mailbox_email, mb.is_shared_inbox,
              pr.id AS property_id, pr.property_no, pr.ubs AS property_ubs, pr.site_name AS property_site_name, pr.customer_name AS property_customer,
              e.customer_name_hint,
              CASE WHEN e.severity IS NOT NULL AND e.urgency = 'action_needed' THEN e.received_at + (${SLA_CASE}) * interval '1 hour' END AS sla_deadline,
              CASE WHEN mb.is_shared_inbox
                THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
                ELSE e.actioned_at IS NOT NULL
              END AS sla_met
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN people p ON p.id = e.attributed_person_id
       LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
       LEFT JOIN properties pr ON pr.id = e.property_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.severity = 'critical'
         AND (e.classification_raw->>'isEscalation')::boolean = true AND e.actioned_at IS NULL
         ${range}
     ),
     ${THREAD_DEDUP_CTE}
     SELECT *, (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count
     FROM deduped WHERE thread_rn = 1
     ORDER BY received_at DESC
     LIMIT 5000`,
    params
  );
  res.json({ emails: rows });
});

router.get("/needs-review", async (req, res) => {
  const params = [req.visibleMailboxIds];
  const range = dateRangeFilter(req, params);
  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
              e.to_recipients, e.cc_recipients, e.conversation_id, e.internet_message_id,
              e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
              d.name AS department, p.display_name AS attributed_to,
              e.handled_by_name, e.handled_by_role, e.severity, e.confidence,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              mb.email AS mailbox_email, mb.is_shared_inbox,
              pr.id AS property_id, pr.property_no, pr.ubs AS property_ubs, pr.site_name AS property_site_name, pr.customer_name AS property_customer,
              e.customer_name_hint,
              CASE WHEN e.severity IS NOT NULL AND e.urgency = 'action_needed' THEN e.received_at + (${SLA_CASE}) * interval '1 hour' END AS sla_deadline,
              CASE WHEN mb.is_shared_inbox
                THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
                ELSE e.actioned_at IS NOT NULL
              END AS sla_met
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN people p ON p.id = e.attributed_person_id
       LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
       LEFT JOIN properties pr ON pr.id = e.property_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.classified_at IS NOT NULL AND e.confidence < 70
         ${range}
     ),
     ${THREAD_DEDUP_CTE}
     SELECT *, (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count
     FROM deduped WHERE thread_rn = 1
     ORDER BY confidence ASC
     LIMIT 5000`,
    params
  );
  res.json({ emails: rows });
});

router.get("/attention-summary", async (req, res) => {
  const ids = req.visibleMailboxIds;
  // Each subquery needs its OWN params array — dateRangeFilter numbers
  // placeholders off however long the array it's given already is, so
  // sharing one array across 4 independent queries would misnumber all but
  // the first.
  const slaParams = [ids], slaRange = dateRangeFilter(req, slaParams);
  const unassignedParams = [ids], unassignedRange = dateRangeFilter(req, unassignedParams);
  const criticalParams = [ids], criticalRange = dateRangeFilter(req, criticalParams);
  const reviewParams = [ids], reviewRange = dateRangeFilter(req, reviewParams);

  const [slaRes, unassignedRes, criticalRes, reviewRes] = await Promise.all([
    // SLA breaches: severity-tagged, not yet met, past their deadline —
    // thread-deduped to match what GET /sla-breaches actually lists.
    pool.query(
      `WITH filtered AS (
         SELECT e.id, e.received_at, e.conversation_id, e.internet_message_id
         FROM emails e
         LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
         WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.severity IS NOT NULL
           AND e.urgency = 'action_needed'
           AND e.received_at + (${SLA_CASE}) * interval '1 hour' < now()
           AND NOT (CASE WHEN mb.is_shared_inbox
             THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
             ELSE e.actioned_at IS NOT NULL END)
           ${slaRange}
       ),
       ${THREAD_DEDUP_CTE}
       SELECT COUNT(*) AS count FROM deduped WHERE thread_rn = 1`,
      slaParams
    ),
    // Same underlying concept as GET /unattended, just a count — including
    // the same cross-mailbox internetMessageId dedup (a message cc'd to two
    // shared inboxes gets a different conversation_id in each, so it would
    // otherwise be double-counted as two separate unassigned threads).
    pool.query(
      `WITH thread_incoming_flags AS (
         SELECT e.conversation_id, e.internet_message_id, e.received_at,
                ROW_NUMBER() OVER (PARTITION BY e.conversation_id ORDER BY e.received_at DESC) AS rn
         FROM emails e
         JOIN people p ON p.id = e.mailbox_owner_id
         WHERE p.is_shared_inbox = true AND e.mailbox_owner_id = ANY($1::int[])
           AND e.from_email != p.email
           AND (e.urgency = 'action_needed' OR (e.classification_raw->>'isEscalation')::boolean OR e.severity IN ('critical','high'))
           ${unassignedRange}
       ),
       latest_incoming AS (SELECT * FROM thread_incoming_flags WHERE rn = 1),
       thread_replies AS (
         SELECT DISTINCT e.conversation_id
         FROM emails e
         JOIN people p ON p.id = e.mailbox_owner_id
         WHERE SPLIT_PART(e.from_email, '@', 2) = SPLIT_PART(p.email, '@', 2)
       ),
       unreplied AS (
         SELECT * FROM latest_incoming li
         WHERE li.conversation_id NOT IN (SELECT conversation_id FROM thread_replies)
       ),
       deduped AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY COALESCE(internet_message_id, 'thread-' || conversation_id)
           ORDER BY received_at DESC
         ) AS cross_rn
         FROM unreplied
       )
       SELECT COUNT(*) AS count FROM deduped WHERE cross_rn = 1`,
      unassignedParams
    ),
    // Counts distinct threads, matching what GET /critical-escalations
    // actually lists (a critical escalation thread can have several
    // messages, or the exact-same message cc'd to two mailboxes).
    pool.query(
      `WITH filtered AS (
         SELECT e.id, e.received_at, e.conversation_id, e.internet_message_id
         FROM emails e
         WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.severity = 'critical'
           AND (e.classification_raw->>'isEscalation')::boolean = true AND e.actioned_at IS NULL
           ${criticalRange}
       ),
       ${THREAD_DEDUP_CTE}
       SELECT COUNT(*) AS count FROM deduped WHERE thread_rn = 1`,
      criticalParams
    ),
    // Same dedup for GET /needs-review's count.
    pool.query(
      `WITH filtered AS (
         SELECT e.id, e.received_at, e.conversation_id, e.internet_message_id
         FROM emails e
         WHERE e.mailbox_owner_id = ANY($1::int[]) AND e.classified_at IS NOT NULL AND e.confidence < 70
           ${reviewRange}
       ),
       ${THREAD_DEDUP_CTE}
       SELECT COUNT(*) AS count FROM deduped WHERE thread_rn = 1`,
      reviewParams
    ),
  ]);

  res.json({
    slaBreaches: Number(slaRes.rows[0].count),
    unassigned: Number(unassignedRes.rows[0].count),
    criticalEscalations: Number(criticalRes.rows[0].count),
    needsReview: Number(reviewRes.rows[0].count),
  });
});

// Counts by thread_summaries.status (pending/ongoing/escalated/resolved/
// reopened) — see services/threadTracking.js. That table is populated
// lazily, one row per thread, only once someone actually opens that
// thread's summary in the UI (or a backfill script runs it explicitly) —
// so this count reflects however many threads have been analyzed so far,
// not necessarily every thread in the date range. `analyzed`/`totalThreads`
// are both returned so the frontend can show coverage honestly rather than
// implying these counts are complete.
router.get("/thread-status-summary", async (req, res) => {
  const ids = req.visibleMailboxIds;
  const statusParams = [ids];
  const statusRange = dateRangeFilter(req, statusParams, "last_received_at");
  const totalParams = [ids];
  const totalRange = dateRangeFilter(req, totalParams, "received_at");

  const [statusRes, totalRes] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*) AS count FROM thread_summaries
       WHERE mailbox_owner_id = ANY($1::int[]) AND status IS NOT NULL ${statusRange}
       GROUP BY status`,
      statusParams
    ),
    pool.query(
      `SELECT COUNT(DISTINCT conversation_id) AS count FROM emails
       WHERE mailbox_owner_id = ANY($1::int[]) ${totalRange}`,
      totalParams
    ),
  ]);

  const byStatus = { pending: 0, ongoing: 0, escalated: 0, resolved: 0, reopened: 0 };
  let analyzed = 0;
  for (const row of statusRes.rows) {
    byStatus[row.status] = Number(row.count);
    analyzed += Number(row.count);
  }

  res.json({ byStatus, analyzed, totalThreads: Number(totalRes.rows[0].count) });
});

// Day-by-day status counts from thread_status_daily — one snapshot per
// (thread, day), taken at ingest time from whatever status was already
// cached that day (see ingest.js). Sparse by construction: only threads
// that have ever had a thread_summaries row get a snapshot, and only on
// days they received new mail — this fills in and gets more useful over
// time/backfills, it isn't a complete historical record from day one.
router.get("/thread-status-trend", async (req, res) => {
  const ids = req.visibleMailboxIds;
  const params = [ids];
  const range = dateRangeFilter(req, params, "day");
  const { rows } = await pool.query(
    `SELECT day, status, COUNT(*) AS count
     FROM thread_status_daily
     WHERE mailbox_owner_id = ANY($1::int[]) ${range}
     GROUP BY day, status
     ORDER BY day`,
    params
  );

  const byDay = new Map();
  for (const row of rows) {
    const key = row.day.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { day: key, pending: 0, ongoing: 0, escalated: 0, resolved: 0, reopened: 0 });
    byDay.get(key)[row.status] = Number(row.count);
  }

  res.json({ days: Array.from(byDay.values()) });
});

router.post("/emails/:id/action", async (req, res) => {
  const { id } = req.params;

  const { rows } = await pool.query(
    `SELECT actioned_at FROM emails WHERE id = $1 AND mailbox_owner_id = ANY($2::int[])`,
    [id, req.visibleMailboxIds]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const newValue = rows[0].actioned_at ? null : new Date();
  await pool.query(
    `UPDATE emails SET actioned_at = $1 WHERE id = $2`,
    [newValue, id]
  );

  res.json({ actioned: !!newValue, actioned_at: newValue });
});

// Full department list for this client — the correction form needs every
// option, not just the ones visible in whatever list happens to be loaded
// (EmailTable.jsx's own department filter derives names from currently-
// loaded rows, which can miss a department with zero emails in view).
router.get("/departments", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name FROM departments WHERE client_id = $1 ORDER BY name`,
    [req.clientId]
  );
  res.json({ departments: rows });
});

// ── Classification correction / feedback ──────────────────────────────────────
// A human catching a wrong AI classification. Two things happen: (1) this
// email's own row is corrected immediately, independent of anything else;
// (2) the ORIGINAL email content (what the model actually saw) is embedded
// and stored alongside the correction, so a future similar email can
// retrieve it as a grounding example (see classifier.js's
// getFeedbackGrounding). This is retrieval, not literal reinforcement
// learning — Gemini's weights aren't ours to retrain over an API — but it's
// the honest version of "the system gets better from feedback" available
// with a third-party model.
router.post("/emails/:id/feedback", async (req, res) => {
  const { department, urgency, severity, isCritical, isEscalation, comment } = req.body;
  const { id } = req.params;

  const { rows } = await pool.query(
    `SELECT e.subject, e.body_preview, e.department_id, e.urgency, e.severity,
            e.is_critical, e.classification_raw, d.name AS department_name
     FROM emails e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.id = $1 AND e.mailbox_owner_id = ANY($2::int[])`,
    [id, req.visibleMailboxIds]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const email = rows[0];

  const originalClassification = {
    department: email.department_name,
    urgency: email.urgency,
    severity: email.severity,
    isCritical: email.is_critical,
    isEscalation: email.classification_raw?.isEscalation ?? null,
  };

  let departmentId = email.department_id;
  if (department && department !== email.department_name) {
    const deptRow = await pool.query(
      `SELECT id FROM departments WHERE client_id = $1 AND name = $2`,
      [req.clientId, department]
    );
    if (deptRow.rows.length) departmentId = deptRow.rows[0].id;
  }

  const finalUrgency = urgency || email.urgency;
  const finalSeverity = severity || email.severity;
  const finalIsCritical = typeof isCritical === "boolean" ? isCritical : email.is_critical;
  const finalIsEscalation = typeof isEscalation === "boolean" ? isEscalation : (email.classification_raw?.isEscalation ?? false);

  // Applied right away — this email is fixed regardless of whether the
  // embedding step below succeeds.
  await pool.query(
    `UPDATE emails SET
       department_id = $1, urgency = $2, severity = $3, is_critical = $4,
       classification_raw = COALESCE(classification_raw, '{}'::jsonb) || $5::jsonb
     WHERE id = $6`,
    [
      departmentId, finalUrgency, finalSeverity, finalIsCritical,
      JSON.stringify({ isEscalation: finalIsEscalation, correctedByFeedback: true }),
      id,
    ]
  );

  let embeddingLiteral = null;
  try {
    const text = `${email.subject || ""}\n${email.body_preview || ""}`.slice(0, 4000);
    if (text.trim()) embeddingLiteral = toVectorLiteral(await embedText(text));
  } catch (err) {
    console.error("[feedback] embedding failed (correction still saved):", err.message);
  }

  await pool.query(
    `INSERT INTO classification_feedback (
       email_id, corrected_by_person_id, original_classification,
       corrected_department_id, corrected_urgency, corrected_severity,
       corrected_is_critical, corrected_is_escalation, comment, embedding
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${embeddingLiteral ? "$10::vector" : "NULL"})`,
    embeddingLiteral
      ? [id, req.session.personId, JSON.stringify(originalClassification), departmentId, finalUrgency, finalSeverity, finalIsCritical, finalIsEscalation, comment || null, embeddingLiteral]
      : [id, req.session.personId, JSON.stringify(originalClassification), departmentId, finalUrgency, finalSeverity, finalIsCritical, finalIsEscalation, comment || null]
  );

  res.json({ ok: true });
});

// ── Global search ─────────────────────────────────────────────────────────────
router.get("/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ emails: [] });

  const { rows } = await pool.query(
    `SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
            e.to_recipients, e.cc_recipients,
            e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
            e.handled_by_name, e.handled_by_role,
            e.classification_raw, d.name AS department
     FROM emails e
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.mailbox_owner_id = ANY($1::int[])
       AND (e.subject       ILIKE $2
         OR e.from_name     ILIKE $2
         OR e.from_email    ILIKE $2
         OR e.summary       ILIKE $2
         OR e.body_preview  ILIKE $2
         OR e.to_recipients ILIKE $2)
     ORDER BY e.received_at DESC
     LIMIT 50`,
    [req.visibleMailboxIds, `%${q}%`]
  );

  res.json({ emails: rows, query: q });
});

// ── Auto-reply suggestions ─────────────────────────────────────────────────────
router.get("/emails/:id/reply-suggestions", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT subject, from_name, from_email, summary, body_preview
     FROM emails WHERE id = $1 AND mailbox_owner_id = ANY($2::int[])`,
    [req.params.id, req.visibleMailboxIds]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const { subject, from_name, summary, body_preview } = rows[0];

  const prompt = `Draft 3 short professional email reply options for this email.
Subject: ${subject}
From: ${from_name}
Context: ${summary || (body_preview || "").slice(0, 200)}

Return ONLY a JSON array of exactly 3 strings (1-2 sentences each), no markdown:
["option 1","option 2","option 3"]

Options should cover: (1) acknowledge + confirm action, (2) request more info / time, (3) polite defer or partial response.`;

  try {
    const raw = await callLLM(prompt, { maxTokens: 300 });
    if (raw.trimStart().startsWith("<")) throw new Error("LLM returned HTML");
    const suggestions = extractJson(raw);
    if (!Array.isArray(suggestions)) throw new Error("Not an array");
    res.json({ suggestions: suggestions.slice(0, 3) });
  } catch (e) {
    console.error(`[reply-suggestions] error: ${e.message}`);
    res.status(500).json({ error: "Could not generate suggestions" });
  }
});

router.get("/scores", async (req, res) => {
  const { personId } = req.session;
  const ids = req.visibleMailboxIds;
  // Each query below needs its own params array — same reasoning as
  // /attention-summary just above.
  const deptParams = [ids], deptRange = dateRangeFilter(req, deptParams);

  // Department-level stats with thread-gap based avg response
  const { rows: deptRows } = await pool.query(
    // avg_response_hours: customer message -> Sariah's own first reply only
    // (same restriction as Overview's Response Time Trend and its KPI —
    // see that query's comment). Any-direction thread activity would count
    // a customer replying back as "our" response time, which isn't ours to
    // control or claim credit/blame for.
    `WITH base AS (
       SELECT e.id, e.received_at, e.urgency, e.actioned_at, e.is_critical, e.conversation_id,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              COALESCE(d.name, 'Unclassified') AS department,
              LOWER(REGEXP_REPLACE(e.subject, '^\s*(re|fw|fwd)\s*:\s*', '', 'gi')) AS base_subject,
              e.from_email, e.mailbox_owner_id, p.email AS mailbox_email
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       JOIN people p ON p.id = e.mailbox_owner_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) ${deptRange}
     ),
     thread_gaps AS (
       SELECT e1.department,
              EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
       FROM base e1
       JOIN base e2 ON
         e2.mailbox_owner_id = e1.mailbox_owner_id AND
         e2.base_subject = e1.base_subject AND
         e2.received_at > e1.received_at AND
         e2.received_at < e1.received_at + INTERVAL '14 days' AND
         SPLIT_PART(e2.from_email, '@', 2) = SPLIT_PART(e2.mailbox_email, '@', 2)
       WHERE SPLIT_PART(e1.from_email, '@', 2) != SPLIT_PART(e1.mailbox_email, '@', 2)
       GROUP BY e1.id, e1.department, e1.received_at
     )
     SELECT
       b.department,
       -- Distinct threads throughout, not raw rows — a 10-message thread
       -- was counting as 10 toward total_emails/action_needed/critical here
       -- (escalations was already fixed this way earlier; the other three
       -- weren't, which is why Department Load still looked bloated
       -- relative to everything else on Overview — fixed together
       -- 2026-09-05).
       COUNT(DISTINCT b.conversation_id) AS total_emails,
       COUNT(DISTINCT CASE WHEN b.urgency = 'action_needed' THEN b.conversation_id END) AS action_needed,
       COUNT(DISTINCT CASE WHEN b.is_escalation THEN b.conversation_id END) AS escalations,
       COUNT(DISTINCT CASE WHEN b.is_critical THEN b.conversation_id END) AS critical,
       ROUND(
         MAX(EXTRACT(EPOCH FROM (now() - b.received_at)) / 3600)
         FILTER (WHERE b.urgency = 'action_needed' AND b.actioned_at IS NULL)
       , 0) AS longest_pending_hours,
       ROUND((SELECT AVG(gap_hours) FROM thread_gaps tg WHERE tg.department = b.department), 1) AS avg_response_hours
     FROM base b
     GROUP BY b.department
     ORDER BY longest_pending_hours DESC NULLS LAST, total_emails DESC`,
    deptParams
  );

  // Derive the logged-in user's domain so scores only cover internal teammates
  const personRow = await pool.query(`SELECT email FROM people WHERE id = $1`, [personId]);
  const ownerDomain = (personRow.rows[0]?.email || "").split("@")[1] || "";
  const senderParams = [ids, ownerDomain], senderRange = dateRangeFilter(req, senderParams);

  // Sender-level stats — same domain as the logged-in user only.
  // Avg response time: computed from thread pairs in the inbox.
  // When a sender's email is followed by another email from the same sender with
  // the same base subject (RE: stripped), the gap = one response cycle.
  const { rows: senderRows } = await pool.query(
    `WITH base AS (
       SELECT
         e.id,
         e.from_email,
         e.received_at,
         e.urgency,
         e.actioned_at,
         e.is_critical,
         e.conversation_id,
         (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
         LOWER(REGEXP_REPLACE(e.subject, '^\s*(re|fw|fwd)\s*:\s*', '', 'gi')) AS base_subject,
         COALESCE(cm.display_name, e.from_name, e.from_email) AS sender,
         COALESCE(cm.role_label, '') AS role_label,
         COALESCE(cm.department, d.name, '') AS department
       FROM emails e
       LEFT JOIN contact_mappings cm ON LOWER(cm.email) = LOWER(e.from_email)
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.mailbox_owner_id = ANY($1::int[])
         AND SPLIT_PART(e.from_email, '@', 2) = $2 ${senderRange}
     ),
     thread_gaps AS (
       -- Match any follow-up in the same thread (any sender), not just same sender
       SELECT
         e1.from_email,
         EXTRACT(EPOCH FROM (MIN(e2.received_at) - e1.received_at)) / 3600 AS gap_hours
       FROM base e1
       JOIN base e2 ON
         e2.base_subject = e1.base_subject AND
         e2.received_at > e1.received_at AND
         e2.received_at < e1.received_at + INTERVAL '14 days'
       GROUP BY e1.id, e1.from_email, e1.received_at
     )
     SELECT
       b.sender,
       b.from_email,
       b.role_label,
       b.department,
       -- Distinct threads — same "one thread, one mail" fix as deptRows above.
       COUNT(DISTINCT b.conversation_id) AS total_emails,
       COUNT(DISTINCT CASE WHEN b.urgency = 'action_needed' THEN b.conversation_id END) AS action_needed,
       COUNT(DISTINCT CASE WHEN b.is_escalation THEN b.conversation_id END) AS escalations,
       COUNT(DISTINCT CASE WHEN b.is_critical THEN b.conversation_id END) AS critical,
       ROUND(
         MAX(EXTRACT(EPOCH FROM (now() - b.received_at)) / 3600)
         FILTER (WHERE b.urgency = 'action_needed' AND b.actioned_at IS NULL)
       , 0) AS longest_pending_hours,
       ROUND((SELECT AVG(gap_hours) FROM thread_gaps tg WHERE tg.from_email = b.from_email), 1) AS avg_response_hours
     FROM base b
     GROUP BY b.from_email, b.sender, b.role_label, b.department
     ORDER BY longest_pending_hours DESC NULLS LAST, total_emails DESC`,
    senderParams
  );

  // Coordinator-level stats for shared/delegated inboxes with a configured
  // coordinator_roster (e.g. Sariah's contactus@/maintenance@) — handled_by_name
  // is only ever set on a shared inbox's own OUTGOING messages, matched against
  // that mailbox's roster (see ingest.js/signatureParser.js), so this reflects
  // real per-coordinator reply volume, not the domain-based `senders` above
  // (which doesn't apply to a shared inbox's own outgoing address at all).
  //
  // reply_msgs is every genuine outgoing reply (e.from_email = the mailbox's
  // own address), not just the ones matchRoster could pin a name to — a real
  // incident on contactus@sariahfm.com showed only ~36% of true coordinator
  // replies carry a roster name in the visible text (many corporate
  // signatures are pure images, no selectable text), so filtering this whole
  // query to handled_by_name IS NOT NULL badly under-counted real activity.
  // Unattributed replies are still counted, grouped into one "Unattributed
  // reply" row (coordinator IS NULL) so total volume stays honest even where
  // we can't say who specifically sent it.
  const coordParams = [ids], coordRange = dateRangeFilter(req, coordParams);
  const { rows: coordinatorRows } = await pool.query(
    // Range applies to reply_msgs (what's actually counted) only, NOT
    // all_msgs — all_msgs supplies candidate "prior" messages for the
    // response-gap lookback, which needs to see up to 14 days BEFORE the
    // range too, or a reply near the start of a filtered range would
    // wrongly show no prior message to compute a gap against.
    // Real bug fixed 2026-09-05 (a coordinator was showing an implausible
    // ~0-minute avg response time): two separate problems compounded here.
    // (1) response_gaps matched a reply against the closest EARLIER
    // same-subject message with no check that it was genuinely a CUSTOMER
    // message — a reply landing 58 seconds after another Sariah reply (e.g.
    // a second coordinator following up) got counted as "responded in 58
    // seconds," when nothing was actually being responded to. (2) the same
    // physical reply, cc'd to both contactus@ and maintenance@, creates two
    // separate email rows (different conversation_id per mailbox) — reply_msgs
    // counted both as distinct replies, double-billing that coordinator's
    // volume and feeding the same near-zero gap in twice.
    `WITH all_msgs AS (
       SELECT e.id, e.received_at, e.from_email, p.email AS mailbox_email,
              LOWER(REGEXP_REPLACE(e.subject, '^\\s*(re|fw|fwd)\\s*:\\s*', '', 'gi')) AS base_subject
       FROM emails e
       JOIN people p ON p.id = e.mailbox_owner_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND p.is_shared_inbox = true
     ),
     reply_msgs_raw AS (
       SELECT e.id, e.handled_by_name, e.handled_by_role, e.received_at, e.is_critical, e.conversation_id,
              e.internet_message_id,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              LOWER(REGEXP_REPLACE(e.subject, '^\\s*(re|fw|fwd)\\s*:\\s*', '', 'gi')) AS base_subject,
              p.email AS mailbox_email
       FROM emails e
       JOIN people p ON p.id = e.mailbox_owner_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) AND p.is_shared_inbox = true
         AND SPLIT_PART(e.from_email, '@', 2) = SPLIT_PART(p.email, '@', 2) ${coordRange}
     ),
     -- Collapse cross-mailbox copies of the same physical reply down to one
     -- row — same COALESCE(internet_message_id, ...) dedup key already used
     -- by THREAD_DEDUP_CTE elsewhere for the identical reason.
     reply_msgs AS (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY COALESCE(internet_message_id, 'msg-' || id::text) ORDER BY id
       ) AS copy_rn
       FROM reply_msgs_raw
     ),
     response_gaps AS (
       -- Gap from the closest prior GENUINELY INCOMING message (different
       -- domain than this mailbox) in the same thread to this coordinator's
       -- own reply — excludes matching against another Sariah message.
       SELECT cm.id, cm.handled_by_name,
              EXTRACT(EPOCH FROM (cm.received_at - MAX(am.received_at))) / 3600 AS gap_hours
       FROM reply_msgs cm
       JOIN all_msgs am ON am.base_subject = cm.base_subject
         AND am.received_at < cm.received_at
         AND am.received_at > cm.received_at - INTERVAL '14 days'
         AND am.id != cm.id
         AND SPLIT_PART(am.from_email, '@', 2) != SPLIT_PART(am.mailbox_email, '@', 2)
       WHERE cm.copy_rn = 1
       GROUP BY cm.id, cm.handled_by_name, cm.received_at
     )
     SELECT
       COALESCE(cm.handled_by_name, 'Unattributed reply') AS coordinator,
       MAX(cm.handled_by_role) AS role,
       MAX(cm.mailbox_email) AS mailbox,
       -- replies_sent stays a raw per-message count deliberately — each
       -- reply is a genuine, distinct action a coordinator took, even if
       -- several land in the same thread; that's real workload, not
       -- inflation. escalations_handled/critical_handled ARE thread-deduped
       -- though, matching the "one thread, one mail" fix applied everywhere
       -- else 2026-09-05 — otherwise a coordinator sending 5 replies on the
       -- same escalated thread would count as "5 escalations handled." Both
       -- are now also cross-mailbox-copy deduped (copy_rn = 1).
       COUNT(*) AS replies_sent,
       COUNT(DISTINCT CASE WHEN cm.is_escalation THEN cm.conversation_id END) AS escalations_handled,
       COUNT(DISTINCT CASE WHEN cm.is_critical THEN cm.conversation_id END) AS critical_handled,
       ROUND((SELECT AVG(gap_hours) FROM response_gaps rg WHERE rg.handled_by_name IS NOT DISTINCT FROM cm.handled_by_name), 1) AS avg_response_hours,
       (cm.handled_by_name IS NULL) AS is_unattributed
     FROM reply_msgs cm
     WHERE cm.copy_rn = 1
     GROUP BY cm.handled_by_name
     ORDER BY is_unattributed ASC, replies_sent DESC`,
    coordParams
  );

  // Direct-to-staff mailboxes — per Sariah's own MoM (Action_Taken_MoM_01-09-2026.pdf,
  // "Email Addresses — Office Staff Attention"): individual staff addresses
  // that get directly addressed (To:) within shared-inbox correspondence,
  // distinct from both the Coordinators view (signature-attributed replies
  // FROM the shared inbox) and Department Load (classification-based) —
  // this answers "how much mail is really meant for this specific person."
  // Sariah-specific, hardcoded here rather than a new per-client config
  // table, matching how SLA_HOURS above is also not yet per-client.
  const SARIAH_STAFF_ADDRESSES = [
    "accounts@sariahfm.com", "admin@sariahfm.com", "infor@sariahfm.com", "ali@sariahfm.com",
    "hadi@sariahfm.com", "hr@sariahfm.com", "janaki@sariahfm.com", "jihan@sariahfm.com",
    "kutty@sariahfm.com", "perwez@sariahfm.com", "maloof@sariahfm.com", "thameem@sariahfm.com",
    "pradeep@sariahfm.com", "rex@sariahfm.com", "shine@sariahfm.com", "shurouk@sariahfm.com",
    "suroor@sariahfm.com", "sineesh@sariahfm.com", "vishnumohan@sariahfm.com",
  ];
  const directParams = [ids, SARIAH_STAFF_ADDRESSES];
  const directRange = dateRangeFilter(req, directParams);
  const { rows: directRecipientRows } = await pool.query(
    `WITH staff AS (
       SELECT unnest($2::text[]) AS address
     ),
     matched AS (
       SELECT s.address, e.id, e.urgency, e.is_critical, e.conversation_id,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation
       FROM staff s
       JOIN emails e ON e.mailbox_owner_id = ANY($1::int[]) AND e.to_recipients ILIKE '%' || s.address || '%' ${directRange}
     )
     SELECT
       address,
       COUNT(DISTINCT conversation_id) AS total_emails,
       COUNT(DISTINCT CASE WHEN urgency = 'action_needed' THEN conversation_id END) AS action_needed,
       COUNT(DISTINCT CASE WHEN is_escalation THEN conversation_id END) AS escalations,
       COUNT(DISTINCT CASE WHEN is_critical THEN conversation_id END) AS critical
     FROM matched
     GROUP BY address
     ORDER BY total_emails DESC`,
    directParams
  );

  res.json({
    departments: deptRows, senders: senderRows, domain: ownerDomain, coordinators: coordinatorRows,
    directRecipients: directRecipientRows,
  });
});

router.get("/emails", async (req, res) => {
  const { department } = req.query;

  const params = [req.visibleMailboxIds];
  let departmentFilter = "";
  if (department) {
    params.push(department);
    departmentFilter = `AND d.name = $${params.length}`;
  }
  const range = dateRangeFilter(req, params);

  const { rows } = await pool.query(
    `WITH filtered AS (
       SELECT e.id, e.subject, e.from_name, e.from_email, e.received_at,
              e.to_recipients, e.cc_recipients, e.conversation_id, e.internet_message_id,
              e.is_direct_to_owner, e.urgency, e.is_critical, e.summary, e.actioned_at,
              d.name AS department, p.display_name AS attributed_to,
              e.handled_by_name, e.handled_by_role, e.severity, e.confidence,
              (e.classification_raw->>'isEscalation')::boolean AS is_escalation,
              mb.email AS mailbox_email, mb.is_shared_inbox,
              pr.id AS property_id, pr.property_no, pr.ubs AS property_ubs, pr.site_name AS property_site_name, pr.customer_name AS property_customer,
              e.customer_name_hint,
              CASE WHEN e.severity IS NOT NULL AND e.urgency = 'action_needed' THEN e.received_at + (${SLA_CASE}) * interval '1 hour' END AS sla_deadline,
              CASE WHEN mb.is_shared_inbox
                THEN EXISTS (SELECT 1 FROM emails c WHERE c.conversation_id = e.conversation_id AND SPLIT_PART(c.from_email, '@', 2) = SPLIT_PART(mb.email, '@', 2))
                ELSE e.actioned_at IS NOT NULL
              END AS sla_met
       FROM emails e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN people p ON p.id = e.attributed_person_id
       LEFT JOIN people mb ON mb.id = e.mailbox_owner_id
       LEFT JOIN properties pr ON pr.id = e.property_id
       WHERE e.mailbox_owner_id = ANY($1::int[]) ${departmentFilter} ${range}
     ),
     ${THREAD_DEDUP_CTE}
     SELECT *, (SELECT COUNT(*) FROM emails c WHERE c.conversation_id = deduped.conversation_id) AS thread_message_count
     FROM deduped
     WHERE thread_rn = 1
     ORDER BY is_critical DESC, received_at DESC
     LIMIT 5000`,
    params
  );

  res.json({ emails: rows });
});

module.exports = router;
