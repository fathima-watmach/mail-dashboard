// Hard monthly spend cap on the LLM classifier, persisted in Postgres (not
// in-memory) so it holds across server restarts/redeploys — an in-memory
// counter would silently reset every time Render redeploys, which defeats a
// "never exceed $X/month" guarantee. Every classifier/thread-summary call
// site must call assertBudgetAvailable() before calling out, and
// recordUsage() after a successful response.
//
// This is a code-level safety net, not the only guard: pairing it with a
// Gemini API key from Google AI Studio that has NO billing account attached
// makes it structurally impossible to be billed at all — requests beyond the
// free tier simply fail (429) instead of costing money. Recommended alongside
// this, not instead of it.
const pool = require("../db/pool");

// Gemini 3.5 Flash-Lite pricing, per 1M tokens, as of Aug 2026 (2.5 Flash-Lite
// is no longer available to new API keys — this app was switched to 3.5).
// Output is priced notably higher than 2.5 Flash-Lite was ($0.40 -> $2.50/1M)
// — re-verify at https://ai.google.dev/gemini-api/docs/pricing before assuming
// this is still current if the monthly spend looks off.
const PRICE = { input: 0.30, output: 2.50 };

// gemini-embedding-001 pricing, per 1M input tokens, as of Sept 2026 — no
// output-token cost (an embedding call returns a vector, not generated
// text). Re-verify at https://ai.google.dev/gemini-api/docs/pricing if
// embedding-related spend ever looks off.
const EMBEDDING_PRICE_PER_1M = 0.15;

const envCap = Number(process.env.LLM_MONTHLY_CAP_USD);
// `|| 10` would treat an explicit LLM_MONTHLY_CAP_USD=0 as "unset" (0 is
// falsy) — check presence explicitly instead, same bug class avoided here
// as in the daily-cap version this replaced.
const MONTHLY_CAP_USD = process.env.LLM_MONTHLY_CAP_USD !== undefined && Number.isFinite(envCap) ? envCap : 10;

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM', UTC
}

// Call BEFORE issuing an LLM request. Throws if this month's spend is
// already at/over the cap — callers already handle LLM-call failures
// gracefully (ingest.js saves the email unclassified for later retry;
// thread-summary/reply-suggestion routes already handle call failures), so
// no new error-handling is needed at the call sites.
async function assertBudgetAvailable() {
  const { rows } = await pool.query(
    `SELECT spent_usd FROM llm_spend WHERE month = $1`, [currentMonth()]
  );
  const spent = Number(rows[0]?.spent_usd || 0);
  if (spent >= MONTHLY_CAP_USD) {
    throw new Error(`LLM monthly budget of $${MONTHLY_CAP_USD} reached ($${spent.toFixed(4)} spent this month) — resumes next UTC month`);
  }
}

// Call AFTER a successful Gemini response, with its `usage` object
// (OpenAI-compatible shape: prompt_tokens / completion_tokens).
async function recordUsage(usage) {
  if (!usage) return;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cost = (inputTokens / 1e6) * PRICE.input + (outputTokens / 1e6) * PRICE.output;
  await pool.query(
    `INSERT INTO llm_spend (month, spent_usd) VALUES ($1, $2)
     ON CONFLICT (month) DO UPDATE SET spent_usd = llm_spend.spent_usd + $2`,
    [currentMonth(), cost]
  );
}

// Embedding calls (property-match semantic fallback, classification-feedback
// retrieval) share the same monthly cap and llm_spend counter as
// classification/summaries — same API key, same "never exceed $X/month"
// guarantee. OpenAI-compatible embeddings usage only reports prompt_tokens
// (no completion side), unlike chat completions.
async function recordEmbeddingUsage(usage) {
  if (!usage) return;
  const inputTokens = usage.prompt_tokens ?? 0;
  const cost = (inputTokens / 1e6) * EMBEDDING_PRICE_PER_1M;
  await pool.query(
    `INSERT INTO llm_spend (month, spent_usd) VALUES ($1, $2)
     ON CONFLICT (month) DO UPDATE SET spent_usd = llm_spend.spent_usd + $2`,
    [currentMonth(), cost]
  );
}

async function getStatus() {
  const { rows } = await pool.query(
    `SELECT spent_usd FROM llm_spend WHERE month = $1`, [currentMonth()]
  );
  return { month: currentMonth(), spentUsd: Number(rows[0]?.spent_usd || 0), capUsd: MONTHLY_CAP_USD };
}

module.exports = { assertBudgetAvailable, recordUsage, recordEmbeddingUsage, getStatus, MONTHLY_CAP_USD };
