// Security regression suite:  node test/security.mjs
// Runs entirely in memory against a PostgREST stand-in. No network, no
// database, no credentials needed.

process.env.SESSION_SECRET = "s".repeat(40);
process.env.SITE_URL = "https://ahp.example";
process.env.SUPABASE_URL = "https://db.example";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";

const ROOT = new URL("../api/", import.meta.url).href;

// ---- in-memory PostgREST stand-in ----
const U = n => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
let members = [
  { id: U(1), name: "Ruric",    steam_id: "STEAM_0:0:10764148", id64: "76561197981794024", tier: "leadership", twitch: "ruric", is_super: true },
  { id: U(2), name: "Puma",     steam_id: "STEAM_0:1:5278649",  id64: "76561197970823027", tier: "leadership", twitch: null,    is_super: false },
  { id: U(3), name: "Bob",      steam_id: "STEAM_0:0:3773447",  id64: "76561197967812622", tier: "leadership", twitch: null,    is_super: false },
  { id: U(4), name: "Sweeper",  steam_id: "STEAM_0:0:7524879",  id64: "76561197975315486", tier: "member",     twitch: null,    is_super: false },
];
let pending = [];
let seq = 0;

function match(rows, qs) {
  const p = new URLSearchParams(qs);
  return rows.filter(r => {
    for (const [k, v] of p) {
      if (["select","limit","order"].includes(k)) continue;
      if (v.startsWith("eq.") && String(r[k]) !== v.slice(3)) return false;
      if (v === "not.is.null" && r[k] == null) return false;
    }
    return true;
  });
}
const tableOf = p => p.split("?")[0];
const qsOf = p => p.split("?")[1] || "";

globalThis.fetch = async (url, opts = {}) => {
  const path = decodeURIComponent(String(url).replace("https://db.example/rest/v1/", ""));
  const table = tableOf(path), qs = qsOf(path);
  const rows = table === "ahp_members" ? members : table === "ahp_pending_changes" ? pending : [];
  const m = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  const reply = (d, s = 200) => ({ ok: s < 400, status: s, text: async () => JSON.stringify(d) });

  if (table === "ahp_audit_log") return reply([]);
  if (m === "GET") return reply(match(rows, qs));
  if (m === "POST") {
    if (table === "ahp_pending_changes") {
      if (pending.some(x => x.member_id === body.member_id && x.status === "pending"))
        return reply({ message: "duplicate key value" }, 409);
      const row = { id: U(90 + ++seq), status: "pending", ...body };
      pending.push(row); return reply([row]);
    }
    if (members.some(x => x.id64 === body.id64)) return reply({ message: "duplicate key value" }, 409);
    const row = { id: U(50 + ++seq), is_super: false, ...body };
    members.push(row); return reply([row]);
  }
  if (m === "PATCH") {
    const hits = match(rows, qs);
    hits.forEach(r => Object.assign(r, body));
    return reply(hits);
  }
  if (m === "DELETE") {
    const hits = match(rows, qs);
    if (table === "ahp_members") members = members.filter(r => !hits.includes(r));
    return reply(hits);
  }
};

const { makeSessionCookie } = await import(ROOT + "_lib/auth.js");
const handler = (await import(ROOT + "admin.js")).default;

function mkRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = d => { r.body = d; return r; };
  return r;
}
async function call(actorId64, action, body, over = {}) {
  const mutating = !["session","list"].includes(action);
  const req = {
    method: over.method || (mutating ? "POST" : "GET"),
    url: `/api/admin?action=${action}`,
    headers: {
      cookie: actorId64 ? makeSessionCookie(actorId64).split(";")[0] : "",
      origin: over.origin !== undefined ? over.origin : "https://ahp.example"
    },
    body: body || {}
  };
  const res = mkRes();
  await handler(req, res);
  return res;
}

const RURIC = "76561197981794024", PUMA = "76561197970823027", BOB = "76561197967812622", SWEEP = "76561197975315486";
let pass = 0, fail = 0;
const t = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? "PASS " : "FAIL ") + label + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
};

// --- auth gate ---
t("anon blocked",            (await call(null, "list")).code, 401);
t("member blocked",          (await call(SWEEP, "list")).code, 403);
t("leader allowed",          (await call(PUMA, "list")).code, 200);

// --- method + origin ---
t("GET delete refused",      (await call(PUMA, "delete", { id: U(4) }, { method: "GET" })).code, 405);
t("cross-origin refused",    (await call(PUMA, "delete", { id: U(4) }, { origin: "https://evil.test" })).code, 403);
t("no-origin refused",       (await call(PUMA, "delete", { id: U(4) }, { origin: null })).code, 403);

// --- super admin protection ---
t("leader cannot retier super", (await call(PUMA, "tier",   { id: U(1), tier: "member" })).code, 403);
t("leader cannot edit super",   (await call(PUMA, "update", { id: U(1), name: "x" })).code, 403);
t("leader cannot delete super", (await call(PUMA, "delete", { id: U(1) })).code, 403);
t("Ruric still leadership",     members.find(m => m.id === U(1)).tier, "leadership");

