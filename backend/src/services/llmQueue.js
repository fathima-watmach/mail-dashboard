// Global serializing queue for all LLM API calls.
// All callers (classifier, thread summaries, reclassify) share one rate-limit budget.
// Interval tuned for Groq free tier: 2.2s = 27/min, safely under 30 RPM.

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INTERVAL_MS = 2200; // 27 calls/min — under Groq free tier 30 RPM

const queue = [];
let draining = false;
let lastCallAt = 0;

async function drain() {
  draining = true;
  while (queue.length > 0) {
    const wait = Math.max(0, lastCallAt + INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);

    const { fn, resolve, reject } = queue.shift();
    lastCallAt = Date.now();

    try {
      resolve(await fn());
    } catch (err) {
      if (err.response?.status === 429) {
        // Back off 30s before the next queued call
        console.warn("[llm-queue] 429 rate limit hit — backing off 30s");
        lastCallAt = Date.now() + 30000;
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
