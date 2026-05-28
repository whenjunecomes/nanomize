const fs = require("fs");
const path = require("path");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

let searchCache = null;
const popularStockRank = new Map([
  ["005930", 0],
  ["000660", 1],
  ["005380", 2],
  ["000270", 3],
  ["373220", 4],
  ["035420", 5],
  ["035720", 6],
  ["068270", 7],
  ["105560", 8],
  ["005490", 9],
]);

const fallbackStocks = [
  { name: "삼성전자", code: "005930", market: "KOSPI", sector: "반도체" },
  { name: "현대차", code: "005380", market: "KOSPI", sector: "자동차" },
  { name: "비에이치", code: "090460", market: "KOSPI", sector: "FPCB" },
  { name: "NAVER", code: "035420", market: "KOSPI", sector: "인터넷" },
  { name: "카카오", code: "035720", market: "KOSPI", sector: "인터넷" },
  { name: "KB금융", code: "105560", market: "KOSPI", sector: "은행" },
  { name: "삼성바이오로직스", code: "207940", market: "KOSPI", sector: "바이오" },
];

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    status >= 400 ? "no-store" : "s-maxage=3600, stale-while-revalidate=86400",
  );
  res.status(status).send(JSON.stringify(body));
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/[()（）ㆍ·.,\-_/]/g, "");
}

function searchRank(item, q) {
  const n = norm(item.name);
  const c = String(item.code || "").replace(/\D/g, "");
  const qc = String(q || "").replace(/\D/g, "");
  if (qc && c === qc) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 2;
  if (qc && c.startsWith(qc)) return 3;
  if (n.includes(q)) return 4;
  if (qc && c.includes(qc)) return 5;
  return 9;
}

function loadList() {
  if (searchCache) return searchCache;

  const filePath = path.join(process.cwd(), "data", "corp-codes.json");

  if (!fs.existsSync(filePath)) {
    searchCache = fallbackStocks;
    return searchCache;
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
      const c = String(item.code || "").replace(/\D/g, "");
      const qc = String(q || "").replace(/\D/g, "");

      if (n === q || (qc && c === qc)) starts.unshift(item);
      else if (n.startsWith(q) || (qc && c.startsWith(qc))) starts.push(item);
      else if (n.includes(q) || (qc && c.includes(qc))) contains.push(item);
    }

    const results = [...starts, ...contains]
      .sort((a, b) => {
        const rankDiff = searchRank(a, q) - searchRank(b, q);
        if (rankDiff) return rankDiff;

        const popularDiff =
          (popularStockRank.get(String(a.code)) ?? 999) -
          (popularStockRank.get(String(b.code)) ?? 999);
        if (popularDiff) return popularDiff;

        const lengthDiff = String(a.name).length - String(b.name).length;
        if (lengthDiff) return lengthDiff;

        return String(a.name).localeCompare(String(b.name), "ko");
      })
      .slice(0, limit);

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
