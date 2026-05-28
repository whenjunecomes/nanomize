const ECOS_API_KEY = process.env.ECOS_API_KEY || "";
const KOSIS_API_KEY = process.env.KOSIS_API_KEY || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const indicatorDefs = {
  baseRate: { label: "한국 기준금리", unit: "%", source: "ECOS" },
  koreaGovBond10Y: { label: "국고채 10년", unit: "%", source: "ECOS" },
  usdKrw: { label: "원/달러 환율", unit: "원", source: "ECOS" },
  cpi: { label: "CPI", unit: "index", source: "ECOS/KOSIS" },
  ppi: { label: "PPI", unit: "index", source: "ECOS/KOSIS" },
  consumerSentiment: { label: "소비자심리지수", unit: "index", source: "ECOS/KOSIS" },
  exportGrowth: { label: "수출 증가율", unit: "%", source: "KOSIS" },
};

const indicatorKeys = Object.keys(indicatorDefs);

const ecosSeriesCandidates = {
  baseRate: [{ statCode: "722Y001", cycle: "M", months: 36, itemCodes: ["0101000"] }],
  koreaGovBond10Y: [{ statCode: "817Y002", cycle: "D", days: 180, itemCodes: ["010210000"] }],
  usdKrw: [{ statCode: "731Y001", cycle: "D", days: 180, itemCodes: ["0000001"] }],
  cpi: [{ statCode: "901Y009", cycle: "M", months: 36, itemCodes: ["0"] }],
};

const keyStatMatchers = {
  baseRate: [["기준금리"], ["한국은행", "기준금리"]],
  koreaGovBond10Y: [["국고채", "10년"], ["국고채(10년)"]],
  usdKrw: [["원/달러"], ["원달러"], ["원", "미국달러", "환율"]],
  cpi: [["소비자물가지수"], ["CPI"]],
  ppi: [["생산자물가지수"], ["PPI"]],
  consumerSentiment: [["소비자심리지수"], ["소비자동향지수"]],
  exportGrowth: [["수출", "증가율"], ["수출", "증감률"], ["수출", "전년동월"]],
};

function send(res, status, body) {
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", status >= 400 ? "no-store" : "s-maxage=1800, stale-while-revalidate=3600");
  res.status(status).send(JSON.stringify(body));
}

