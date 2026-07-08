/*
 * Access-token manager.
 * Zoho access tokens expire in ~1 hour, so we exchange the long-lived refresh
 * token for a fresh access token and cache it until shortly before expiry.
 */
const DC = process.env.ZOHO_DC || "in";
const ACCOUNTS_HOST = `https://accounts.zoho.${DC}`;

let cached = { token: null, expiresAt: 0 };

export async function getAccessToken() {
  const now = Date.now();
  // Reuse the cached token until 2 minutes before it expires.
  if (cached.token && now < cached.expiresAt - 120000) {
    return cached.token;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token?${params.toString()}`, {
    method: "POST",
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const msg = data.error || `token refresh failed (HTTP ${res.status})`;
    throw new Error(`Zoho token error: ${msg}`);
  }

  cached = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
  };
  return cached.token;
}
