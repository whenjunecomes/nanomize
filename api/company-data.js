const JSZip = require("jszip");

const DART_KEY = process.env.DART_API_KEY || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

let corpCodeCache = null;
let corpCodeCacheTime = 0;
const CORP_CODE_CACHE_MS = 1000 * 60 * 60 * 24; // 24시간 캐시

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(body));
}

function numberFromDart(value) {
  if (value === null || value === undefined || value === "") return null;

  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pick(items, exactNames, includesAll = []) {
  for (const item of items) {
    const name = item.account_nm || "";
    if (exactNames.includes(name)) {
      return numberFromDart(item.thstrm_amount);
    }
  }

  if (includesAll.length) {
    const found = items.find((item) => {
      const name = item.account_nm || "";
      return includesAll.every((word) => name.includes(word));
    });

    if (found) {
      return numberFromDart(found.thstrm_amount);
    }
  }

  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 NANOMIZE",
        Accept: "application/json,*/*",
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function loadCorpCodeMap() {
  const now = Date.now();

  if (corpCodeCache && now - corpCodeCacheTime < CORP_CODE_CACHE_MS) {
    return corpCodeCache;
  }

  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(
    DART_KEY
  )}`;

  const res = await fetchWithTimeout(url, {}, 15000);

  if (!res.ok) {
    throw new Error(`DART corpCode.xml 요청 실패: HTTP ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const xmlFile = zip.file("CORPCODE.xml") || zip.file("corpCode.xml");

  if (!xmlFile) {
    throw new Error("DART CORPCODE.xml 파일을 찾지 못했습니다");
  }

  const xml = await xmlFile.async("text");
  const rows = xml.match(/<list>[\s\S]*?<\/list>/g) || [];

  const map = {};

  for (const row of rows) {
    const corpCode = row.match(/<corp_code>(.*?)<\/corp_code>/)?.[1]?.trim();
    const corpName = row.match(/<corp_name>(.*?)<\/corp_name>/)?.[1]?.trim();
    const stockCode = row.match(/<stock_code>(.*?)<\/stock_code>/)?.[1]?.trim();

    if (stockCode && corpCode) {
      map[stockCode] = {
        corpCode,
        corpName: corpName || "",
        stockCode,
      };
    }
  }

  corpCodeCache = map;
  corpCodeCacheTime = now;

  return map;
}

async function findCorpCode(stockCode) {
  const map = await loadCorpCodeMap();
  return map[stockCode] || null;
}

async function getDartFinancials(corpCode) {
  const currentYear = new Date().getFullYear();

  // 올해 사업보고서는 아직 없을 수 있으므로 직전 3개년 순서로 탐색
  const years = [currentYear - 1, currentYear - 2, currentYear - 3];

  for (const year of years) {
    const url = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");

    url.searchParams.set("crtfc_key", DART_KEY);
    url.searchParams.set("corp_code", corpCode);
    url.searchParams.set("bsns_year", String(year));
    url.searchParams.set("reprt_code", "11011"); // 사업보고서
    url.searchParams.set("fs_div", "CFS"); // 연결 재무제표

    const res = await fetchWithTimeout(url.toString(), {}, 12000);

    if (!res.ok) {
      console.error("DART financials HTTP error", year, res.status);
      continue;
    }

    const data = await res.json();

    if (data.status === "000" && Array.isArray(data.list) && data.list.length) {
      const list = data.list;

      const revenue = pick(list, [
        "매출액",
        "수익(매출액)",
        "영업수익",
        "매출",
      ]);

      const ebit = pick(list, [
        "영업이익",
        "영업이익(손실)",
      ]);

      const netIncome = pick(list, [
        "당기순이익",
        "당기순이익(손실)",
        "연결당기순이익",
        "지배기업의 소유주에게 귀속되는 당기순이익",
      ]);

      const assets = pick(list, ["자산총계"]);
      const debt = pick(list, ["부채총계"]);
      const equity = pick(list, ["자본총계"]);

      const cash = pick(
        list,
        ["현금및현금성자산", "현금 및 현금성자산"],
        ["현금", "현금성"]
      );

      const cfo = pick(
        list,
        ["영업활동현금흐름", "영업활동으로 인한 현금흐름"],
        ["영업활동", "현금흐름"]
      );

      const capexRaw =
        pick(
          list,
          ["유형자산의 취득", "유형자산 취득"],
          ["유형자산", "취득"]
        ) ??
        pick(
          list,
          ["유형자산의 증가"],
          ["유형자산", "증가"]
        );

      const capex = capexRaw === null ? null : Math.abs(capexRaw);

      return {
        year,
        values: {
          revenue,
          ebit,
          netIncome,
          assets,
          debt,
          equity,
          cash,
          cfo,
          capex,
        },
      };
    }

    console.log("DART no data", year, data.status, data.message);
  }

  return {
    year: null,
    values: {},
  };
}

async function getYahooQuote(stockCode, market) {
  const suffix = market === "KOSDAQ" ? "KQ" : "KS";
  const symbol = `${stockCode}.${suffix}`;

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
    symbol
  )}`;

  try {
    const res = await fetchWithTimeout(url, {}, 7000);

    if (!res.ok) {
      console.error("Yahoo HTTP error", res.status);
      return {};
    }

    const data = await res.json();
    const q = data?.quoteResponse?.result?.[0];

    if (!q) return {};

    const price =
      q.regularMarketPrice ??
      q.postMarketPrice ??
      q.preMarketPrice ??
      null;

    const marketCap = q.marketCap ?? null;

    const shares =
      q.sharesOutstanding ??
      (price && marketCap ? marketCap / price : null);

    return {
      price,
      marketCap,
      shares,
      yahooSymbol: symbol,
    };
  } catch (err) {
    console.error("Yahoo quote failed", err);
    return {};
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    return res.status(200).end();
  }

  try {
    if (!DART_KEY) {
      return send(res, 500, {
        error: "DART_API_KEY가 설정되지 않았습니다",
      });
    }

    const stockCode = String(req.query.stock_code || "").trim();
    const market = String(req.query.market || "KOSPI").trim();
    const name = String(req.query.name || "").trim();

    if (!stockCode) {
      return send(res, 400, {
        error: "stock_code가 필요합니다",
      });
    }

    const corpInfo = await findCorpCode(stockCode);

    if (!corpInfo) {
      return send(res, 404, {
        error: "DART corp_code를 찾지 못했습니다",
        meta: {
          stockCode,
          market,
          name,
        },
      });
    }

    const [quote, financials] = await Promise.all([
      getYahooQuote(stockCode, market),
      getDartFinancials(corpInfo.corpCode),
    ]);

    return send(res, 200, {
      meta: {
        name: name || corpInfo.corpName,
        stockCode,
        market,
        corpCode: corpInfo.corpCode,
        corpName: corpInfo.corpName,
        year: financials.year,
        yahooSymbol: quote.yahooSymbol,
      },
      values: {
        ...financials.values,
        price: quote.price ?? null,
        marketCap: quote.marketCap ?? null,
        shares: quote.shares ?? null,
      },
    });
  } catch (err) {
    console.error("company-data failed", err);

    return send(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
