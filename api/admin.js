// Every admin action, dispatched on ?action= so the project stays inside a
// small serverless function budget.
//
//   GET  ?action=session   who am I, and what may I do
//   GET  ?action=list      roster plus open proposals
//   POST ?action=create    add a member
//   POST ?action=update    rename, change SteamID, change Twitch
//   POST ?action=tier      change tier (leadership promotions get staged)
//   POST ?action=approve   a second leader signs off
//   POST ?action=reject    a second leader throws one out
//   POST ?action=delete    remove a member
//
// Rules enforced here rather than in the browser, because the browser is not
// a security boundary:
//   - the caller must hold the leadership tier right now, read fresh per call
//   - super admins can only be touched by another super admin
//   - promoting anyone INTO leadership needs a second, different leader
//   - a leadership member's SteamID can only be changed by themselves or a
//     super admin, since repointing it would hand one person two leader logins
//     and defeat the two-key rule
//   - mutations must be POST and same-origin

import { db, audit, configured, isUuid } from "./_lib/db.js";
import { currentUser, canAffect, sameOrigin, TIERS } from "./_lib/auth.js";

const STEAM_RE = /^STEAM_[01]:[01]:\d{1,12}$/;
const TWITCH_RE = /^[A-Za-z0-9_]{3,25}$/;
const MAX_NAME = 64;

const READ_ACTIONS = new Set(["session", "list"]);
const ACTIONS = new Set([...READ_ACTIONS, "create", "update", "tier", "approve", "reject", "delete"]);

const toId64 = sid => {
  const [, y, z] = sid.split(":");
  return (76561197960265728n + BigInt(z) * 2n + BigInt(y)).toString();
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error("body too large");
  }
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