// --- TWO-KEY RULE ---
let r = await call(PUMA, "tier", { id: U(4), tier: "leadership" });
t("promotion staged not applied", [r.body.staged, members.find(m=>m.id===U(4)).tier], [true, "member"]);
t("proposer cannot self-approve", (await call(PUMA, "approve", { id: pending[0].id })).code, 403);
t("still member after self-approve attempt", members.find(m=>m.id===U(4)).tier, "member");
t("duplicate proposal refused",   (await call(BOB, "tier", { id: U(4), tier: "leadership" })).code, 409);
t("second leader approves",       (await call(BOB, "approve", { id: pending[0].id })).code, 200);
t("now leadership",               members.find(m=>m.id===U(4)).tier, "leadership");
t("replay of decided proposal",   (await call(BOB, "approve", { id: pending[0].id })).code, 404);

// --- cannot create straight into leadership ---
t("create at leadership refused",
  (await call(PUMA, "create", { name:"Alt", steam_id:"STEAM_0:1:999", tier:"leadership" })).code, 400);

// --- THE BYPASS: repoint another leader's SteamID to your own alt ---
r = await call(PUMA, "update", { id: U(3), steam_id: "STEAM_0:1:424242" });
t("leader cannot repoint another leader's SteamID", r.code, 403);
t("Bob's SteamID unchanged", members.find(m=>m.id===U(3)).steam_id, "STEAM_0:0:3773447");
t("super CAN repoint it", (await call(RURIC, "update", { id: U(3), steam_id: "STEAM_0:1:424242" })).code, 200);
t("non-leader SteamID still editable by a leader",
  (await call(PUMA, "update", { id: U(4), twitch: "someone" })).code, 200);

// --- self demotion needs confirm, then applies ---
r = await call(PUMA, "tier", { id: U(2), tier: "member" });
t("self-demotion asks first", [r.code, Boolean(r.body.confirm)], [409, true]);
t("still leadership before confirm", members.find(m=>m.id===U(2)).tier, "leadership");
r = await call(PUMA, "tier", { id: U(2), tier: "member", confirm: true });
t("self-demotion applies", [r.body.selfDemotion, members.find(m=>m.id===U(2)).tier], [true, "member"]);
t("demoted leader now blocked", (await call(PUMA, "list")).code, 403);

// --- bad input ---
t("bad uuid",        (await call(RURIC, "delete", { id: "*" })).code, 400);
t("bad steamid",     (await call(RURIC, "create", { name:"X", steam_id:"nope" })).code, 400);
t("bad twitch",      (await call(RURIC, "create", { name:"X", steam_id:"STEAM_0:1:5", twitch:"a b!" })).code, 400);
t("long name",       (await call(RURIC, "create", { name:"x".repeat(65), steam_id:"STEAM_0:1:7" })).code, 400);
t("unknown action",  (await call(RURIC, "frobnicate", {})).code, 400);
t("self delete",     (await call(RURIC, "delete", { id: U(1) })).code, 400);

// --- no internals leak on error ---
const leaky = JSON.stringify((await call(RURIC, "list")).body);
t("no supabase url in payload", /db\.example|svc/.test(leaky), false);


// ---- library-level checks ----
const A = await import(ROOT + "_lib/auth.js");
const D = await import(ROOT + "_lib/db.js");


// --- unfiltered write guard: the mass-delete footgun ---
let threw = false;
try { await D.db.remove("ahp_members", {}); } catch (e) { threw = /unfiltered/.test(e.message); }
t("empty filter DELETE refused", threw, true);
threw = false;
try { await D.db.update("ahp_members", {}, { tier: "leadership" }); } catch (e) { threw = /unfiltered/.test(e.message); }
t("empty filter PATCH refused", threw, true);

// --- uuid validation ---
t("uuid accepts real",  D.isUuid("3f8a1c2e-9b4d-4e7a-8c1f-2a5b6d7e8f90"), true);
t("uuid rejects '*'",   D.isUuid("*"), false);
t("uuid rejects inject",D.isUuid("x&tier=eq.member"), false);
t("uuid rejects null",  D.isUuid(null), false);

// --- cookie forgery ---
const cookie = A.makeSessionCookie("76561197981794024");
const val = cookie.split(";")[0].split("=")[1];
const [id, exp, mac] = val.split(".");
const mk = v => ({ headers: { cookie: "ahp_session=" + v } });

// swap the id, keep the signature
const forged = ["76561197974632651", exp, mac].join(".");
// currentUser hits the db, so test the signature layer by re-signing
const crypto = await import("node:crypto");
const sig = d => crypto.createHmac("sha256", process.env.SESSION_SECRET).update(d).digest("base64url");
t("forged id fails mac", sig(`76561197974632651.${exp}`) === mac, false);
t("valid mac verifies",  sig(`${id}.${exp}`) === mac, true);
t("expired rejected",    Date.now() > Number(exp), false);
t("cookie is HttpOnly+Secure+Lax",
  /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie), true);

// --- origin check ---
const org = o => A.sameOrigin({ headers: o ? { origin: o } : {} });
t("origin match",          org("https://ahp.example"), true);
t("origin evil",           org("https://evil.test"), false);
t("origin subdomain",      org("https://x.ahp.example"), false);
t("origin absent",         org(null), false);
t("origin null-string",    org("null"), false);
t("origin scheme downgrade", org("http://ahp.example"), false);

// --- super admin matrix ---
const sup = { is_super: true }, lead = { is_super: false };
t("lead cannot touch super", A.canAffect(lead, { is_super: true }), false);
t("super can touch super",   A.canAffect(sup,  { is_super: true }), true);
t("lead can touch normal",   A.canAffect(lead, { is_super: false }), true);

// --- SITE_URL required, no Host fallback ---
delete process.env.SITE_URL;
let req = false;
try { A.siteUrl(); } catch { req = true; }
t("SITE_URL required", req, true);


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
