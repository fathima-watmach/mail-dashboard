const axios = require("axios");
const { callLlm } = require("./llmQueue");
const { assertBudgetAvailable, recordUsage } = require("./llmBudget");

function extractJson(raw) {
  const objStart = raw.indexOf("{");
  const arrStart = raw.indexOf("[");
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) throw new Error("No JSON found in LLM response");
  const lastBrace   = raw.lastIndexOf("}");
  const lastBracket = raw.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  return JSON.parse(raw.slice(start, end + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gemini-only — thread summaries and reply suggestions share the same
// monthly budget cap and rate-limit queue as classification (classifier.js).
async function callLLM(prompt, { maxTokens = 800, retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await assertBudgetAvailable();
      const r = await callLlm(() => axios.post(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        { model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
        { headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, "Content-Type": "application/json" } }
      ));
      await recordUsage(r.data.usage);
      return r.data.choices[0].message.content.trim();
    } catch (err) {
      const status = err.response?.status;
      const is429 = status === 429;
      // 5xx (503 especially — Gemini flash-lite returns this under transient
      // overload, seen for real: "Could not build thread context" errors
      // traced back to a bare 503 with zero retry) is worth retrying with a
      // short backoff, same as 429 but faster since it's not a quota wait.
      const is5xx = status >= 500 && status < 600;
      if ((is429 || is5xx) && attempt < retries) {
        const wait = is429 ? attempt * 10000 : attempt * 3000;
        console.warn(`[llm] ${status} error, retrying in ${wait / 1000}s (attempt ${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { callLLM, extractJson };
