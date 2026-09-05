// Global serializing queue for all LLM API calls.
// All callers (classifier, thread summaries, reclassify) share one rate-limit budget.
// The project moved to a billed (Tier 1) Gemini API key partway through this
// session — the free-tier 15 RPM cap this was originally tuned for no longer
// applies. User confirmed the real paid-tier limit directly from the Gemini
// dashboard: 300 RPM (vs. 15 RPM free) — paced to ~270 RPM, a small margin
// under that to absorb timing jitter; the circuit breaker below still
// self-corrects (opens for a cooldown) if this is still too aggressive. This only
// self-throttles a single process; TWO processes sharing one key can still
// collide since Gemini enforces the cap server-side per key, not per process —
// avoid running more than one classification-heavy process at a time.
// The $10/month hard cap (llmBudget.js) remains the real ceiling regardless
// of how fast this paces — speed doesn't change what we're willing to spend.

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INTERVAL_MS = 220; // ~270 calls/min — just under the confirmed 300 RPM paid-tier cap

// Circuit breaker: a 429 can mean a transient RPM burst (worth a short wait
// and retry) OR the 500/day RPD cap being exhausted (won't clear until the
// daily reset, however many hours away). The original 60s-per-429 backoff
// assumed only the former — against a real exhausted-RPD day with thousands
// of queued messages, that meant waiting a full 60s before EVERY single one,
// a multi-day worst case for one ingestion batch instead of an hourly retry.
// After a few 429s in a row, assume the worse case and stop even attempting
// calls for a longer cooldown — callers' existing per-message error handling
// (ingest.js already saves a message unclassified on any failure) then kicks
// in immediately instead of after a minute, so a blocked batch fails fast.
const CONSECUTIVE_429_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

const queue = [];
let draining = false;
let lastCallAt = 0;
let consecutive429s = 0;
let circuitOpenUntil = 0;

async function drain() {
  draining = true;
  while (queue.length > 0) {
    if (Date.now() < circuitOpenUntil) {
      // Circuit open — reject everything currently queued without waiting,
      // so a large batch fails fast instead of grinding through one by one.
      const remaining = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
      while (queue.length > 0) {
        const { reject } = queue.shift();
        reject(new Error(`LLM rate limit circuit open — retrying in ~${remaining}s`));
      }
      break;
    }

    const wait = Math.max(0, lastCallAt + INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);

    const { fn, resolve, reject } = queue.shift();
    lastCallAt = Date.now();

    try {
      const result = await fn();
      consecutive429s = 0;
      resolve(result);
    } catch (err) {
      if (err.response?.status === 429) {
        consecutive429s++;
        console.warn(`[llm-queue] 429 rate limit hit (${consecutive429s} in a row)`);
        if (consecutive429s >= CONSECUTIVE_429_THRESHOLD) {
          circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
          console.warn(`[llm-queue] Opening circuit for ${CIRCUIT_COOLDOWN_MS / 60000}min — likely daily quota exhausted, not just a burst`);
        } else {
          lastCallAt = Date.now() + 60000; // short backoff for the first couple, in case it's just an RPM burst
        }
      }
      reject(err);
    }
  }
  draining = false;
}

function callLlm(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!draining) drain();
  });
}

module.exports = { callLlm };
