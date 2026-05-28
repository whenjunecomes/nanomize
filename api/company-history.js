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
  Object.entries(corsHeaders).forEach(([key, value]) => res.setHeader(key, value));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Historical data is not intraday. Daily cache is aligned with NANOMIZE's confirmed-close-data design.
  res.setHeader(
    "Cache-Control",
    status >= 400 ? "no-store" : "public, s-maxage=86400, stale-while-revalidate=604800",
  );
  res.status(status).send(JSON.stringify(body));
}

function loadCorpData() {
  if (corpMapCache) return corpMapCache;
  const filePath = path.join(process.cwd(), "data", "corp-codes.json");
  if (!fs.existsSync(filePath)) {
    throw new Error("data/corp-codes.json 파일이 없습니다. Vercel 빌드와 DART_API_KEY를 확인하세요.");
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
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

function encodeServiceKey(key) {
  return key.includes("%") ? key : encodeURIComponent(key);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function ymdFromDate(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
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

function periodToDays(period) {
  const p = String(period || "5Y").toUpperCase();
  if (p === "1Y") return 430;
  if (p === "3Y") return 1200;
  if (p === "MAX") return 3650; // v29 MAX: practical 10-year range to keep API stable.
  return 1900; // 5Y
}

async function getPublicStockHistory(stockCode, period) {
  if (!DATA_GO_KR_KEY) {
    return { source: "DATA_GO_KR_KEY_MISSING", items: [], returns: {}, high52w: null, low52w: null };
  }

  const today = new Date();
  const days = periodToDays(period);
  const beginDate = ymdFromDate(addDays(today, -days));
  const endDate = ymdFromDate(today);

  const baseUrl = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
  const query =
    `serviceKey=${encodeServiceKey(DATA_GO_KR_KEY)}` +
    `&numOfRows=5000&pageNo=1&resultType=json` +
    `&likeSrtnCd=${encodeURIComponent(stockCode)}` +
    `&beginBasDt=${beginDate}&endBasDt=${endDate}`;

  try {
    const res = await fetchWithTimeout(`${baseUrl}?${query}`, {}, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const resultCode =
      data?.response?.header?.resultCode ||
      data?.response?.header?.resultcode ||
      data?.header?.resultCode;

    if (resultCode && resultCode !== "00") {
      return { source: "PUBLIC_DATA_API_ERROR", resultCode, items: [], returns: {}, high52w: null, low52w: null };
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
      const target = Number(ymdFromDate(addDays(today, -daysAgo)));
      let found = null;
      for (const item of items) {
        if (Number(item.date) <= target) found = item;
        else break;
      }
      return found || items[0];
    }

    function ret(daysAgo) {
      if (!latest) return null;
      const base = itemOnOrBefore(daysAgo);
      if (!base || !base.close) return null;
      return ((latest.close / base.close) - 1) * 100;
    }

    const lastYear = items.slice(-260);
    const closes52 = lastYear.map((x) => x.close).filter(Boolean);
    const high52w = closes52.length ? Math.max(...closes52) : null;
    const low52w = closes52.length ? Math.min(...closes52) : null;

    return {
      source: "PUBLIC_DATA_KRX",
      period,
      latestDate: latest?.date || null,
      latestClose: latest?.close || null,
      high52w,
      low52w,
      latestVolume: latest?.volume ?? null,
      latestTradingValue: latest?.tradingValue ?? null,
      returns: {
        oneMonth: ret(30),
        threeMonth: ret(90),
        sixMonth: ret(180),
        oneYear: ret(365),
        threeYear: ret(365 * 3),
        fiveYear: ret(365 * 5),
      },
      items,
    };
  } catch (err) {
    console.error("public stock history failed", err);
    return { source: "PUBLIC_DATA_HISTORY_FAILED", error: err instanceof Error ? err.message : String(err), items: [], returns: {}, high52w: null, low52w: null };
  }
}

function buildFinancialValues(list, amountKeys = ["thstrm_amount"]) {
  return {
    revenue: pick(
      list,
      ["매출액", "수익(매출액)", "매출", "영업수익", "고객과의 계약에서 생기는 수익", "매출액 및 기타수익"],
      ["매출액"],
      amountKeys,
    ),
    ebit: pick(list, ["영업이익", "영업이익(손실)", "영업손익"], [], amountKeys),
    netIncome: pick(
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
      amountKeys,
    ),
    equity: pick(
      list,
      ["자본총계", "총자본", "자기자본", "지배기업의 소유주에게 귀속되는 자본", "지배기업소유주지분"],
      [],
      amountKeys,
    ),
    assets: pick(list, ["자산총계", "총자산"], [], amountKeys),
    debt: pick(list, ["부채총계", "총부채"], [], amountKeys),
    cash:
      pick(list, ["현금및현금성자산", "현금 및 현금성자산", "현금및예치금"], [], amountKeys) ??
      pick(list, [], ["현금", "현금성"], amountKeys),
    cfo:
      pick(list, ["영업활동현금흐름", "영업활동으로 인한 현금흐름", "영업활동 현금흐름"], [], amountKeys) ??
      pick(list, [], ["영업활동", "현금흐름"], amountKeys),
  };
}

async function requestFinancialReport(corpCode, year, reportCode, fsDiv) {
  if (!DART_KEY || !corpCode) return null;
  const url = new URL("https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json");
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", reportCode);
  url.searchParams.set("fs_div", fsDiv);

  const res = await fetchWithTimeout(url.toString(), {}, 8000);
  if (!res.ok) return null;
  const data = await res.json();

  if (data.status !== "000" || !Array.isArray(data.list) || !data.list.length) return null;
  return data.list;
}

async function getFinancialReport(corpCode, year, reportCode, options = {}) {
  const amountKeys = options.cumulative
    ? ["thstrm_add_amount", "thstrm_amount"]
    : ["thstrm_amount", "thstrm_add_amount"];

  for (const fsDiv of ["CFS", "OFS"]) {
    try {
      const list = await requestFinancialReport(corpCode, year, reportCode, fsDiv);
      if (!list) continue;

      const values = buildFinancialValues(list, amountKeys);
      const hasCore = values.revenue || values.ebit || values.netIncome || values.equity || values.assets;
      if (!hasCore) continue;

      return {
        year,
        reportCode,
        fsDiv,
        values,
      };
    } catch (_) {
      // Try the next statement type/year candidate.
    }
  }

  return null;
}

async function getAnnualFinancialHistory(corpCode) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => currentYear - 1 - i);

  const rows = await Promise.all(years.map((year) => getFinancialReport(corpCode, year, "11011")));
  return rows
    .filter(Boolean)
    .map((x) => ({ ...x, reportName: "사업보고서" }))
    .sort((a, b) => a.year - b.year);
}

async function getCumulativeReports(corpCode) {
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 2, currentYear - 1, currentYear];
  const reports = [
    ["11013", "1Q", "1분기"],
    ["11012", "2Q", "반기"],
    ["11014", "3Q", "3분기"],
    ["11011", "4Q", "사업보고서"],
  ];

  const tasks = [];
  for (const year of years) {
    for (const [code, quarter, name] of reports) {
      tasks.push(getFinancialReport(corpCode, year, code, { cumulative: code !== "11011" }).then((r) => r ? { ...r, quarter, reportName: name } : null));
    }
  }

  const rows = (await Promise.all(tasks)).filter(Boolean);
  const order = { "1Q": 1, "2Q": 2, "3Q": 3, "4Q": 4 };
  return rows.sort((a, b) => (a.year - b.year) || (order[a.quarter] - order[b.quarter]));
}

function subtractValues(a, b) {
  const out = {};
  for (const key of ["revenue", "ebit", "netIncome"]) {
    const av = a?.[key];
    const bv = b?.[key] || 0;
    out[key] = av === null || av === undefined ? null : av - bv;
  }
  return out;
}

function deriveQuarterActuals(cumulativeRows) {
  const byYear = {};
  for (const row of cumulativeRows || []) {
    byYear[row.year] = byYear[row.year] || [];
    byYear[row.year].push(row);
  }

  const results = [];
  const order = { "1Q": 1, "2Q": 2, "3Q": 3, "4Q": 4 };

  for (const year of Object.keys(byYear).map(Number).sort((a, b) => a - b)) {
    const rows = byYear[year].sort((a, b) => order[a.quarter] - order[b.quarter]);
    let prev = { revenue: 0, ebit: 0, netIncome: 0 };

    for (const row of rows) {
      const actual = subtractValues(row.values, prev);
      results.push({
        year,
        quarter: row.quarter,
        label: `${String(year).slice(2)} ${row.quarter}`,
        reportCode: row.reportCode,
        reportName: row.reportName,
        date: `${year}${row.quarter === "1Q" ? "0331" : row.quarter === "2Q" ? "0630" : row.quarter === "3Q" ? "0930" : "1231"}`,
        values: actual,
        cumulativeValues: row.values,
      });
      prev = row.values;
    }
  }

  return results.filter((x) => Object.values(x.values).some((v) => v !== null && v !== undefined));
}

function buildTtmHistory(quarterActuals, priceItems) {
  const results = [];

  for (let i = 3; i < quarterActuals.length; i++) {
    const slice = quarterActuals.slice(i - 3, i + 1);
    const ttm = { revenue: 0, ebit: 0, netIncome: 0 };
    let ok = true;

    for (const row of slice) {
      for (const key of Object.keys(ttm)) {
        if (row.values[key] === null || row.values[key] === undefined || !Number.isFinite(row.values[key])) ok = false;
        else ttm[key] += row.values[key];
      }
    }

    if (!ok) continue;

    const latestQuarter = quarterActuals[i];
    const priceItem = pickPriceItemOnOrBefore(priceItems, latestQuarter.date);
    const marketCap = priceItem?.marketCap ?? null;
    const shares = priceItem?.shares ?? null;

    results.push({
      label: latestQuarter.label,
      date: latestQuarter.date,
      marketDate: priceItem?.date || null,
      values: ttm,
      marketCap,
      shares,
      ttmPer: marketCap && ttm.netIncome ? marketCap / ttm.netIncome : null,
      ttmPsr: marketCap && ttm.revenue ? marketCap / ttm.revenue : null,
      ttmEvEbit: null,
    });
  }

  return results.slice(-12);
}

function pickPriceItemOnOrBefore(items, dateYmd) {
  if (!Array.isArray(items) || !items.length) return null;
  const target = Number(String(dateYmd || "").replace(/\D/g, ""));
  let found = null;
  for (const item of items) {
    if (Number(item.date) <= target) found = item;
    else break;
  }
  return found;
}

function buildValuationHistory(annual, priceItems) {
  return (annual || []).map((row) => {
    const priceItem = pickPriceItemOnOrBefore(priceItems, `${row.year}1231`);
    const marketCap = priceItem?.marketCap ?? null;
    const revenue = row.values?.revenue ?? null;
    const netIncome = row.values?.netIncome ?? null;
    const equity = row.values?.equity ?? null;

    return {
      year: row.year,
      marketCap,
      per: marketCap && netIncome ? marketCap / netIncome : null,
      pbr: marketCap && equity ? marketCap / equity : null,
      psr: marketCap && revenue ? marketCap / revenue : null,
    };
  });
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
  if (!DART_KEY || !corpCode) {
    return { year, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };
  }

  const url = new URL("https://opendart.fss.or.kr/api/alotMatter.json");
  url.searchParams.set("crtfc_key", DART_KEY);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(year));
  url.searchParams.set("reprt_code", "11011");

  try {
    const res = await fetchWithTimeout(url.toString(), {}, 7000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.status !== "000" || !Array.isArray(data.list)) {
      return { year, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };
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
      year,
      dps,
      dividendYield,
      payoutRatio,
      totalDividend: totalDividendRaw ? totalDividendRaw * 1000000 : null,
    };
  } catch (_) {
    return { year, dps: null, dividendYield: null, payoutRatio: null, totalDividend: null };
  }
}

async function getDividendHistory(corpCode) {
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => currentYear - 1 - i);
  const rows = await Promise.all(years.map((year) => getDividendInfo(corpCode, year, null)));
  return rows.sort((a, b) => a.year - b.year);
}

