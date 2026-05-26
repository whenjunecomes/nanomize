const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(body));
}

function ensureConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다");
  }
}

async function supabaseFetch(path, options = {}) {
  ensureConfig();
  const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 200, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST만 허용됩니다" });
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return send(res, 400, { error: "id가 필요합니다" });

    const rows = await supabaseFetch(`community_posts?select=id,helpful_count&id=eq.${encodeURIComponent(id)}&limit=1`, {
      method: "GET",
      headers: { Prefer: "" },
    });
    const current = Number(rows?.[0]?.helpful_count || 0);
    const updated = await supabaseFetch(`community_posts?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ helpful_count: current + 1 }),
    });
    return send(res, 200, { post: updated?.[0] || null });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
};

