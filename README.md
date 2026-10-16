# (-AHP-) After Hours Pub roster

Roster site with Twitch live status, Discord widget, and a Steam-authenticated
admin page. The roster lives in a database, so edits are immediate and never
require a redeploy.

```
index.html          public roster, reads /api/roster at load
admin.html          leadership admin, Steam sign-in
style.css           shared by both pages
vercel.json         security headers, /api/auth/logout rewrite
schema.sql          run once
seed.sql            the 190 current members, run once
api/roster.js       public roster feed
api/live.js         Twitch live status
api/admin.js        every admin action
api/auth/steam.js   Steam OpenID sign-in and sign-out
api/_lib/db.js      PostgREST client (service role, server only)
api/_lib/auth.js    session cookie, origin and permission checks
test/security.mjs   regression suite, `node test/security.mjs`
```

No npm dependencies and no build step. Everything is plain ESM against
`fetch`. Files under `api/_lib/` start with an underscore, so Vercel does not
publish them as endpoints.

## 0. Repository

This is a Git repository with CI already wired up. To put it on GitHub:

```
gh repo create ahp-roster --private --source=. --push
```

Pushing to `main` deploys to production once the Vercel project is linked to
the repo. Pull requests get their own preview URL, and GitHub Actions runs
`test/security.mjs` plus a secret scan on every push.

One caveat on previews: `SITE_URL` is a single value, so Steam sign-in on a
preview deployment redirects back to production. Previews are fine for
checking the roster and the live panel; test admin changes on production or
give the Preview environment its own `SITE_URL`.

Secrets live in Vercel's Environment Variables and in `.env.local` for local
work, never in the repo. `.env.example` lists what is needed.

## 1. Database

Create a Supabase project. In the SQL editor, run `schema.sql`, then `seed.sql`.
Both are safe to re-run: the seed uses `on conflict do nothing`.

From Project Settings, API, collect the project URL and the **service role**
key. The service role key bypasses row-level security and must only ever live
in Vercel's environment variables. It is never sent to a browser.

## 2. Twitch application

At https://dev.twitch.tv/console/apps, register an app. Client Type must be
**Confidential** or the client credentials grant will not work. The client ID
`faoym263xw5nbo3ohbjdg21pslkog1` is already in `api/live.js`; generate a secret
and keep it for the next step.

## 3. Deploy

```
vercel
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add SESSION_SECRET          # 40+ random chars: openssl rand -base64 48
vercel env add TWITCH_CLIENT_SECRET
vercel env add SITE_URL                # https://your-domain, no trailing slash
vercel --prod
```

`SITE_URL` is required, not optional. The OpenID return URL and the
cross-site origin check both derive from it, and it is deliberately never
read from the `Host` header, since a forged Host would otherwise let someone
redirect the Steam login to a site they control. On a custom domain set it to
that domain, not the `.vercel.app` alias.

## 4. Verify

- `node test/security.mjs` prints 53 passes. It runs offline against an
  in-memory stand-in, so it needs no database and no keys.
- `/api/roster` returns JSON with four tiers.
- `/` renders the roster.
- `/admin.html` shows a Steam sign-in button; signing in as a leadership
  member lands on the admin screen, and signing in as anyone else says the
  account is not on the roster.

## Permissions

Admin access is the leadership tier, read fresh from the database on every
single request. Rank is not stored in the session cookie, so a demotion takes
effect on the demoted person's next click rather than whenever their cookie
expires. A leader who sets their own tier to member is warned, then loses
access on save, exactly as asked.

**Super admins** are Ruric, Guinness, Devilman and Nachoman, flagged
`is_super` in the table. They cannot be edited, retiered or deleted by anyone
who is not themselves a super admin. The admin page greys those controls out,
and the API rejects the request independently, so a crafted request does not
get through.

**Promotion into leadership takes two leaders.** The first proposes, which
writes a row to `pending_changes` and changes nothing else. A second leader,
who must be a different person, approves it; only then does the tier change.
The proposer's own Approve button is disabled and the API enforces the same
rule. A unique partial index allows only one open proposal per member.

Demotions, moves between management, member and legend, profile edits and
deletions all apply immediately. New members cannot be created directly into
leadership, since that would route around the two-leader rule: add them, then
propose.

A leadership member's SteamID can only be changed by that member or by a
super admin. Without that rule one leader could repoint another leader's
SteamID at an account they own, hold two leadership logins, and supply both
halves of the two-key approval themselves.

Every write lands in `audit_log` with the actor's SteamID64.

## What the server refuses

The browser is not a security boundary, so each of these is enforced in
`api/admin.js` regardless of what the page sends:

- Writes must be `POST` and must carry a same-origin `Origin` header. A
  mutating `GET` is rejected, so a link in a Discord message can never
  delete a member.
- The session cookie is HMAC-signed, `HttpOnly`, `Secure` and `SameSite=Lax`,
  and carries only a SteamID64 and an expiry. Rank is never in the cookie.
- Every row is addressed by a validated UUID, and database filters are built
  from objects rather than interpolated strings, so a value cannot introduce
  a second PostgREST condition. An unfiltered `PATCH` or `DELETE` throws
  rather than touching every row.
- Steam's assertion is verified with `check_authentication`, and the reply is
  rejected unless it came from Steam's own endpoint, listed `claimed_id` and
  `identity` among the signed fields, and carried our own `return_to`.
- Error responses are generic. The underlying message names the database URL
  and the raw PostgREST output, so it goes to the function log instead.
- `admin.html` is served `X-Frame-Options: DENY` and a frame-ancestors CSP,
  which stops a hidden frame tricking a leader into clicking Approve.

## Twitch handles

`api/live.js` reads channels from the `twitch` column, so adding a streamer in
the admin page is enough. There is no second list to maintain.

## Notes

The Discord widget needs Server Settings, Widget, Enable Server Widget turned
on for guild 632488035983949856, or the iframe will not render.

Steam has no OAuth. OpenID 2.0 is the only sign-in it supports, and it proves
exactly one thing: the SteamID64 of the person signing in. Rank always comes
from our own table.
