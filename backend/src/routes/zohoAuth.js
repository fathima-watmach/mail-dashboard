const express = require("express");
const router  = express.Router();
const pool    = require("../db/pool");
const { getAuthorizationUrl, exchangeCodeForTokens, saveTokens } = require("../services/zohoAuth");
const { getAccountId } = require("../services/zohoMail");

// Step 1: redirect user to Zoho consent page
router.get("/login", (req, res) => {
  res.redirect(getAuthorizationUrl());
});

// Step 2: Zoho redirects back here with ?code=...
router.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error("Zoho OAuth error:", error || "missing code");
    return res.status(400).send(`Zoho login failed: ${error || "missing code"}`);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    // getAccountId returns both the accountId and the email — no separate profile call needed
    const { accountId, email: zohoEmail } = await getAccountId(tokens.access_token);

    const profile = { email: zohoEmail, displayName: zohoEmail };

    if (!profile.email) {
      return res.status(400).send("Could not determine signed-in Zoho user's email.");
    }

    // Find or create the person record
    let { rows } = await pool.query(`SELECT id FROM people WHERE email = $1`, [profile.email]);
    let personId;

    if (rows.length === 0) {
      const r = await pool.query(
        `INSERT INTO people (email, display_name, zoho_connected, zoho_account_id)
         VALUES ($1, $2, true, $3) RETURNING id`,
        [profile.email, profile.displayName, accountId]
      );
      personId = r.rows[0].id;
      console.log(`[zoho-auth] Created new person for ${profile.email}`);
    } else {
      personId = rows[0].id;
      await pool.query(
        `UPDATE people SET zoho_connected = true, zoho_account_id = $2 WHERE id = $1`,
        [personId, accountId]
      );
    }

    await saveTokens(personId, tokens);

    req.session.personId = personId;
    req.session.email    = profile.email;
    req.session.provider = "zoho";

    res.redirect(`${process.env.FRONTEND_URL}/?connected=true`);
  } catch (err) {
    console.error("Zoho OAuth callback failed:", err.response?.data || err.message);
    res.status(500).send("Zoho login failed. Check server logs.");
  }
});

module.exports = router;
