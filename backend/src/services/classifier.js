const axios = require("axios");

/**
 * Provider-agnostic classification interface.
 * Today this calls DeepSeek. Swapping to Claude/OpenAI later means writing
 * one new function with this same signature and changing CLASSIFIER_PROVIDER
 * below - nothing else in the pipeline needs to change.
 */

function extractJson(rawText) {
  const start = rawText.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in response");
  let end = rawText.lastIndexOf("}");
  const slice = end === -1 ? rawText.slice(start) + "}" : rawText.slice(start, end + 1);
  return JSON.parse(slice);
}

const DEPARTMENTS = [
  "Sales",
  "Pre-sales",
  "Operations & Procurement",
  "Finance",
  "Projects",
];

function buildClassificationPrompt(email) {
  return `You are classifying a business email for a CEO dashboard.

Departments (pick exactly one): ${DEPARTMENTS.join(", ")}

Email:
From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Directly addressed to CEO (not just CC'd): ${email.isDirectToOwner}
Body preview: ${email.bodyPreview}

Decide:
1. department: which department this belongs to
2. urgency: "action_needed" if the CEO must personally act or decide, "fyi" if awareness only
3. is_escalation: true ONLY for real business problems — broken equipment, customer complaints, supplier failures, financial risks, or security incidents. NEVER for test emails, welcome messages, event invitations, routine order updates, payment notifications, or informational emails.
4. is_critical: true ONLY if this requires action TODAY — explicit today deadline, severe ongoing outage, or sender is waiting right now. false otherwise.
5. summary: 1-2 plain-English sentences: what is this email about and what action (if any) is needed
6. reasoning: one short sentence explaining your urgency/escalation decision

Respond with ONLY valid JSON, no markdown, in this exact shape:
{"department":"...","urgency":"action_needed or fyi","is_escalation":true or false,"is_critical":true or false,"summary":"...","reasoning":"..."}`;
}

async function classifyWithDeepSeek(email) {
  const prompt = buildClassificationPrompt(email);

  const response = await axios.post(
    `${process.env.DEEPSEEK_BASE_URL}/chat/completions`,
    {
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 200,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const rawText = response.data.choices[0].message.content.trim();

  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch (err) {
    throw new Error(`Failed to parse classifier response as JSON: ${rawText}`);
  }

  if (!DEPARTMENTS.includes(parsed.department)) {
    // Fall back gracefully rather than crashing the whole ingestion run
    parsed.department = "Operations & Procurement";
    parsed.reasoning = (parsed.reasoning || "") + " [fallback: unrecognized department from model]";
  }

  return {
    department: parsed.department,
    urgency: parsed.urgency === "action_needed" ? "action_needed" : "fyi",
    isEscalation: Boolean(parsed.is_escalation),
    isCritical: Boolean(parsed.is_critical),
    summary: parsed.summary || "",
    reasoning: parsed.reasoning || "",
    raw: response.data,
  };
}

async function classifyWithGroq(email) {
  const prompt = buildClassificationPrompt(email);

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 600,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const rawText = response.data.choices[0].message.content.trim();

  let parsed;
  try {
    const cleaned = rawText.replace(/^```json\s*|\s*```$/g, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Groq classifier response as JSON: ${rawText}`);
  }

  if (!DEPARTMENTS.includes(parsed.department)) {
    parsed.department = "Operations & Procurement";
    parsed.reasoning = (parsed.reasoning || "") + " [fallback: unrecognized department from model]";
  }

  return {
    department: parsed.department,
    urgency: parsed.urgency === "action_needed" ? "action_needed" : "fyi",
    isEscalation: Boolean(parsed.is_escalation),
    isCritical: Boolean(parsed.is_critical),
    summary: parsed.summary || "",
    reasoning: parsed.reasoning || "",
    raw: response.data,
  };
}

async function classifyWithOllama(email) {
  const prompt = buildClassificationPrompt(email);

  const response = await axios.post(
    "http://localhost:11434/v1/chat/completions",
    {
      model: process.env.OLLAMA_MODEL || "llama3",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 600,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  const rawText = response.data.choices[0].message.content.trim();

  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch (err) {
    throw new Error(`Failed to parse Ollama classifier response as JSON: ${rawText}`);
  }

  if (!DEPARTMENTS.includes(parsed.department)) {
    parsed.department = "Operations & Procurement";
    parsed.reasoning = (parsed.reasoning || "") + " [fallback: unrecognized department from model]";
  }

  return {
    department: parsed.department,
    urgency: parsed.urgency === "action_needed" ? "action_needed" : "fyi",
    isEscalation: Boolean(parsed.is_escalation),
    isCritical: Boolean(parsed.is_critical),
    summary: parsed.summary || "",
    reasoning: parsed.reasoning || "",
    raw: response.data,
  };
}

async function classifyEmail(email) {
  const provider = process.env.CLASSIFIER_PROVIDER || "deepseek";
  switch (provider) {
    case "deepseek":
      return classifyWithDeepSeek(email);
    case "groq":
      return classifyWithGroq(email);
    case "ollama":
      return classifyWithOllama(email);
    default:
      throw new Error(`Unknown classifier provider: ${provider}`);
  }
}

module.exports = { classifyEmail, DEPARTMENTS };
