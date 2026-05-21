const fs = require("fs");
const path = require("path");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

let searchCache = null;

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  res.status(status).send(JSON.stringify(body));
}

function norm(value) {
  return String(value || "").toLowerCase().replace(/\s/g, "");
}

function loadList() {
  if (searchCache) return searchCache;

  const filePath = path.join(process.cwd(), "data", "corp-codes.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("data/corp-codes.json 파일이 없습니다. Vercel Redeploy를 확인하세요.");
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const map = data.map || {};

  searchCache = Object.values(map)
    .filter((item) => item.stockCode && item.corpName)
    .map((item) => ({
      name: item.corpName,
      code: item.stockCode,
      market: "KRX",
      sector: "상장사",
      corpCode: item.corpCode,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return searchCache;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    return res.status(200).end();
  }

  try {
    const q = norm(req.query.q || "");
    const limit = Math.min(Number(req.query.limit || 12), 30);

    if (!q) {
      return send(res, 200, {
        results: [],
      });
    }

    const list = loadList();

    const starts = [];
    const contains = [];

    for (const item of list) {
      const n = norm(item.name);
      const c = String(item.code || "");

      if (n.startsWith(q) || c.startsWith(q)) starts.push(item);
      else if (n.includes(q) || c.includes(q)) contains.push(item);

      if (starts.length >= limit) break;
    }

    const results = [...starts, ...contains].slice(0, limit);

    return send(res, 200, {
      results,
    });
  } catch (err) {
    console.error("company-search failed", err);

    return send(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
