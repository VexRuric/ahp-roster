// Twitch live status: GET /api/live.
// Credentials stay server-side. The client ID is a public identifier that
// Twitch exposes in every browser request, so it ships as a default; the
// secret must come from the environment.

import { db, configured } from "./_lib/db.js";

const DEFAULT_CLIENT_ID = "faoym263xw5nbo3ohbjdg21pslkog1";
const CACHE_MS = 60_000;

// Held in module scope, which survives while an instance stays warm.
let token = { value: null, expiresAt: 0 };
let cache = { at: 0, payload: null };

// Channels come from the roster, so a handle edited in the admin page takes
// effect without a redeploy. Capped at Helix's 100-login limit per request.
async function channels() {
  const rows = await db.select("members", "twitch=not.is.null&select=twitch");
  return [...new Set(rows.map(r => String(r.twitch).toLowerCase()).filter(Boolean))].slice(0, 100);
}

async function getToken(clientId, clientSecret) {
  if (token.value && Date.now() < token.expiresAt) return token.value;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials"
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error("twitch token " + res.status);

  const data = await res.json();
  // Refresh a minute early rather than racing the expiry.
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

async function fetchStreams(clientId, accessToken, logins) {
  const qs = logins.map(c => "user_login=" + encodeURIComponent(c)).join("&");
  const res = await fetch("https://api.twitch.tv/helix/streams?" + qs, {
    headers: { "Client-Id": clientId, Authorization: "Bearer " + accessToken },
    signal: AbortSignal.timeout(10000)
  });

  if (res.status === 401) {
    token = { value: null, expiresAt: 0 }; // force re-auth next call
    throw new Error("twitch unauthorized");
  }
  if (!res.ok) throw new Error("twitch helix " + res.status);

  const { data = [] } = await res.json();
  return data
    .filter(s => s.type === "live")
    .map(s => ({
      login: (s.user_login || "").toLowerCase(),
      display: s.user_name,
      title: s.title,
      game: s.game_name,
      viewers: s.viewer_count,
      startedAt: s.started_at,
      thumbnail: (s.thumbnail_url || "").replace("{width}", "320").replace("{height}", "180")
    }))
    .sort((a, b) => b.viewers - a.viewers);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only." });

  const clientId = process.env.TWITCH_CLIENT_ID || DEFAULT_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientSecret) return res.status(500).json({ error: "TWITCH_CLIENT_SECRET is not set." });
  if (!configured()) return res.status(500).json({ error: "Database is not configured." });

  const fresh = payload => {
    cache = { at: Date.now(), payload };
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json(payload);
  };

  if (cache.payload && Date.now() - cache.at < CACHE_MS) {
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ ...cache.payload, cached: true });
  }

  try {
    const logins = await channels();
    if (!logins.length) return fresh({ live: [], checkedAt: new Date().toISOString() });

    const accessToken = await getToken(clientId, clientSecret);
    const live = await fetchStreams(clientId, accessToken, logins);
    return fresh({ live, checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("live", err);
    // A stale answer beats an empty panel.
    if (cache.payload) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ...cache.payload, stale: true });
    }
    return res.status(502).json({ error: "Could not reach Twitch." });
  }
}
