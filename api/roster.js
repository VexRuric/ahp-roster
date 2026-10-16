// Public roster feed: GET /api/roster -> { tiers: { leadership: [...], ... } }
// SteamIDs are public identifiers and the page needs id64 to build profile
// links, so both ship. Nothing else from the table does.

import { db, configured } from "./_lib/db.js";

const ORDER = ["leadership", "management", "member", "legend"];

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only." });
  if (!configured()) return res.status(500).json({ error: "Database is not configured." });

  try {
    const rows = await db.select("ahp_members", "select=name,steam_id,id64,tier,twitch");

    const tiers = Object.fromEntries(ORDER.map(t => [t, []]));
    for (const r of rows) {
      if (!tiers[r.tier]) continue;
      tiers[r.tier].push({
        name: r.name, sid: r.steam_id, id64: r.id64, twitch: r.twitch || null
      });
    }
    // Case-insensitive, so lowercase handles do not sort to the bottom.
    const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    for (const t of ORDER) tiers[t].sort(byName);

    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({ tiers, total: rows.length });
  } catch (err) {
    console.error("roster", err);
    return res.status(500).json({ error: "Could not load the roster." });
  }
}
