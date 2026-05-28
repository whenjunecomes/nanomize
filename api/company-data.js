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
  res.setHeader(
    "Cache-Control",
    status >= 400 ? "no-store" : "s-maxage=900, stale-while-revalidate=3600",
  );
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

function normalizeAccountName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/[()（）ㆍ·.,]/g, "");
}

function amountFromRow(item, keys = ["thstrm_amount"]) {
  for (const key of keys) {
    const value = numberFromAny(item?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function pick(items, exactNames, includesAll = [], amountKeys = ["thstrm_amount"]) {
  const list = Array.isArray(items) ? items : [];
  const exact = exactNames.map(normalizeAccountName);

  for (const item of list) {
    const name = normalizeAccountName(item.account_nm || "");
    if (exact.includes(name)) return amountFromRow(item, amountKeys);
  }

  if (includesAll.length) {
    const words = includesAll.map(normalizeAccountName);
    const found = list.find((item) => {
      const name = normalizeAccountName(item.account_nm || "");
      return words.every((word) => name.includes(word));
    });
    if (found) return amountFromRow(found, amountKeys);
  }

  return null;
}

function sumPresent(...values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000, retries = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
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
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
      await sleep(250 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("fetch failed");
}

async function fetchJsonOrText(url, timeoutMs = 8000, retries = 1) {
  const res = await fetchWithTimeout(url, {}, timeoutMs, retries);
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

async function requestPublicStock(params, label, timeoutMs = 10000) {
  const url = makePublicDataUrl(params);
  const response = await fetchJsonOrText(url, timeoutMs, 1);

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

function pickLatestMatchingNameItem(items, corpName) {
  const norm = (v) => String(v || "").replace(/\s/g, "").toLowerCase();
  const target = norm(corpName);
  if (!target) return null;

  return items
    .filter((row) => norm(getValue(row, ["itmsNm", "itmsnm"])) === target)
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
  const startedAt = Date.now();
  const budgetMs = 45000;
  const beginDate = formatDateKST(addDays(today, -370));
  const endDate = formatDateKST(today);

  const attempts = [
    {
      label: "likeSrtnCd + dateRange",
      params: {
        likeSrtnCd: stockCode,
        beginBasDt: beginDate,
        endBasDt: endDate,
        numOfRows: 500,
      },
    },
    {
      label: "likeSrtnCd only",
      params: {
        likeSrtnCd: stockCode,
        numOfRows: 500,
      },
    },
    {
      label: "likeItmsNm + dateRange",
      params: {
        likeItmsNm: corpName || "",
        beginBasDt: beginDate,
        endBasDt: endDate,
        numOfRows: 500,
      },
    },
  ];

  const debugAttempts = [];

  for (const attempt of attempts) {
    if (attempt.label.includes("likeItmsNm") && !corpName) continue;
    const remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs < 3000) {
      debugAttempts.push({ label: attempt.label, skipped: "quote budget exhausted" });
      break;
    }

    try {
      const result = await requestPublicStock(attempt.params, attempt.label, Math.min(10000, remainingMs));
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

      const latest = pickLatestMatchingItem(result.items, stockCode) || (attempt.label.includes("likeItmsNm") ? pickLatestMatchingNameItem(result.items, corpName) : null);

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

function emptyFinancialValues() {
  return {
    revenue: null,
    ebit: null,
    ebitda: null,
    netIncome: null,
    assets: null,
    debt: null,
    equity: null,
    cash: null,
    cfo: null,
    capex: null,
    nopat: null,
    investedCapital: null,
  };
}

function buildFinancialValues(list) {
  const revenue = pick(
    list,
    ["매출액", "수익(매출액)", "매출", "영업수익", "고객과의 계약에서 생기는 수익", "매출액 및 기타수익"],
    ["매출액"],
  );
  const ebit = pick(list, ["영업이익", "영업이익(손실)", "영업손익"]);
  const netIncome = pick(
    list,
    [
      "당기순이익",
      "당기순이익(손실)",
      "연결당기순이익",
      "지배기업의 소유주에게 귀속되는 당기순이익",
      "지배기업소유주지분순이익",
      "분기순이익",
      "반기순이익",
    ],
    ["지배기업", "당기순이익"],
  );
  const assets = pick(list, ["자산총계", "총자산"]);
  const debt = pick(list, ["부채총계", "총부채"]);
  const equity = pick(
    list,
    ["자본총계", "총자본", "자기자본", "지배기업의 소유주에게 귀속되는 자본", "지배기업소유주지분"],
  );
  const cash =
    pick(list, ["현금및현금성자산", "현금 및 현금성자산", "현금및예치금"]) ??
    pick(list, [], ["현금", "현금성"]);
  const cfo =
    pick(list, ["영업활동현금흐름", "영업활동으로 인한 현금흐름", "영업활동 현금흐름"]) ??
    pick(list, [], ["영업활동", "현금흐름"]);

  const tangibleCapex =
    pick(list, ["유형자산의 취득", "유형자산 취득", "유형자산의 증가", "유형자산의 취득으로 인한 현금유출"], ["유형자산", "취득"]) ??
    pick(list, ["유형자산의 증가"], ["유형자산", "증가"]);

  const intangibleCapex =
    pick(list, ["무형자산의 취득", "무형자산 취득", "무형자산의 취득으로 인한 현금유출"], ["무형자산", "취득"]) ??
    0;

  const capexSum =
    tangibleCapex === null && !intangibleCapex
      ? null
      : Math.abs(Number(tangibleCapex || 0)) + Math.abs(Number(intangibleCapex || 0));

  const depAmortCombined =
    pick(list, ["감가상각비와 무형자산상각비", "감가상각비 및 무형자산상각비", "감가상각비및무형자산상각비"]) ??
    pick(list, [], ["감가상각비", "무형자산상각비"]);
  const depreciation = pick(list, ["감가상각비", "유형자산감가상각비"], ["감가상각비"]);
  const amortization = pick(list, ["무형자산상각비"], ["무형자산상각비"]);
  const depreciationAndAmortization = depAmortCombined ?? sumPresent(depreciation, amortization);
  const ebitda = ebit !== null && depreciationAndAmortization !== null
    ? ebit + Math.abs(depreciationAndAmortization)
    : null;

  const preTaxIncome = pick(list, ["법인세비용차감전순이익", "법인세비용차감전계속영업이익", "법인세비용차감전순이익(손실)"]);
  const incomeTax = pick(list, ["법인세비용", "법인세비용(수익)", "법인세비용차감"]);
  const taxRate =
    preTaxIncome && incomeTax !== null && incomeTax >= 0
      ? Math.min(0.45, Math.max(0, incomeTax / preTaxIncome))
      : null;
  const nopat = ebit !== null && taxRate !== null ? ebit * (1 - taxRate) : null;
  const investedCapital =
    debt !== null && equity !== null
      ? debt + equity - Number(cash || 0)
      : assets !== null
        ? assets - Number(cash || 0)
        : null;

  return {
    revenue,
    ebit,
    ebitda,
    netIncome,
    assets,
    debt,
    equity,
    cash,
    cfo,
    capex: capexSum,
    nopat,
    investedCapital,
  };
}

async function getDartFinancials(corpCode) {
  if (!DART_KEY || !corpCode) {
    return {
      year: null,
      reportCode: "11011",
      reportName: "사업보고서",
      fsDiv: null,
      values: emptyFinancialValues(),
      debug: [{ error: "DART_API_KEY 또는 corp_code가 없어 재무값을 건너뜁니다." }],
    };
  }

  const currentYear = new Date().getFullYear();
  const years = [currentYear - 1, currentYear - 2, currentYear - 3, currentYear - 4, currentYear - 5];
  const fsDivs = ["CFS", "OFS"];
  const debug = [];
  const startedAt = Date.now();
  const budgetMs = 48000;

  for (const year of years) {
    for (const fsDiv of fsDivs) {
      const remainingMs = budgetMs - (Date.now() - startedAt);
      if (remainingMs < 3000) {
        debug.push({ year, fsDiv, skipped: "financials budget exhausted" });
        return {
          year: null,
          reportCode: "11011",
          reportName: "사업보고서",
          fsDiv: null,
          values: emptyFinancialValues(),
          debug,
        };
      }

      const url = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");

      url.searchParams.set("crtfc_key", DART_KEY);
      url.searchParams.set("corp_code", corpCode);
      url.searchParams.set("bsns_year", String(year));
      url.searchParams.set("reprt_code", "11011");
      url.searchParams.set("fs_div", fsDiv);

      try {
        const res = await fetchWithTimeout(url.toString(), {}, Math.min(9000, remainingMs), 0);
        if (!res.ok) {
          debug.push({ year, fsDiv, httpStatus: res.status });
          continue;
        }

        const data = await res.json();
        debug.push({ year, fsDiv, status: data.status, count: Array.isArray(data.list) ? data.list.length : 0 });

        if (data.status === "000" && Array.isArray(data.list) && data.list.length) {
          const values = buildFinancialValues(data.list);
          const hasCore = values.revenue || values.ebit || values.netIncome || values.equity || values.assets;

          if (hasCore) {
            return {
              year,
              reportCode: "11011",
              reportName: fsDiv === "CFS" ? "사업보고서(연결)" : "사업보고서(별도)",
              fsDiv,
              values,
              debug,
            };
          }
        }
      } catch (err) {
        debug.push({ year, fsDiv, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    year: null,
    reportCode: "11011",
    reportName: "사업보고서",
    fsDiv: null,
    values: emptyFinancialValues(),
    debug,
  };
}

async function getRecentQuarterFinancials(corpCode) {
  if (!DART_KEY || !corpCode) return null;
  const currentYear = new Date().getFullYear();

  // 최신 실적 참고용. 계산에는 자동 반영하지 않습니다.
  const candidates = [
    [currentYear, "11014", "3분기보고서"],
    [currentYear, "11012", "반기보고서"],
    [currentYear, "11013", "1분기보고서"],
    [currentYear - 1, "11014", "3분기보고서"],
    [currentYear - 1, "11012", "반기보고서"],
    [currentYear - 1, "11013", "1분기보고서"],
  ];

  const results = await Promise.all(candidates.map(async ([year, reportCode, reportName]) => {
    for (const fsDiv of ["CFS", "OFS"]) {
      const url = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");

      url.searchParams.set("crtfc_key", DART_KEY);
      url.searchParams.set("corp_code", corpCode);
      url.searchParams.set("bsns_year", String(year));
      url.searchParams.set("reprt_code", reportCode);
      url.searchParams.set("fs_div", fsDiv);

      try {
        const res = await fetchWithTimeout(url.toString(), {}, 9000, 0);
        if (!res.ok) continue;

        const data = await res.json();

        if (data.status === "000" && Array.isArray(data.list) && data.list.length) {
          const values = buildFinancialValues(data.list);
          const hasCore = values.revenue || values.ebit || values.netIncome;
          if (!hasCore) continue;
          return {
            year,
            reportCode,
            reportName: fsDiv === "CFS" ? `${reportName}(연결)` : `${reportName}(별도)`,
            fsDiv,
            values: {
              revenue: values.revenue,
              ebit: values.ebit,
              netIncome: values.netIncome,
            },
          };
        }
      } catch (err) {
        console.error("recent quarter failed", year, reportCode, fsDiv, err);
      }
    }
    return null;
  }));

  return results.find(Boolean) || null;
}


function ymdFromDate(date) {
  const d = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function addCalendarDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function parseYmdNumber(value) {
  return Number(String(value || "").replace(/\D/g, ""));
}

async function getPublicStockHistory(stockCode) {
  if (!DATA_GO_KR_KEY) {
    return {
      source: "DATA_GO_KR_KEY_MISSING",
      items: [],
      returns: {},
      high52w: null,
      low52w: null,
      latestVolume: null,
      latestTradingValue: null,
    };
  }

  const today = new Date();
  const beginDate = ymdFromDate(addCalendarDays(today, -760));
  const endDate = ymdFromDate(today);

  const baseUrl = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
  const query =
    `serviceKey=${encodeServiceKey(DATA_GO_KR_KEY)}` +
    `&numOfRows=800&pageNo=1&resultType=json` +
    `&likeSrtnCd=${encodeURIComponent(stockCode)}` +
    `&beginBasDt=${beginDate}&endBasDt=${endDate}`;

  try {
      const res = await fetchWithTimeout(`${baseUrl}?${query}`, {}, 12000, 0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const resultCode =
      data?.response?.header?.resultCode ||
      data?.response?.header?.resultcode ||
      data?.header?.resultCode;

    if (resultCode && resultCode !== "00") {
      return {
        source: "PUBLIC_DATA_API_ERROR",
        resultCode,
        items: [],
        returns: {},
        high52w: null,
        low52w: null,
        latestVolume: null,
        latestTradingValue: null,
      };
    }

    const items = normalizePublicDataItems(data)
      .filter((row) => String(getValue(row, ["srtnCd", "srtncd"]) || "").trim() === stockCode)
      .map((row) => ({
        date: String(getValue(row, ["basDt", "basdt"]) || ""),
        close: numberFromAny(getValue(row, ["clpr", "CLPR"])),
        marketCap: numberFromAny(getValue(row, ["mrktTotAmt", "mrkttotamt"])),
        shares: numberFromAny(getValue(row, ["lstgStCnt", "lstgstcnt", "lstgStkCnt"])),
        volume: numberFromAny(getValue(row, ["trqu", "TRQU"])),
        tradingValue: numberFromAny(getValue(row, ["trPrc", "trprc", "TR_PRC"])),
      }))
      .filter((row) => row.date && row.close)
      .sort((a, b) => Number(a.date) - Number(b.date));

    const latest = items[items.length - 1] || null;

    function itemOnOrBefore(daysAgo) {
      if (!items.length) return null;
      const target = parseYmdNumber(ymdFromDate(addCalendarDays(today, -daysAgo)));
      let found = null;
      for (const item of items) {
        if (parseYmdNumber(item.date) <= target) found = item;
        else break;
      }
      return found || items[0];
    }

    function ret(days) {
      if (!latest) return null;
      const base = itemOnOrBefore(days);
      if (!base || !base.close) return null;
      return ((latest.close / base.close) - 1) * 100;
    }

    const closes = items.map((x) => x.close).filter(Boolean);
    const high52w = closes.length ? Math.max(...closes) : null;
    const low52w = closes.length ? Math.min(...closes) : null;

    return {
      source: "PUBLIC_DATA_KRX",
      latestDate: latest?.date || null,
      latestVolume: latest?.volume ?? null,
      latestTradingValue: latest?.tradingValue ?? null,
      high52w,
      low52w,
      returns: {
        oneMonth: ret(30),
        threeMonth: ret(90),
        sixMonth: ret(180),
        oneYear: ret(365),
      },
      items: items.slice(-240),
    };
  } catch (err) {
    console.error("public stock history failed", err);
    return {
      source: "PUBLIC_DATA_HISTORY_FAILED",
      error: err instanceof Error ? err.message : String(err),
      items: [],
      returns: {},
      high52w: null,
      low52w: null,
      latestVolume: null,
      latestTradingValue: null,
    };
  }
}

function normalizeDartList(data) {
  if (!data || !Array.isArray(data.list)) return [];
  return data.list;
}

async function getRecentDisclosures(corpCode) {
  if (!DART_KEY || !corpCode) return { source: "DART_KEY_OR_CORP_CODE_MISSING", items: [] };
  const today = new Date();
  const end = ymdFromDate(today);
  const begin = ymdFromDate(addCalendarDays(today, -365));

  const url = new URL("https://opendart.fss.or.kr/api/list.json");
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bgn_de", begin);
  url.searchParams.set("end_de", end);
  url.searchParams.set("page_no", "1");
  url.searchParams.set("page_count", "10");

  try {
    const res = await fetchWithTimeout(url.toString(), {}, 9000, 0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.status !== "000" && data.status !== "013") {
      return { source: "DART_DISCLOSURE_ERROR", status: data.status, message: data.message, items: [] };
    }

    return {
      source: "OpenDART",
      items: normalizeDartList(data).slice(0, 8).map((x) => ({
        date: x.rcept_dt || "",
        reportName: x.report_nm || "",
        receiptNo: x.rcept_no || "",
        filer: x.flr_nm || "",
        url: x.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}` : "",
      })),
    };
  } catch (err) {
    console.error("recent disclosures failed", err);
    return { source: "DART_DISCLOSURE_FAILED", error: err instanceof Error ? err.message : String(err), items: [] };
  }
}

function valueFromDividendRows(rows, keywords) {
  if (!Array.isArray(rows)) return null;
  const row = rows.find((x) => {
    const label = String(x.se || x.division || "");
    return keywords.every((k) => label.includes(k));
  });
  if (!row) return null;
  return numberFromAny(row.thstrm || row.thstrm_amount || row.thstrm_amt || row.amount);
}

async function getDividendInfo(corpCode, year, price) {
  if (!DART_KEY || !corpCode) return { source: "DART_KEY_OR_CORP_CODE_MISSING", year: year || null, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };
  if (!year) return { source: "OpenDART", year: null, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };

  const url = new URL("https://opendart.fss.or.kr/api/alotMatter.json");
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", "11011");

  try {
    const res = await fetchWithTimeout(url.toString(), {}, 9000, 0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.status !== "000" || !Array.isArray(data.list)) {
      return { source: "OpenDART", year, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null, status: data.status, message: data.message };
    }

    const rows = data.list;
    const dps =
      valueFromDividendRows(rows, ["주당", "현금배당금"]) ??
      valueFromDividendRows(rows, ["현금배당금", "보통주"]);
    const dividendYield =
      valueFromDividendRows(rows, ["현금배당수익률"]) ??
      (price && dps ? (dps / price) * 100 : null);
    const payoutRatio = valueFromDividendRows(rows, ["현금배당성향"]);
    const totalDividendRaw =
      valueFromDividendRows(rows, ["현금배당금총액"]) ??
      valueFromDividendRows(rows, ["배당금총액"]);

    return {
      source: "OpenDART",
      year,
      dps,
      dividendYield,
      payoutRatio,
      totalDividend: totalDividendRaw ? totalDividendRaw * 1000000 : null,
    };
  } catch (err) {
    console.error("dividend info failed", err);
    return { source: "DART_DIVIDEND_FAILED", year, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };
  }
}

async function getShareInfo(corpCode, year) {
  if (!DART_KEY || !corpCode) return { source: "DART_KEY_OR_CORP_CODE_MISSING", year: year || null, issuedShares: null, distributedShares: null, treasuryShares: null, treasuryRatio: null };
  if (!year) return { source: "OpenDART", year: null, issuedShares: null, distributedShares: null, treasuryShares: null, treasuryRatio: null };

  const url = new URL("https://opendart.fss.or.kr/api/stockTotqySttus.json");
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", "11011");

  try {
    const res = await fetchWithTimeout(url.toString(), {}, 9000, 0);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (data.status !== "000" || !Array.isArray(data.list)) {
      return { source: "OpenDART", year, issuedShares: null, distributedShares: null, treasuryShares: null, treasuryRatio: null, status: data.status, message: data.message };
    }

    const row =
      data.list.find((x) => String(x.se || "").includes("보통주")) ||
      data.list.find((x) => String(x.stock_knd || "").includes("보통주")) ||
      data.list[0];

    const issuedShares = numberFromAny(row.istc_totqy);
    const distributedShares = numberFromAny(row.distb_stock_co);
    const treasuryShares = numberFromAny(row.tesstk_co);
    const treasuryRatio = issuedShares && treasuryShares ? (treasuryShares / issuedShares) * 100 : null;

    return { source: "OpenDART", year, issuedShares, distributedShares, treasuryShares, treasuryRatio };
  } catch (err) {
    console.error("share info failed", err);
    return { source: "DART_SHARE_INFO_FAILED", year, issuedShares: null, distributedShares: null, treasuryShares: null, treasuryRatio: null };
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function sanitizeValues(values = {}) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, finiteOrNull(value)]),
  );
}


module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    return res.status(200).end();
  }

  try {
    const stockCode = String(req.query.stock_code || "").trim();
    const market = String(req.query.market || "KRX").trim();
    const name = String(req.query.name || "").trim();

    if (!stockCode) {
      return send(res, 400, { error: "stock_code가 필요합니다" });
    }

    let corpMap = {};
    let corpMapError = null;
    try {
      corpMap = loadCorpData();
    } catch (err) {
      corpMapError = err instanceof Error ? err.message : String(err);
    }
    const corpInfo = corpMap[stockCode] || { corpCode: null, corpName: name || "" };

    const [
      financialsResult,
      quoteResult,
      recentQuarterResult,
      priceHistoryResult,
      disclosuresResult,
    ] = await Promise.allSettled([
      getDartFinancials(corpInfo.corpCode),
      getPublicStockQuote(stockCode, name || corpInfo.corpName),
      getRecentQuarterFinancials(corpInfo.corpCode),
      getPublicStockHistory(stockCode),
      getRecentDisclosures(corpInfo.corpCode),
    ]);

    const financials =
      financialsResult.status === "fulfilled"
        ? financialsResult.value
        : {
            year: null,
            reportCode: "11011",
            reportName: "사업보고서",
            fsDiv: null,
            values: emptyFinancialValues(),
            debug: [{ error: financialsResult.reason?.message || String(financialsResult.reason) }],
          };

    const quote =
      quoteResult.status === "fulfilled"
        ? quoteResult.value
        : {
            price: null,
            marketCap: null,
            shares: null,
            baseDate: null,
            itemName: "",
            marketCategory: "",
            source: "PUBLIC_DATA_FAILED",
            debug: { error: quoteResult.reason?.message || String(quoteResult.reason) },
          };

    const recentQuarter =
      recentQuarterResult.status === "fulfilled"
        ? recentQuarterResult.value
        : null;

    const priceHistory =
      priceHistoryResult.status === "fulfilled"
        ? priceHistoryResult.value
        : { source: "PUBLIC_DATA_HISTORY_FAILED", items: [], returns: {}, high52w: null, low52w: null };

    const disclosures =
      disclosuresResult.status === "fulfilled"
        ? disclosuresResult.value
        : { source: "DART_DISCLOSURE_FAILED", items: [] };

    const [dividendResult, shareInfoResult] = await Promise.allSettled([
      getDividendInfo(corpInfo.corpCode, financials.year, quote.price),
      getShareInfo(corpInfo.corpCode, financials.year),
    ]);

    const dividend =
      dividendResult.status === "fulfilled"
        ? dividendResult.value
        : { source: "DART_DIVIDEND_FAILED", year: financials.year, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };

    const shareInfo =
      shareInfoResult.status === "fulfilled"
        ? shareInfoResult.value
        : { source: "DART_SHARE_INFO_FAILED", year: financials.year, issuedShares: null, distributedShares: null, treasuryShares: null, treasuryRatio: null };

    const effectiveShares =
      quote.shares ??
      shareInfo.distributedShares ??
      shareInfo.issuedShares ??
      null;

    const effectiveMarketCap =
      quote.marketCap ??
      (quote.price && effectiveShares ? quote.price * effectiveShares : null);

    const eps =
      effectiveShares && financials.values.netIncome
        ? financials.values.netIncome / effectiveShares
        : null;

    const bps =
      effectiveShares && financials.values.equity
        ? financials.values.equity / effectiveShares
        : null;

    const cleanFinancialValues = sanitizeValues(financials.values);

    return send(res, 200, {
      meta: {
        name: name || corpInfo.corpName || quote.itemName,
        stockCode,
        market: quote.marketCategory || market,
        corpCode: corpInfo.corpCode || null,
        corpName: corpInfo.corpName,
        year: financials.year,
        reportCode: financials.reportCode,
        reportName: financials.reportName,
        priceBaseDate: quote.baseDate,
        priceSource: quote.source,
        financialsSourceDetail: financials.fsDiv || null,
        dataWarnings: {
          corpMap: corpMapError,
          dartKey: DART_KEY ? null : "DART_API_KEY가 없어 재무·공시 데이터는 건너뛰었습니다.",
          financials: financials.year ? null : "DART 사업보고서 재무값을 불러오지 못했습니다. 직접 입력값을 사용하세요.",
          quote: quote.price ? null : "공공데이터 시세값을 불러오지 못했습니다. 직접 입력값을 사용하세요.",
        },
      },
      recentQuarter,
      insights: {
        priceHistory,
        disclosures,
        dividend,
        shareInfo,
      },
      values: {
        ...cleanFinancialValues,
        price: finiteOrNull(quote.price),
        shares: finiteOrNull(effectiveShares),
        marketCap: finiteOrNull(effectiveMarketCap),
        eps: finiteOrNull(eps),
        bps: finiteOrNull(bps),
      },
    });
  } catch (err) {
    console.error("company-data failed", err);
    return send(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
