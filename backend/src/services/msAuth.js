const axios = require("axios");
const pool = require("../db/pool");

const AUTHORITY = `https://login.microsoftonline.com/common`;
// Mail.Read.Shared covers mailboxes this account has been granted Full Access
// delegation on (e.g. shared inboxes like contactus@/maintenance@) — no separate
// login for those mailboxes is needed once delegation is granted in Exchange
// Admin Center. Deliberately NOT requesting Mail.Send.Shared: clients granting
// delegated access to a shared inbox typically want READ-ONLY (no send/modify/
// delete/move) — see AGENTS.md. Mail.Send here only ever covers the signed-in
// account's own mailbox.
const SCOPES = [
  "Mail.Read", "Mail.Send", "Mail.Read.Shared",
  "Calendars.ReadWrite", "User.Read", "offline_access",
].join(" ");

/**
 * Builds the URL to redirect the user to for Microsoft sign-in/consent.
 */
function getAuthorizationUrl() {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.AZURE_REDIRECT_URI,
    response_mode: "query",
    scope: SCOPES,
  });
  return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchanges the authorization code (from the redirect callback) for access + refresh tokens.
 */
async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.AZURE_REDIRECT_URI,
    scope: SCOPES,
  });

  const response = await axios.post(
    `${AUTHORITY}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data; // { access_token, refresh_token, expires_in, ... }
}

/**
 * Refreshes an access token using a stored refresh token.
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  const response = await axios.post(
    `${AUTHORITY}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data;
}

/**
 * Fetches the signed-in user's basic profile (to know who just logged in).
 */
async function getMe(accessToken) {
  const response = await axios.get("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data; // { mail, userPrincipalName, displayName, ... }
}

const TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;

/**
 * Saves or updates tokens for a person in the database. Tokens are encrypted at
 * rest with pgcrypto — plaintext tokens are a much bigger liability once a token
 * can grant delegated access to a shared company mailbox, not just one inbox.
 */
async function saveTokens(personId, tokenResponse) {
  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000);
  await pool.query(
    `INSERT INTO oauth_tokens (person_id, provider, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, 'microsoft', pgp_sym_encrypt($2, $5), pgp_sym_encrypt($3, $5), $4, now())
     ON CONFLICT (person_id, provider)
     DO UPDATE SET access_token = pgp_sym_encrypt($2, $5), refresh_token = pgp_sym_encrypt($3, $5), expires_at = $4, updated_at = now()`,
    [personId, tokenResponse.access_token, tokenResponse.refresh_token, expiresAt, TOKEN_ENCRYPTION_KEY]
  );
}

/**
 * Gets a valid access token for a person, refreshing it first if it's expired.
 */
async function getValidAccessToken(personId) {
  const { rows } = await pool.query(
    `SELECT pgp_sym_decrypt(access_token, $2) AS access_token,
            pgp_sym_decrypt(refresh_token, $2) AS refresh_token,
            expires_at
     FROM oauth_tokens WHERE person_id = $1 AND provider = 'microsoft'`,
    [personId, TOKEN_ENCRYPTION_KEY]
  );
  if (rows.length === 0) {
    throw new Error(`No stored tokens for person_id ${personId}. They need to connect their mailbox first.`);
  }

  const { access_token, refresh_token, expires_at } = rows[0];
  const isExpired = new Date(expires_at).getTime() < Date.now() + 60_000; // refresh 1 min early

  if (!isExpired) {
    return access_token;
  }

  const refreshed = await refreshAccessToken(refresh_token);
  await saveTokens(personId, refreshed);
  return refreshed.access_token;
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getMe,
  saveTokens,
  getValidAccessToken,
};
