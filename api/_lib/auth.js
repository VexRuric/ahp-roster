// Session cookie, origin checks and permission rules.
//
// The cookie carries only a SteamID64 and an expiry, signed with HMAC-SHA256.
// Rank is deliberately NOT in the cookie: it is read from the database on
// every request, so a leader demoted to member loses admin access on their
// very next action instead of whenever their cookie happens to expire.

import crypto from "node:crypto";
import { db } from "./db.js";

const COOKIE = "ahp_session";
const MAX_AGE = 60 * 60 * 24 * 7; // one week

export function siteUrl() {
  // Required, and never derived from the Host header: a forged Host would let
  // an attacker point Steam's OpenID return_to at a site they control.
  const s = process.env.SITE_URL;
  if (!s) throw new Error("SITE_URL is not set");
  return s.replace(/\/$/, "");
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return s;
}

const sign = data => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

export function makeSessionCookie(id64) {
  const payload = `${id64}.${Date.now() + MAX_AGE * 1000}`;
  return [
    `${COOKIE}=${payload}.${sign(payload)}`,
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${MAX_AGE}`
  ].join("; ");
}

export const clearSessionCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(req) {
  const hit = (req.headers.cookie || "")
    .split(";").map(c => c.trim())
    .find(c => c.startsWith(COOKIE + "="));
  if (!hit) return null;

  const [id64, expires, mac] = hit.slice(COOKIE.length + 1).split(".");
  if (!id64 || !expires || !mac) return null;
  if (!/^\d{17}$/.test(id64)) return null;

  const a = Buffer.from(mac);
  const b = Buffer.from(sign(`${id64}.${expires}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expires)) return null;

  return id64;
}

export async function currentUser(req) {
  const id64 = readCookie(req);
  if (!id64) return null;
  return db.find("ahp_members", { id64 }, "id,name,id64,tier,is_super");
}

// Cross-site writes. SameSite=Lax already withholds the cookie from a
// cross-origin POST; this is the belt to that braces, and it also blocks a
// same-site subdomain that an attacker might control.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(siteUrl()).origin;
  } catch {
    return false;
  }
}

// Super admins can only be touched by another super admin.
export const canAffect = (actor, target) => !target.is_super || Boolean(actor.is_super);

export const TIERS = ["leadership", "management", "member", "legend"];
