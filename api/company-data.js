const JSZip = require("jszip");

const DART_KEY = process.env.DART_API_KEY || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(body));
}

function numberFromDart(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pick(items, names, includesAll = []) {
  for (const item of items) {
    const name = item.account_nm || "";
    if (names.includes(name)) return numberFromDart(item.thstrm_amount);
  }

  if (includesAll.length) {
    const found = items.find((item) => {
      const name = item.account_nm || "";
      return includesAll.every((word) => name.includes(word));
    });
    if (found) return numberFromDart(found.thstrm_amount);
  }

  return null;
}

async function getCorpCode(stockCode) {
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(DART_KEY)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 NANOMIZE",
      "Accept": "*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`DART corpCode.xml 요청 실패: ${res.status}`);
  }

  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const xmlFile = zip.file("CORPCODE.xml") || zip.file("corpCode.xml");

  if (!xmlFile) throw new Error("DART CORPCODE.xml 파일을 찾지 못했습니다");

  const xml = await xmlFile.async("text");
  const rows = xml.match(/<list>[\s\S]*?<\/list>/g) || [];

  for (const row of rows) {
    const stock = row.match(/<stock_code>(.*?)<\/stock_code>/)?.[1]?.trim();
    if (stock === stockCode) {
      return row.match(/<corp_code>(.*?)<\/corp_code>/)?.[1]?.trim() || null;
    }
  }

  return null;
}

async function getDartFinancials(corpCode) {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear - 2, currentYear - 3];

  for (const year of years) {
    const url = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");
    url.searchParams.set("crtfc_key", DART_KEY);
    url.searchParams.set("corp_code", corpCode);
    url.searchParams.set("bsns_year", String(year));
    url.searchParams.set("reprt_code", "11011");
    url.searchParams.set("fs_div", "CFS");

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 NANOMIZE",
        "Accept": "application/json",
      },
    });

    if (!res.ok) continue;

    const data = await res.json();

    if (data.status === "000" && Array.isArray(data.list) && data.list.length) {
      const list = data.list;

      const revenue = pick(list, ["매출액", "수익(매출액)", "영업수익"]);
      const ebit = pick(list, ["영업이익", "영업이익(손실)"]);
      const netIncome = pick(list, ["당기순이익", "당기순이익(손실)", "연결당기순이익"]);
      const assets = pick(list, ["자산총계"]);
      const debt = pick(list, ["부채총계"]);
      const equity = pick(list, ["자본총계"]);
      const cash = pick(list, ["현금및현금성자산", "현금 및 현금성자산"], ["현금", "현금성"]);
      const cfo = pick(list, ["영업활동현금흐름", "영업활동으로 인한 현금흐름"], ["영업활동", "현금흐름"]);

      const capexRaw =
        pick(list, ["유형자산의 취득", "유형자산 취득"], ["유형자산", "취득"]) ??
        pick(list, ["유형자산의 증가"], ["유형자산", "증가"]);

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
  }

  return { year: null, values: {} };
}

async function getYahooQuote(stockCode, market) {
  const suffix = market === "KOSDAQ" ? "KQ" : "KS";
  const symbol = `${stockCode}.${suffix}`;
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 NANOMIZE",
        "Accept": "application/json",
      },
    });

    if (!res.ok) return {};

    const data = await res.json();
    const q = data?.quoteResponse?.result?.[0];

    if (!q) return {};

    const price = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? null;
    const marketCap = q.marketCap ?? null;
    const shares = q.sharesOutstanding ?? (price && marketCap ? marketCap / price : null);

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
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }

  try {
    if (!DART_KEY) {
      return send(res, 500, { error: "DART_API_KEY가 설정되지 않았습니다" });
    }

    const stockCode = String(req.query.stock_code || "").trim();
    const market = String(req.query.market || "KOSPI").trim();
    const name = String(req.query.name || "").trim();

    if (!stockCode) {
      return send(res, 400, { error: "stock_code가 필요합니다" });
    }

    const [quote, corpCode] = await Promise.all([
      getYahooQuote(stockCode, market),
      getCorpCode(stockCode),
    ]);

    if (!corpCode) {
      return send(res, 404, {
        error: "DART corp_code를 찾지 못했습니다",
        values: quote,
        meta: { stockCode, market, name },
      });
    }

    const financials = await getDartFinancials(corpCode);

    return send(res, 200, {
      meta: {
        name,
        stockCode,
        market,
        corpCode,
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
    console.error(err);
    return send(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
