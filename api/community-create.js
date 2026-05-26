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
  try {
    const stockCode = String(req.query.stock_code || "").trim();
    let query = `community_posts?select=*&order=created_at.desc&limit=30`;
    if (stockCode) query += `&stock_code=eq.${encodeURIComponent(stockCode)}`;

    const posts = await supabaseFetch(query, { method: "GET", headers: { Prefer: "" } });

    const ids = posts.map((p) => p.id);
    let comments = [];
    if (ids.length) {
      const inList = ids.map((id) => `"${id}"`).join(",");
      comments = await supabaseFetch(`community_comments?select=*&post_id=in.(${encodeURIComponent(inList)})&order=created_at.asc&limit=200`, {
        method: "GET",
        headers: { Prefer: "" },
      });
    }

    const byPost = {};
    for (const c of comments) {
      byPost[c.post_id] = byPost[c.post_id] || [];
      byPost[c.post_id].push(c);
    }

    return send(res, 200, {
      posts: posts.map((p) => ({ ...p, comments: byPost[p.id] || [] })),
    });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
};

