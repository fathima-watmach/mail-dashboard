const axios = require("axios");
const { callLlm } = require("./llmQueue");

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

async function callLLM(prompt, { maxTokens = 800, retries = 3 } = {}) {
  const provider = process.env.CLASSIFIER_PROVIDER || "deepseek";

  // Groq and Gemini go through the shared rate-limit queue — serialized with the classifier
  if (provider === "groq") {
    const r = await callLlm(() => axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: process.env.GROQ_MODEL || "llama-3.1-8b-instant", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" } }
    ));
    return r.data.choices[0].message.content.trim();
  }

  if (provider === "gemini") {
    const r = await callLlm(() => axios.post(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      { model: process.env.GEMINI_MODEL || "gemini-2.0-flash", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
      { headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, "Content-Type": "application/json" } }
    ));
    return r.data.choices[0].message.content.trim();
  }

  // DeepSeek / Ollama use a simple retry loop (not queue-managed)
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (provider === "deepseek") {
        const r = await axios.post(
          `${process.env.DEEPSEEK_BASE_URL}/chat/completions`,
          { model: process.env.DEEPSEEK_MODEL || "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
          { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" } }
        );
        return r.data.choices[0].message.content.trim();
      }

      // ollama (local dev only)
      const r = await axios.post(
        "http://localhost:11434/v1/chat/completions",
        { model: process.env.OLLAMA_MODEL || "llama3", messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens },
        { headers: { "Content-Type": "application/json" } }
      );
      return r.data.choices[0].message.content.trim();

    } catch (err) {
      const is429 = err.response?.status === 429;
      if (is429 && attempt < retries) {
        const wait = attempt * 10000;
        console.warn(`[llm] Rate limited (429), retrying in ${wait / 1000}s (attempt ${attempt}/${retries})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { callLLM, extractJson };
