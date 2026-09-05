const axios = require("axios");
const { callLlm } = require("./llmQueue");
const { assertBudgetAvailable, recordEmbeddingUsage } = require("./llmBudget");

// Shared by property-matching's semantic fallback (propertyMatcher.js) and
// classification-feedback retrieval (classifier.js) — both need "turn this
// text into a vector" and nothing more provider-specific than that.
// gemini-embedding-001, scaled to 768 dims via Matryoshka Representation
// Learning (the model's default is 3072 — 768 is plenty of signal for short
// subject-line/property-name text and keeps pgvector search fast at this
// data volume). Same queue/budget-guard pattern as llm.js's callLLM, since
// this hits the same Gemini API key and the same monthly cap.
const DIMENSIONS = 768;

async function embedText(text) {
  await assertBudgetAvailable();
  const r = await callLlm(() => axios.post(
    "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
    { model: "gemini-embedding-001", input: text.slice(0, 8000), dimensions: DIMENSIONS },
    { headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, "Content-Type": "application/json" } }
  ));
  await recordEmbeddingUsage(r.data.usage);
  return r.data.data[0].embedding;
}

// pgvector's wire format for a `vector` column literal — pg (node-postgres)
// has no native array-of-floats binding for a custom type, so this goes in
// as a plain string cast with `::vector` at the call site.
function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

module.exports = { embedText, toVectorLiteral, DIMENSIONS };