function buildShareHistory(priceItems) {
  const byYear = {};
  for (const item of priceItems || []) {
    const year = Number(String(item.date || "").slice(0, 4));
    if (!year || !item.shares) continue;
    byYear[year] = item;
  }
  return Object.values(byYear)
    .sort((a, b) => Number(a.date) - Number(b.date))
    .map((x) => ({
      year: Number(String(x.date).slice(0, 4)),
      date: x.date,
      shares: x.shares,
      marketCap: x.marketCap,
    }));
}

function downsampleItems(items, maxPoints = 900) {
  if (!Array.isArray(items) || items.length <= maxPoints) return items || [];
  const step = Math.ceil(items.length / maxPoints);
  const sampled = [];

  for (let i = 0; i < items.length; i += step) {
    sampled.push(items[i]);
  }

  const last = items[items.length - 1];
  if (sampled[sampled.length - 1]?.date !== last?.date) sampled.push(last);

  return sampled;
}

function trimHeavyHistory(priceHistory, period) {
  const rawItems = priceHistory.items || [];
  const maxPoints = period === "MAX" ? 1200 : period === "5Y" ? 900 : 650;

  return {
    ...priceHistory,
    rawItemCount: rawItems.length,
    items: downsampleItems(rawItems, maxPoints),
  };
}


