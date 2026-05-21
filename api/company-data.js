const fs = require("fs");
const path = require("path");

const DART_KEY = process.env.DART_API_KEY || "";
const DATA_GO_KR_KEY = process.env.DATA_GO_KR_API_KEY || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

let corpMapCache = null;

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(status).send(JSON.stringify(body));
}

function loadCorpData() {
  if (corpMapCache) return corpMapCache;

  const filePath = path.join(process.cwd(), "data", "corp-codes.json");

  if (!fs.existsSync(filePath)) {
    throw new Error("data/corp-codes.json 파일이 없습니다. Vercel에서 DART_API_KEY 환경변수를 추가한 뒤 Redeploy 하세요.");
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  corpMapCache = data.map || {};
  return corpMapCache;
}

function numberFromAny(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pick(items, exactNames, includesAll = []) {
  for (const item of items) {
    const name = item.account_nm || "";
    if (exactNames.includes(name)) return numberFromAny(item.thstrm_amount);
  }

  if (includesAll.length) {
    const found = items.find((item) => {
      const name = item.account_nm || "";
      return includesAll.every((word) => name.includes(word));
    });
    if (found) return numberFromAny(found.thstrm_amount);
  }

  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
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

async function fetchJsonOrText(url, timeoutMs = 8000) {
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  const text = await res.text();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }

  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
  };
}

function formatDateKST(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function getValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

function normalizePublicDataItems(data) {
  const item = data?.response?.body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function encodeServiceKey(key) {
  // Encoding 인증키는 이미 %가 들어 있으므로 재인코딩하지 않습니다.
  // Decoding 인증키는 URL에 안전하게 넣기 위해 인코딩합니다.
  return key.includes("%") ? key : encodeURIComponent(key);
}

function getPublicHeader(data) {
  return data?.response?.header || data?.header || {};
}

function makePublicDataUrl(params) {
  const baseUrl = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
  const query = new URLSearchParams();

  // serviceKey는 URLSearchParams로 넣으면 Encoding key가 이중 인코딩될 수 있어 직접 붙입니다.
  query.set("numOfRows", String(params.numOfRows || 20));
  query.set("pageNo", String(params.pageNo || 1));
  query.set("resultType", "json");

  Object.entries(params).forEach(([key, value]) => {
    if (["numOfRows", "pageNo"].includes(key)) return;
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  });

  return `${baseUrl}?serviceKey=${encodeServiceKey(DATA_GO_KR_KEY)}&${query.toString()}`;
}

async function requestPublicStock(params, label) {
  const url = makePublicDataUrl(params);
  const response = await fetchJsonOrText(url, 9000);

  const header = getPublicHeader(response.json);
  const resultCode = String(header.resultCode || header.resultcode || "");
  const resultMsg = String(header.resultMsg || header.resultmsg || "");

  const items = normalizePublicDataItems(response.json);

  return {
    label,
    ok: response.ok,
    httpStatus: response.status,
    resultCode,
    resultMsg,
    itemCount: items.length,
    items,
    rawPreview: response.json ? "" : response.text.slice(0, 260),
    debugUrl: url.replace(encodeServiceKey(DATA_GO_KR_KEY), "SERVICE_KEY_HIDDEN"),
  };
}

function pickLatestMatchingItem(items, stockCode) {
  return items
    .filter((row) => String(getValue(row, ["srtnCd", "srtncd"]) || "").trim() === stockCode)
    .sort((a, b) => String(getValue(b, ["basDt", "basdt"]) || "").localeCompare(String(getValue(a, ["basDt", "basdt"]) || "")))[0] || null;
}

function quoteFromItem(latest, sourceLabel, debug) {
  if (!latest) {
    return {
      price: null,
      marketCap: null,
      shares: null,
      baseDate: null,
      itemName: "",
      marketCategory: "",
      source: "PUBLIC_DATA_NO_ITEM",
      debug,
    };
  }

  const price = numberFromAny(getValue(latest, ["clpr", "CLPR"]));
  const shares = numberFromAny(getValue(latest, ["lstgStCnt", "lstgstcnt", "lstgStkCnt"]));
  const marketCap = numberFromAny(getValue(latest, ["mrktTotAmt", "mrkttotamt"]));

  return {
    price,
    marketCap,
    shares,
    baseDate: String(getValue(latest, ["basDt", "basdt"]) || ""),
    itemName: String(getValue(latest, ["itmsNm", "itmsnm"]) || ""),
    marketCategory: String(getValue(latest, ["mrktCtg", "mrktctg", "mrktCls"]) || ""),
    source: sourceLabel,
    debug: {
      ...debug,
      selectedItemKeys: Object.keys(latest),
      selectedItemSample: latest,
    },
  };
}

async function getPublicStockQuote(stockCode, corpName) {
  if (!DATA_GO_KR_KEY) {
    return {
      price: null,
      marketCap: null,
      shares: null,
      baseDate: null,
      source: "DATA_GO_KR_KEY_MISSING",
      debug: {
        reason: "Vercel Environment Variables에 DATA_GO_KR_API_KEY가 없거나 Redeploy가 안 된 상태입니다.",
      },
    };
  }

  const today = new Date();
  const beginDate = formatDateKST(addDays(today, -30));
  const endDate = formatDateKST(today);

  const attempts = [
    {
      label: "likeSrtnCd + dateRange",
      params: {
        likeSrtnCd: stockCode,
        beginBasDt: beginDate,
        endBasDt: endDate,
        numOfRows: 30,
      },
    },
    {
      label: "likeSrtnCd only",
      params: {
        likeSrtnCd: stockCode,
        numOfRows: 30,
      },
    },
    {
      label: "likeItmsNm + dateRange",
      params: {
        likeItmsNm: corpName || "",
        beginBasDt: beginDate,
        endBasDt: endDate,
        numOfRows: 30,
      },
    },
  ];

  const debugAttempts = [];

  for (const attempt of attempts) {
    if (attempt.label.includes("likeItmsNm") && !corpName) continue;

    try {
      const result = await requestPublicStock(attempt.params, attempt.label);
      const light = {
        label: result.label,
        ok: result.ok,
        httpStatus: result.httpStatus,
        resultCode: result.resultCode,
        resultMsg: result.resultMsg,
        itemCount: result.itemCount,
        rawPreview: result.rawPreview,
        debugUrl: result.debugUrl,
        firstItemKeys: result.items[0] ? Object.keys(result.items[0]) : [],
        firstItemSample: result.items[0] || null,
      };
      debugAttempts.push(light);

      if (!result.ok) continue;
      if (result.resultCode && result.resultCode !== "00") continue;

      const latest = pickLatestMatchingItem(result.items, stockCode) || result.items[0];

      if (latest) {
        return quoteFromItem(latest, "PUBLIC_DATA_KRX", {
          attempts: debugAttempts,
          usedAttempt: result.label,
        });
      }
    } catch (err) {
      debugAttempts.push({
        label: attempt.label,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    price: null,
    marketCap: null,
    shares: null,
    baseDate: null,
    itemName: "",
    marketCategory: "",
    source: "PUBLIC_DATA_FAILED",
    debug: {
      attempts: debugAttempts,
    },
  };
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

    const res = await fetchWithTimeout(url.toString(), {}, 7000);
    if (!res.ok) continue;

    const data = await res.json();

    if (data.status === "000" && Array.isArray(data.list) && data.list.length) {
      const list = data.list;

      const revenue = pick(list, ["매출액", "수익(매출액)", "영업수익", "매출"]);
      const ebit = pick(list, ["영업이익", "영업이익(손실)"]);
      const netIncome = pick(list, ["당기순이익", "당기순이익(손실)", "연결당기순이익", "지배기업의 소유주에게 귀속되는 당기순이익"]);
      const assets = pick(list, ["자산총계"]);
      const debt = pick(list, ["부채총계"]);
      const equity = pick(list, ["자본총계"]);
      const cash = pick(list, ["현금및현금성자산", "현금 및 현금성자산"], ["현금", "현금성"]);
      const cfo = pick(list, ["영업활동현금흐름", "영업활동으로 인한 현금흐름"], ["영업활동", "현금흐름"]);
      const capexRaw =
        pick(list, ["유형자산의 취득", "유형자산 취득"], ["유형자산", "취득"]) ??
        pick(list, ["유형자산의 증가"], ["유형자산", "증가"]);

      return {
        year,
        reportCode: "11011",
        reportName: "사업보고서",
        values: {
          revenue,
          ebit,
          netIncome,
          assets,
          debt,
          equity,
          cash,
          cfo,
          capex: capexRaw === null ? null : Math.abs(capexRaw),
        },
      };
    }
  }

  return {
    year: null,
    reportCode: "11011",
    reportName: "사업보고서",
    values: {},
  };
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
      return send(res, 500, { error: "DART_API_KEY가 설정되지 않았습니다" });
    }

    const stockCode = String(req.query.stock_code || "").trim();
    const market = String(req.query.market || "KRX").trim();
    const name = String(req.query.name || "").trim();

    if (!stockCode) {
      return send(res, 400, { error: "stock_code가 필요합니다" });
    }

    const corpMap = loadCorpData();
    const corpInfo = corpMap[stockCode];

    if (!corpInfo) {
      return send(res, 404, {
        error: "DART corp_code를 찾지 못했습니다",
        meta: { stockCode, market, name },
      });
    }

    const [financials, quote] = await Promise.all([
      getDartFinancials(corpInfo.corpCode),
      getPublicStockQuote(stockCode, name || corpInfo.corpName),
    ]);

    return send(res, 200, {
      meta: {
        name: name || corpInfo.corpName || quote.itemName,
        stockCode,
        market: quote.marketCategory || market,
        corpCode: corpInfo.corpCode,
        corpName: corpInfo.corpName,
        year: financials.year,
        reportCode: financials.reportCode,
        reportName: financials.reportName,
        priceBaseDate: quote.baseDate,
        priceSource: quote.source,
      },
      values: {
        ...financials.values,
        price: quote.price ?? null,
        shares: quote.shares ?? null,
        marketCap: quote.marketCap ?? null,
      },
    });
  } catch (err) {
    console.error("company-data failed", err);
    return send(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