function numberFromAny(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function todayKst() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function ym(date) {
  return date.toISOString().slice(0, 7).replace("-", "");
}

function normalizeDate(value) {
  const s = String(value || "").trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function emptyIndicator(key) {
  const def = indicatorDefs[key];
  return {
    label: def.label,
    value: null,
    unit: def.unit,
    date: null,
    change: null,
    source: def.source,
  };
}

function emptyPayload(message = "거시 데이터 연결 대기") {
  const indicators = Object.fromEntries(indicatorKeys.map((key) => [key, emptyIndicator(key)]));
  return {
    meta: {
      source: "ECOS/KOSIS",
      baseDate: todayKst(),
      status: "failed",
      message,
    },
    indicators,
  };
}

async function fetchWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,*/*",
        "User-Agent": "NANOMIZE macro-data",
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function rowsFromEcos(json, rootName) {
  const root = json?.[rootName];
  const rows = root?.row || [];
  if (!Array.isArray(rows)) return rows ? [rows] : [];
  return rows;
}

function ecosResultOk(json, rootName) {
  const result = json?.RESULT || json?.[rootName]?.RESULT;
  if (!result) return true;
  const code = String(result.CODE || "");
  return code === "" || code === "INFO-000";
}

function ecosUrl(parts) {
  return `https://ecos.bok.or.kr/api/${parts.map((part) => encodeURIComponent(String(part))).join("/")}`;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[\s()（）ㆍ·._-]/g, "");
}

function keyStatName(row) {
  return row.KEYSTAT_NAME || row.STAT_NAME || row.ITEM_NAME1 || row.ITEM_NAME || row.CLASS_NAME || "";
}

async function fetchEcosKeyStats() {
  if (!ECOS_API_KEY) return [];
  const url = ecosUrl(["KeyStatisticList", ECOS_API_KEY, "json", "kr", 1, 1000]);
  const response = await fetchWithTimeout(url, 9000);
  if (!response.ok || !response.json || !ecosResultOk(response.json, "KeyStatisticList")) return [];
  return rowsFromEcos(response.json, "KeyStatisticList");
}

function pickKeyStat(rows, key) {
  const matchers = keyStatMatchers[key] || [];
  return rows.find((row) => {
    const name = normalizeName(keyStatName(row));
    return matchers.some((pieces) => pieces.every((piece) => name.includes(normalizeName(piece))));
  });
}

function indicatorFromKeyStat(key, row) {
  const def = indicatorDefs[key];
  const value = numberFromAny(row.DATA_VALUE || row.VALUE);
  if (value === null) return null;
  return {
    label: def.label,
    value,
    unit: def.unit,
    date: normalizeDate(row.TIME || row.PRD_DE || row.DATA_DATE || row.DATE),
    change: null,
    source: "ECOS",
  };
}

function seriesPeriod(candidate) {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  if (candidate.cycle === "D") {
    return { start: ymd(addDays(now, -(candidate.days || 180))), end: ymd(now) };
  }
  return { start: ym(addMonths(now, -(candidate.months || 36))), end: ym(now) };
}

async function fetchEcosSeries(candidate) {
  if (!ECOS_API_KEY) return [];
  const { start, end } = seriesPeriod(candidate);
  const url = ecosUrl([
    "StatisticSearch",
    ECOS_API_KEY,
    "json",
    "kr",
    1,
    1000,
    candidate.statCode,
    candidate.cycle,
    start,
    end,
    ...(candidate.itemCodes || []),
  ]);
  const response = await fetchWithTimeout(url, 9000);
  if (!response.ok || !response.json || !ecosResultOk(response.json, "StatisticSearch")) return [];
  return rowsFromEcos(response.json, "StatisticSearch");
}

function indicatorFromSeries(key, rows) {
  const def = indicatorDefs[key];
  const points = rows
    .map((row) => ({
      time: String(row.TIME || row.PRD_DE || ""),
      value: numberFromAny(row.DATA_VALUE || row.DT),
    }))
    .filter((row) => row.time && row.value !== null)
    .sort((a, b) => a.time.localeCompare(b.time));

  if (!points.length) return null;
  const latest = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;
  let change = null;
  let changeUnit = null;

  if (previous && previous.value !== 0) {
    if (def.unit === "%") {
      change = latest.value - previous.value;
      changeUnit = "%p";
    } else {
      change = ((latest.value - previous.value) / Math.abs(previous.value)) * 100;
      changeUnit = "%";
    }
  }

  return {
    label: def.label,
    value: latest.value,
    unit: def.unit,
    date: normalizeDate(latest.time),
    change,
    changeUnit,
    source: "ECOS",
  };
}

async function fetchEcosIndicator(key, keyStats) {
  const keyStat = pickKeyStat(keyStats, key);
  if (keyStat) {
    const indicator = indicatorFromKeyStat(key, keyStat);
    if (indicator) return indicator;
  }

  const candidates = ecosSeriesCandidates[key] || [];
  for (const candidate of candidates) {
    try {
      const rows = await fetchEcosSeries(candidate);
      const indicator = indicatorFromSeries(key, rows);
      if (indicator) return indicator;
    } catch (_) {
      // Try the next candidate.
    }
  }

  return null;
}

async function fetchKosisExportGrowth() {
  if (!KOSIS_API_KEY) return null;
  return null;
}

async function buildPayload() {
  if (!ECOS_API_KEY && !KOSIS_API_KEY) return emptyPayload("거시 데이터 연결 대기");

  const indicators = Object.fromEntries(indicatorKeys.map((key) => [key, emptyIndicator(key)]));
  let keyStats = [];

  try {
    keyStats = await fetchEcosKeyStats();
  } catch (_) {
    keyStats = [];
  }

  const ecosResults = await Promise.allSettled(
    indicatorKeys.map(async (key) => {
      if (key === "exportGrowth") return [key, null];
      const indicator = await fetchEcosIndicator(key, keyStats);
      return [key, indicator];
    }),
  );

  ecosResults.forEach((result) => {
    if (result.status !== "fulfilled") return;
    const [key, indicator] = result.value;
    if (indicator) indicators[key] = indicator;
  });

  try {
    const exportGrowth = await fetchKosisExportGrowth();
    if (exportGrowth) indicators.exportGrowth = exportGrowth;
  } catch (_) {
    // KOSIS is optional fallback data.
  }

  if (indicators.exportGrowth.value === null) {
    const keyStat = pickKeyStat(keyStats, "exportGrowth");
    const indicator = keyStat ? indicatorFromKeyStat("exportGrowth", keyStat) : null;
    if (indicator) indicators.exportGrowth = indicator;
  }

  const filled = indicatorKeys.filter((key) => indicators[key].value !== null).length;
  const status = filled === indicatorKeys.length ? "ok" : filled > 0 ? "partial" : "failed";
  const sources = new Set(
    indicatorKeys
      .map((key) => (indicators[key].value !== null ? indicators[key].source : null))
      .filter(Boolean),
  );

  return {
    meta: {
      source: sources.size ? Array.from(sources).join("/") : "ECOS/KOSIS",
      baseDate: todayKst(),
      status,
      message: status === "failed" ? "거시 데이터 연결 대기" : "",
    },
    indicators,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method !== "GET") {
    send(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    send(res, 200, await buildPayload());
  } catch (_) {
    send(res, 200, emptyPayload("거시 데이터 연결 대기"));
  }
};