module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders).forEach(([key, value]) => res.setHeader(key, value));
    return res.status(200).end();
  }

  try {
    const stockCode = String(req.query.stock_code || "").trim();
    const period = String(req.query.period || "5Y").toUpperCase();
    const name = String(req.query.name || "").trim();

    if (!stockCode) return send(res, 400, { error: "stock_code가 필요합니다" });

    let corpMap = {};
    let corpMapError = null;
    try {
      corpMap = loadCorpData();
    } catch (err) {
      corpMapError = err instanceof Error ? err.message : String(err);
    }
    const corpInfo = corpMap[stockCode] || { corpCode: null, corpName: name || "" };

    const [priceHistory, annualFinancials, cumulativeReports, dividendHistory] = await Promise.all([
      getPublicStockHistory(stockCode, period),
      getAnnualFinancialHistory(corpInfo.corpCode),
      getCumulativeReports(corpInfo.corpCode),
      getDividendHistory(corpInfo.corpCode),
    ]);

    const quarterActuals = deriveQuarterActuals(cumulativeReports);
    const ttmValuationHistory = buildTtmHistory(quarterActuals, priceHistory.items || []);
    const valuationHistory = buildValuationHistory(annualFinancials, priceHistory.items || []);
    const shareHistory = buildShareHistory(priceHistory.items || []);
    const outputPriceHistory = trimHeavyHistory(priceHistory, period);

    return send(res, 200, {
      meta: {
        name: name || corpInfo.corpName,
        stockCode,
        corpCode: corpInfo.corpCode,
        corpName: corpInfo.corpName,
        period,
        source: {
          financials: DART_KEY && corpInfo.corpCode ? "OpenDART" : "OpenDART 미사용",
          prices: DATA_GO_KR_KEY ? "공공데이터포털" : "공공데이터 키 없음",
        },
        warnings: {
          corpMap: corpMapError,
          dartKey: DART_KEY ? null : "DART_API_KEY가 없어 재무 히스토리는 비어 있습니다.",
          priceKey: DATA_GO_KR_KEY ? null : "DATA_GO_KR_API_KEY가 없어 시세 히스토리는 비어 있습니다.",
        },
      },
      history: {
        priceHistory: outputPriceHistory,
        annualFinancials,
        quarterFinancials: quarterActuals.slice(-12),
        valuationHistory,
        ttmValuationHistory,
        latestTtm: ttmValuationHistory[ttmValuationHistory.length - 1] || null,
        dividendHistory,
        shareHistory,
      },
    });
  } catch (err) {
    console.error("company-history failed", err);
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
};
