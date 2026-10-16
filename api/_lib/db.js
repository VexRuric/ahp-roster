// Thin PostgREST client. No npm dependency: Supabase's REST API is just HTTP.
// The service role key bypasses row-level security, so nothing here may ever
// be imported by code that runs in the browser.

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const configured = () => Boolean(URL_BASE && KEY);

export const isUuid = v =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

// Filters are built from an object, never from an interpolated string, so a
// value can never introduce another PostgREST condition.
function toFilter(where) {
  const parts = Object.entries(where).map(
    ([col, val]) => `${encodeURIComponent(col)}=eq.${encodeURIComponent(val)}`
  );
  if (!parts.length) {
    // PostgREST applies an unfiltered PATCH or DELETE to every row in the
    // table. Refusing here means a bug upstream cannot wipe the roster.
    throw new Error("refusing an unfiltered write");
  }
  return parts.join("&");
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: KEY,
    Authorization: "Bearer " + KEY,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`db ${method} ${path} -> ${res.status}: ${text}`);
    err.status = res.status;
    err.duplicate = res.status === 409 || /duplicate key/i.test(text);
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

export const db = {
  select: (table, query = "") => rest(`${table}${query ? "?" + query : ""}`),

  find: (table, where, select = "*") =>
    rest(`${table}?${toFilter(where)}&select=${encodeURIComponent(select)}&limit=1`)
      .then(rows => rows[0] || null),

  insert: (table, row) =>
    rest(table, { method: "POST", body: row, prefer: "return=representation" }),

  update: (table, where, patch, extra = "") =>
    rest(`${table}?${toFilter(where)}${extra}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=representation"
    }),

  remove: (table, where) =>
    rest(`${table}?${toFilter(where)}`, {
      method: "DELETE",
      prefer: "return=representation"
    })
};

export async function audit(actor, action, target, detail) {
  try {
    await db.insert("ahp_audit_log", { actor, action, target, detail });
  } catch {
    // An audit write must never break the action it is recording.
  }
}
