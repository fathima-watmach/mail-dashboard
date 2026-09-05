const axios = require("axios");
const { callLlm } = require("./llmQueue");
const { assertBudgetAvailable, recordUsage } = require("./llmBudget");

// Fallback attribution for shared-inbox replies whose signature is a single
// flattened image (logo + name baked into pixels) rather than selectable
// text — confirmed by direct inspection that neither Graph's plain-text nor
// raw-HTML body ever contains the name in that case, so matchRoster()
// against body text can never find it. Shares the same monthly budget cap
// and rate-limit queue as classification (llmBudget.js/llmQueue.js) — this
// is just another Gemini call, not a separate cost path.
//
// Only ever matches against the mailbox's own known roster (never returns a
// name the caller didn't already trust), the same safety property
// matchRoster() has — the model is asked to pick from a closed list, not to
// invent a name, and the result is re-validated against that list before
// being trusted.
async function matchRosterFromImage(imageBase64, contentType, roster) {
  if (!imageBase64 || !roster?.length) return null;

  await assertBudgetAvailable();

  const names = roster.map((r) => r.name);
  const prompt = `This image is an email signature block. Which of these exact names, if any, appears in it: ${JSON.stringify(names)}. Reply with ONLY the exact matching name from the list, or the single word "none" if none of them appear. Do not explain.`;

  const r = await callLlm(() => axios.post(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    {
      model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${contentType};base64,${imageBase64}` } },
        ],
      }],
      temperature: 0,
      max_tokens: 20,
    },
    { headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, "Content-Type": "application/json" } }
  ));
  await recordUsage(r.data.usage);

  const answer = r.data.choices[0].message.content.trim();
  const matched = roster.find((entry) => entry.name.toLowerCase() === answer.toLowerCase());
  return matched ? { name: matched.name, role: matched.role || null } : null;
}

module.exports = { matchRosterFromImage };
