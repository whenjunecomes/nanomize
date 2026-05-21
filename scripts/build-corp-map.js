const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const DART_KEY = process.env.DART_API_KEY || "";

async function main() {
  if (!DART_KEY) {
    throw new Error("DART_API_KEY 환경변수가 없습니다. Vercel Environment Variables에 DART_API_KEY를 추가한 뒤 Redeploy 하세요.");
  }

  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(DART_KEY)}`;
  console.log("Downloading DART corpCode.xml once during build...");

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 NANOMIZE",
      "Accept": "*/*"
    }
  });

  if (!res.ok) {
    throw new Error(`DART corpCode.xml 요청 실패: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xmlFile = zip.file("CORPCODE.xml") || zip.file("corpCode.xml");

  if (!xmlFile) {
    throw new Error("DART CORPCODE.xml 파일을 찾지 못했습니다.");
  }

  const xml = await xmlFile.async("text");
  const rows = xml.match(/<list>[\s\S]*?<\/list>/g) || [];

  const map = {};
  let listedCount = 0;

  for (const row of rows) {
    const corpCode = row.match(/<corp_code>(.*?)<\/corp_code>/)?.[1]?.trim();
    const corpName = row.match(/<corp_name>(.*?)<\/corp_name>/)?.[1]?.trim();
    const stockCode = row.match(/<stock_code>(.*?)<\/stock_code>/)?.[1]?.trim();

    if (stockCode && corpCode) {
      map[stockCode] = {
        corpCode,
        corpName: corpName || "",
        stockCode
      };
      listedCount += 1;
    }
  }

  const outDir = path.join(process.cwd(), "data");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, "corp-codes.json");
  fs.writeFileSync(outPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    count: listedCount,
    map
  }));

  console.log(`Saved ${listedCount} listed corp codes to data/corp-codes.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