const bad = (res, code, error) => res.status(code).json({ error });

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!configured()) return bad(res, 500, "Database is not configured.");

  const action = new URL(req.url, "http://localhost").searchParams.get("action");
  if (!ACTIONS.has(action)) return bad(res, 400, "Unknown action.");

  const mutating = !READ_ACTIONS.has(action);
  if (mutating) {
    if (req.method !== "POST") return bad(res, 405, "This action requires POST.");
    if (!sameOrigin(req)) return bad(res, 403, "Cross-site request refused.");
  } else if (req.method !== "GET") {
    return bad(res, 405, "This action requires GET.");
  }

  try {
    const user = await currentUser(req);
    if (!user) return bad(res, 401, "Not signed in.");
    if (user.tier !== "leadership") return bad(res, 403, "Leadership access required.");

    const b = mutating ? await readBody(req) : {};

    // Every mutating action addresses a row by uuid.
    const needsId = ["update", "tier", "approve", "reject", "delete"].includes(action);
    if (needsId && !isUuid(b.id)) return bad(res, 400, "Bad id.");

    switch (action) {
      case "session":
        return res.status(200).json({
          name: user.name, id64: user.id64, tier: user.tier, isSuper: user.is_super
        });

      case "list": {
        const [members, open] = await Promise.all([
          db.select("members", "select=id,name,steam_id,id64,tier,twitch,is_super&order=name.asc"),
          db.select("pending_changes",
            "status=eq.pending&select=id,member_id,proposed_tier,requested_by,requested_at")
        ]);
        const nameOf = Object.fromEntries(members.map(m => [m.id64, m.name]));
        const byId = Object.fromEntries(members.map(m => [m.id, m.name]));
        return res.status(200).json({
          members,
          pending: open.map(p => ({
            id: p.id,
            member_name: byId[p.member_id] || "(removed)",
            requested_by_name: nameOf[p.requested_by] || "a former leader",
            // Computed server-side so the browser is not trusted to hide the
            // proposer's own Approve button.
            mine: p.requested_by === user.id64
          }))
        });
      }

      case "create": {
        const name = String(b.name ?? "").trim();
        const sid = String(b.steam_id ?? "").trim().toUpperCase();
        const twitch = String(b.twitch ?? "").trim();
        const tier = b.tier ?? "member";

        if (!name || name.length > MAX_NAME) return bad(res, 400, `Name must be 1 to ${MAX_NAME} characters.`);
        if (!STEAM_RE.test(sid)) return bad(res, 400, "SteamID must look like STEAM_0:1:12345.");
        if (!TIERS.includes(tier)) return bad(res, 400, "Unknown tier.");
        if (twitch && !TWITCH_RE.test(twitch)) return bad(res, 400, "Twitch handle looks wrong.");
        // Creating straight into leadership would route around the two-key rule.
        if (tier === "leadership") {
          return bad(res, 400, "Add the member first, then propose leadership.");
        }

        try {
          const [row] = await db.insert("members", {
            name, steam_id: sid, id64: toId64(sid), tier, twitch: twitch || null
          });
          await audit(user.id64, "create", name, { tier, sid });
          return res.status(200).json({ ok: true, member: row });
        } catch (e) {
          if (e.duplicate) return bad(res, 409, "That SteamID is already on the roster.");
          throw e;
        }
      }

      case "update": {
        const target = await db.find("members", { id: b.id });
        if (!target) return bad(res, 404, "Member not found.");
        if (!canAffect(user, target)) {
          return bad(res, 403, `${target.name} can only be edited by a super admin.`);
        }

        const patch = {};
        if (b.name !== undefined) {
          const name = String(b.name).trim();
          if (!name || name.length > MAX_NAME) return bad(res, 400, `Name must be 1 to ${MAX_NAME} characters.`);
          if (name !== target.name) patch.name = name;
        }
        if (b.twitch !== undefined) {
          const tw = String(b.twitch).trim();
          if (tw && !TWITCH_RE.test(tw)) return bad(res, 400, "Twitch handle looks wrong.");
          if ((tw || null) !== target.twitch) patch.twitch = tw || null;
        }
        if (b.steam_id !== undefined) {
          const sid = String(b.steam_id).trim().toUpperCase();
          if (!STEAM_RE.test(sid)) return bad(res, 400, "SteamID must look like STEAM_0:1:12345.");
          if (sid !== target.steam_id) {
            // Repointing a leader's SteamID at another account would give one
            // person a second leadership login, and with it both halves of the
            // two-key approval.
            const self = target.id64 === user.id64;
            if (target.tier === "leadership" && !self && !user.is_super) {
              return bad(res, 403, "A leader's SteamID can only be changed by that leader or a super admin.");
            }
            patch.steam_id = sid;
            patch.id64 = toId64(sid);
          }
        }

        if (!Object.keys(patch).length) return bad(res, 400, "Nothing to change.");

        const signsMeOut = patch.id64 && target.id64 === user.id64;
        if (signsMeOut && !b.confirm) {
          return res.status(409).json({
            confirm: "This is your own account. Changing your SteamID signs you out. Continue?"
          });
        }

        try {
          await db.update("members", { id: target.id }, patch);
        } catch (e) {
          if (e.duplicate) return bad(res, 409, "Another member already has that SteamID.");
          throw e;
        }
        await audit(user.id64, "update", target.name, Object.keys(patch));
        return res.status(200).json({ ok: true, signedOut: Boolean(signsMeOut) });
      }

      case "tier": {
        const target = await db.find("members", { id: b.id });
        if (!target) return bad(res, 404, "Member not found.");
        if (!TIERS.includes(b.tier)) return bad(res, 400, "Unknown tier.");
        if (!canAffect(user, target)) {
          return bad(res, 403, `${target.name} can only be changed by a super admin.`);
        }
        if (target.tier === b.tier) return bad(res, 400, `${target.name} is already ${b.tier}.`);

        // Promotions into leadership wait for a second leader.
        if (b.tier === "leadership") {
          try {
            await db.insert("pending_changes", {
              member_id: target.id, proposed_tier: "leadership", requested_by: user.id64
            });
          } catch (e) {
            // The unique partial index allows one open proposal per member.
            if (e.duplicate) return bad(res, 409, "A promotion for this member is already waiting.");
            throw e;
          }
          await audit(user.id64, "propose_leadership", target.name, null);
          return res.status(200).json({
            ok: true, staged: true,
            message: `Proposed. A second leader other than you must approve before ${target.name} gains access.`
          });
        }

        const selfDemotion = target.id64 === user.id64;
        if (selfDemotion && !b.confirm) {
          return res.status(409).json({
            confirm: "This removes your own admin access immediately. Continue?"
          });
        }

        await db.update("members", { id: target.id }, { tier: b.tier });
        // A member who just moved tier cannot be left holding an open proposal.
        await db.update(
          "pending_changes", { member_id: target.id },
          { status: "rejected", decided_by: user.id64, decided_at: new Date().toISOString() },
          "&status=eq.pending"
        );
        await audit(user.id64, "tier", target.name, { from: target.tier, to: b.tier });
        return res.status(200).json({ ok: true, selfDemotion });
      }

      case "approve": {
        const p = await db.find("pending_changes", { id: b.id });
        if (!p || p.status !== "pending") return bad(res, 404, "That proposal is no longer open.");
        if (p.requested_by === user.id64) {
          return bad(res, 403, "A second leader has to approve. You proposed this one.");
        }

        const target = await db.find("members", { id: p.member_id });
        if (!target) return bad(res, 404, "Member no longer exists.");
        if (!canAffect(user, target)) {
          return bad(res, 403, `${target.name} can only be changed by a super admin.`);
        }

        // Guarded so a double click cannot apply the same proposal twice.
        const closed = await db.update(
          "pending_changes", { id: p.id },
          { status: "approved", decided_by: user.id64, decided_at: new Date().toISOString() },
          "&status=eq.pending"
        );
        if (!closed || !closed.length) return bad(res, 409, "That proposal was just decided.");

        await db.update("members", { id: target.id }, { tier: p.proposed_tier });
        await audit(user.id64, "approve_leadership", target.name, { proposed_by: p.requested_by });
        return res.status(200).json({ ok: true });
      }

      case "reject": {
        const closed = await db.update(
          "pending_changes", { id: b.id },
          { status: "rejected", decided_by: user.id64, decided_at: new Date().toISOString() },
          "&status=eq.pending"
        );
        if (!closed || !closed.length) return bad(res, 404, "That proposal is no longer open.");
        await audit(user.id64, "reject_leadership", null, { proposal: b.id });
        return res.status(200).json({ ok: true });
      }

      case "delete": {
        const target = await db.find("members", { id: b.id });
        if (!target) return bad(res, 404, "Member not found.");
        if (!canAffect(user, target)) {
          return bad(res, 403, `${target.name} can only be removed by a super admin.`);
        }
        if (target.id64 === user.id64) return bad(res, 400, "You cannot delete your own account.");

        await db.remove("members", { id: target.id });
        await audit(user.id64, "delete", target.name, { tier: target.tier, sid: target.steam_id });
        return res.status(200).json({ ok: true });
      }
    }
  } catch (err) {
    // Logged for the operator, never returned: the message carries the
    // database URL and raw PostgREST output.
    console.error("admin:" + action, err);
    return bad(res, 500, "Server error. Check the function logs.");
  }
}
