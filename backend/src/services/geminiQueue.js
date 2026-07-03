// Global serializing queue for all Gemini API calls.
// All callers (classifier, llm, etc.) share one 15-RPM budget — this enforces
// 4.2s between every call so we never exceed 14.3/min across the whole app.

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INTERVAL_MS = 4200; // 14.3 calls/min — safely under free tier 15 RPM

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
        // Back off 20s before the next queued call
        console.warn("[gemini-queue] 429 — backing off 20s");
        lastCallAt = Date.now() + 20000;
      }
      reject(err);
    }
  }
  draining = false;
}

function callGemini(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    if (!draining) drain();
  });
}

module.exports = { callGemini };
