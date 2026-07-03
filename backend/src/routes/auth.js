const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { getAuthorizationUrl, exchangeCodeForTokens, getMe, saveTokens } = require("../services/msAuth");

// Step 1: send the user to Microsoft's login/consent page
router.get("/login", (req, res) => {
  res.redirect(getAuthorizationUrl());
});

// Step 2: Microsoft redirects back here with a ?code=... after the user approves
router.get("/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error("OAuth error from Microsoft:", error, error_description);
    return res.status(400).send(`Login failed: ${error_description || error}`);
  }

  if (!code) {
    return res.status(400).send("Missing authorization code in callback.");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const profile = await getMe(tokens.access_token);

    const email = (profile.mail || profile.userPrincipalName || "").toLowerCase();
    if (!email) {
      return res.status(400).send("Could not determine the signed-in user's email address.");
    }

    // Find or create this person in our people table
    let { rows } = await pool.query(`SELECT id FROM people WHERE email = $1`, [email]);
    let personId;
    if (rows.length === 0) {
      const insertResult = await pool.query(
        `INSERT INTO people (email, display_name, ms_graph_connected)
         VALUES ($1, $2, true) RETURNING id`,
        [email, profile.displayName || email]
      );
      personId = insertResult.rows[0].id;
      console.log(`[auth] Created new person record for ${email}`);
    } else {
      personId = rows[0].id;
      await pool.query(`UPDATE people SET ms_graph_connected = true WHERE id = $1`, [personId]);
    }

    await saveTokens(personId, tokens);

    req.session.personId = personId;
    req.session.email    = email;
    req.session.provider = "microsoft";

    res.redirect(`${process.env.FRONTEND_URL}/?connected=true`);
  } catch (err) {
    console.error("OAuth callback failed:", err.response?.data || err.message);
    res.status(500).send("Login failed during token exchange. Check server logs for details.");
  }
});

router.get("/me", (req, res) => {
  if (!req.session.personId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  res.json({
    personId: req.session.personId,
    email:    req.session.email,
    provider: req.session.provider || "microsoft",
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

module.exports = router;
