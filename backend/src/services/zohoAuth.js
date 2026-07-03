const axios = require("axios");
const pool = require("../db/pool");

const ZOHO_BASE   = "https://accounts.zoho.com";
const SCOPES      = "ZohoMail.messages.READ ZohoMail.messages.CREATE ZohoMail.accounts.READ";

function getAuthorizationUrl() {
  const params = new URLSearchParams({
    client_id:     process.env.ZOHO_CLIENT_ID,
    response_type: "code",
    redirect_uri:  process.env.ZOHO_REDIRECT_URI,
    scope:         SCOPES,
    access_type:   "offline",   // required to get a refresh_token
    prompt:        "consent",
  });
  return `${ZOHO_BASE}/oauth/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    "authorization_code",
    code,
    redirect_uri:  process.env.ZOHO_REDIRECT_URI,
  });

  const { data } = await axios.post(
    `${ZOHO_BASE}/oauth/v2/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  if (data.error) throw new Error(`Zoho token exchange failed: ${data.error}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });

  const { data } = await axios.post(
    `${ZOHO_BASE}/oauth/v2/token`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  if (data.error) throw new Error(`Zoho token refresh failed: ${data.error}`);
  return data;
}

async function getMe(accessToken) {
  const { data } = await axios.get(`${ZOHO_BASE}/oauth/user/info`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  // Returns { Email, Display_Name, ... }
  return { email: data.Email?.toLowerCase(), displayName: data.Display_Name || data.Email };
}

async function saveTokens(personId, tokenResponse) {
  const expiresAt = new Date(Date.now() + (tokenResponse.expires_in || 3600) * 1000);
  await pool.query(
    `INSERT INTO oauth_tokens (person_id, provider, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, 'zoho', $2, $3, $4, now())
     ON CONFLICT (person_id, provider)
     DO UPDATE SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = now()`,
    [personId, tokenResponse.access_token, tokenResponse.refresh_token, expiresAt]
  );
}

async function getValidAccessToken(personId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE person_id = $1 AND provider = 'zoho'`,
    [personId]
  );
  if (rows.length === 0) throw new Error(`No Zoho tokens for person_id ${personId}`);

  const { access_token, refresh_token, expires_at } = rows[0];
  const isExpired = new Date(expires_at).getTime() < Date.now() + 60_000;
  if (!isExpired) return access_token;

  const refreshed = await refreshAccessToken(refresh_token);
  await saveTokens(personId, refreshed);
  return refreshed.access_token;
}

module.exports = { getAuthorizationUrl, exchangeCodeForTokens, getMe, saveTokens, getValidAccessToken };
