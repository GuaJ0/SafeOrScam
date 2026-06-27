// SafeSell — minimal Supabase REST client for the background service worker.
// Avoids importing the full SDK which doesn't work in MV3 service workers.

// ⚠️  Fill these in after creating your Supabase project.
const SUPABASE_URL = "https://gksitdxhpikvwffyazou.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_rbjlddjWaSgkgN2_Iv2CJQ_0V7WKGBq";

async function getSupabaseConfig() {
  const stored = await chrome.storage.local.get(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  return {
    url: (stored.SUPABASE_URL || SUPABASE_URL || "").trim(),
    key: (stored.SUPABASE_ANON_KEY || SUPABASE_ANON_KEY || "").trim(),
  };
}

async function getSession() {
  const stored = await chrome.storage.local.get(["safesell_access_token", "safesell_refresh_token", "safesell_user"]);
  return {
    accessToken: stored.safesell_access_token || null,
    refreshToken: stored.safesell_refresh_token || null,
    user: stored.safesell_user || null,
  };
}

async function saveSession({ accessToken, refreshToken, user }) {
  await chrome.storage.local.set({
    safesell_access_token: accessToken,
    safesell_refresh_token: refreshToken,
    safesell_user: user,
  });
}

async function clearSession() {
  await chrome.storage.local.remove([
    "safesell_access_token",
    "safesell_refresh_token",
    "safesell_user",
  ]);
}

// Exchange an OAuth code for a Supabase session using PKCE.
// Called after chrome.identity.launchWebAuthFlow returns the redirect URL.
async function exchangeCodeForSession(code) {
  const { url, key } = await getSupabaseConfig();
  const codeVerifier = await chrome.storage.local.get("safesell_code_verifier");

  const res = await fetch(`${url}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ auth_code: code, code_verifier: codeVerifier.safesell_code_verifier }),
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const data = await res.json();
  await saveSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: data.user,
  });
  return data.user;
}

// Refresh an expired access token.
async function refreshSession() {
  const { url, key } = await getSupabaseConfig();
  const { refreshToken } = await getSession();
  if (!refreshToken) throw new Error("No refresh token");

  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) { await clearSession(); throw new Error("Session expired"); }
  const data = await res.json();
  await saveSession({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: data.user,
  });
  return data.access_token;
}

// Authenticated fetch — auto-refreshes token on 401.
async function authFetch(path, options = {}) {
  const { url, key } = await getSupabaseConfig();
  let { accessToken } = await getSession();
  if (!accessToken) throw new Error("Not signed in");

  const makeReq = (token) =>
    fetch(`${url}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${token}`,
        Prefer: "return=representation",
        ...(options.headers || {}),
      },
    });

  let res = await makeReq(accessToken);
  if (res.status === 401) {
    accessToken = await refreshSession();
    res = await makeReq(accessToken);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Votes API
// ---------------------------------------------------------------------------

// Upsert the current user's vote for a listing.
async function submitVote(listingUrl, verdict, comment) {
  const { user } = await getSession();
  if (!user) throw new Error("Not signed in");

  const meta = user.user_metadata || {};
  const displayName = meta.full_name || meta.name || user.email?.split("@")[0] || "Anonymous";
  const avatarUrl = meta.avatar_url || meta.picture || null;

  const res = await authFetch("/rest/v1/votes?on_conflict=user_id,listing_url", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      listing_url: listingUrl,
      user_id: user.id,
      verdict,
      comment: comment || null,
      display_name: displayName,
      avatar_url: avatarUrl,
    }),
  });
  if (!res.ok) throw new Error(`Vote failed: ${await res.text()}`);
  return res.json();
}

// Get community vote counts + the current user's vote for a listing.
async function getVotes(listingUrl) {
  const { url, key } = await getSupabaseConfig();
  const { accessToken, user } = await getSession();

  const encoded = encodeURIComponent(listingUrl);

  // Use the public anon key for reading (no auth needed if RLS allows it).
  const headers = {
    "Content-Type": "application/json",
    apikey: key,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };

  const res = await fetch(
    `${url}/rest/v1/votes?listing_url=eq.${encoded}&select=verdict,comment,user_id,display_name,avatar_url,created_at`,
    { headers }
  );
  if (!res.ok) throw new Error(`Fetch votes failed: ${await res.text()}`);
  const rows = await res.json();

  const safeCount = rows.filter((r) => r.verdict === "safe").length;
  const scamCount = rows.filter((r) => r.verdict === "scam").length;
  const total = safeCount + scamCount;
  const safePercent = total > 0 ? Math.round((safeCount / total) * 100) : null;

  const comments = rows
    .filter((r) => r.comment)
    .slice(-5)
    .map((r) => ({
      comment: r.comment,
      verdict: r.verdict,
      displayName: r.display_name || "Anonymous",
      avatarUrl: r.avatar_url || null,
    }));
  const myVote = user ? rows.find((r) => r.user_id === user.id) : null;

  return { safeCount, scamCount, safePercent, total, comments, myVote: myVote?.verdict || null };
}

// Generate a random code verifier for PKCE.
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Derive a code challenge from the verifier (S256).
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Build the Supabase Google OAuth URL using PKCE.
async function buildGoogleAuthUrl() {
  const { url, key } = await getSupabaseConfig();
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  await chrome.storage.local.set({ safesell_code_verifier: verifier });

  // Use the canonical redirect URL that launchWebAuthFlow watches for. This is
  // `https://<extension-id>.chromiumapp.org/` and MUST be added to Supabase's
  // Auth → URL Configuration → Redirect URLs allowlist, otherwise Supabase
  // falls back to the project Site URL after the Google callback and the auth
  // window fails with "Authorization page could not be loaded."
  const redirectUri =
    chrome.identity && chrome.identity.getRedirectURL
      ? chrome.identity.getRedirectURL()
      : `https://${chrome.runtime.id}.chromiumapp.org/`;
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${url}/auth/v1/authorize?${params}`;
}
