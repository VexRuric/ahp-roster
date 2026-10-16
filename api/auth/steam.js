// Steam sign-in and sign-out.
//
//   GET /api/auth/steam             -> redirect to Steam
//   GET /api/auth/steam?openid...   -> Steam's return leg, verified, cookied
//   GET /api/auth/logout            -> clears the cookie (rewritten here)
//
// Steam has no OAuth. OpenID 2.0 is all it supports, and it proves exactly
// one thing: the SteamID64 of whoever signed in. Rank always comes from our
// own table, never from Steam.

import { makeSessionCookie, clearSessionCookie, siteUrl } from "../_lib/auth.js";
import { db, configured } from "../_lib/db.js";

const STEAM_OP = "https://steamcommunity.com/openid/login";

const bounce = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

export default async function handler(req, res) {
  let base;
  try {
    base = siteUrl();
    if (!configured()) throw new Error("database not configured");
  } catch {
    return bounce(res, "/admin.html?error=misconfigured");
  }

  const url = new URL(req.url, base);

  if (url.pathname.endsWith("/logout")) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    return bounce(res, "/admin.html");
  }

  // Outbound leg.
  if (!url.searchParams.get("openid.mode")) {
    const params = new URLSearchParams({
      "openid.ns": "http://specs.openid.net/auth/2.0",
      "openid.mode": "checkid_setup",
      "openid.return_to": `${base}/api/auth/steam`,
      "openid.realm": base,
      "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
      "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
    });
    return bounce(res, `${STEAM_OP}?${params}`);
  }

  const p = url.searchParams;

  // The assertion must come from Steam itself, and claimed_id must be one of
  // the fields Steam signed. Without that check an unsigned claimed_id could
  // be swapped for any account's.
  if (p.get("openid.op_endpoint") !== STEAM_OP) {
    return bounce(res, "/admin.html?error=bad_assertion");
  }
  const signed = (p.get("openid.signed") || "").split(",");
  if (!signed.includes("claimed_id") || !signed.includes("identity")) {
    return bounce(res, "/admin.html?error=bad_assertion");
  }
  // return_to is signed by Steam; confirming it is ours stops an assertion
  // minted for another site being replayed here.
  if (p.get("openid.return_to") !== `${base}/api/auth/steam`) {
    return bounce(res, "/admin.html?error=bad_assertion");
  }

  // Ask Steam to confirm rather than trusting the query string.
  const verify = new URLSearchParams(url.search);
  verify.set("openid.mode", "check_authentication");

  let body;
  try {
    const r = await fetch(STEAM_OP, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: verify.toString(),
      signal: AbortSignal.timeout(10000)
    });
    body = await r.text();
  } catch {
    return bounce(res, "/admin.html?error=steam_unreachable");
  }

  if (!/^is_valid\s*:\s*true$/m.test(body)) {
    return bounce(res, "/admin.html?error=bad_assertion");
  }

  const match = (p.get("openid.claimed_id") || "")
    .match(/^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  if (!match) return bounce(res, "/admin.html?error=no_steamid");

  // Anyone may attempt sign-in; only roster members get a session.
  let member;
  try {
    member = await db.find("members", { id64: match[1] }, "id");
  } catch {
    return bounce(res, "/admin.html?error=misconfigured");
  }
  if (!member) return bounce(res, "/admin.html?error=not_a_member");

  res.setHeader("Set-Cookie", makeSessionCookie(match[1]));
  return bounce(res, "/admin.html");
}
