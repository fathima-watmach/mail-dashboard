/**
 * Lightweight LLM caller — routes to the same provider as the classifier.
 * Use this for any ad-hoc LLM call (thread summary, meeting extraction, etc.)
 */
const axios = require("axios");

function extractJson(raw) {
  // Handle both object {} and array [] responses
  const objStart = raw.indexOf("{");
  const arrStart = raw.indexOf("[");
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (start === -1) throw new Error("No JSON found in LLM response");
  const lastBrace  = raw.lastIndexOf("}");
  const lastBracket = raw.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  return JSON.parse(raw.slice(start, end + 1));
}

async function callLLM(prompt, { maxTokens = 800 } = {}) {
  const provider = process.env.CLASSIFIER_PROVIDER || "deepseek";

  if (provider === "deepseek") {
    const r = await axios.post(
      `${process.env.DEEPSEEK_BASE_URL}/chat/completions`,
      { model: process.env.DEEPSEEK_MODEL || "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" } }
    );
    return r.data.choices[0].message.content.trim();
  }

  if (provider === "groq") {
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    );
    return r.data.choices[0].message.content.trim();
  }

  // ollama (default)
  const r = await axios.post(
    "http://localhost:11434/v1/chat/completions",
    { model: process.env.OLLAMA_MODEL || "llama3", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
    { headers: { "Content-Type": "application/json" } }
  );
  return r.data.choices[0].message.content.trim();
}

module.exports = { callLLM, extractJson };
