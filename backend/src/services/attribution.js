const pool = require("../db/pool");

/**
 * Determines who is "responsible" for an email by checking if anyone in our
 * known people table appears as the sender, or in the To:/CC: lists, and is
 * in the department the classifier assigned.
 *
 * This is intentionally simple for Phase 1: it relies on the manually
 * maintained `people` table (email -> department mapping) rather than trying
 * to infer ownership automatically. Refine this once real data shows what
 * signals are reliable (e.g. who actually tends to reply per department).
 */
async function attributePerson({ fromEmail, toRecipients, ccRecipients, departmentName }) {
  const candidateEmails = [
    fromEmail,
    ...(toRecipients ? toRecipients.split(",").map((e) => e.trim()) : []),
    ...(ccRecipients ? ccRecipients.split(",").map((e) => e.trim()) : []),
  ].filter(Boolean);

  if (candidateEmails.length === 0) return null;

  const { rows } = await pool.query(
    `SELECT p.id, p.email, p.department_id, d.name AS department_name
     FROM people p
     LEFT JOIN departments d ON d.id = p.department_id
     WHERE p.email = ANY($1::text[])`,
    [candidateEmails]
  );

  if (rows.length === 0) return null;

  // Prefer a match whose department matches the classifier's department call
  const departmentMatch = rows.find(
    (r) => r.department_name && r.department_name.toLowerCase() === (departmentName || "").toLowerCase()
  );

  return (departmentMatch || rows[0]).id;
}

module.exports = { attributePerson };
