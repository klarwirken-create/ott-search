// 5개 OTT의 국내(KR) 구독·무료·광고형 작품 목록을 TMDB(JustWatch 데이터)에서 수집해 _site/data/index.json 생성
// 실행: TMDB_TOKEN=... node scripts/build-index.mjs [출력경로]
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const TOKEN = process.env.TMDB_TOKEN;
if (!TOKEN) { console.error("TMDB_TOKEN 환경변수가 없습니다."); process.exit(1); }
const OUT = process.argv[2] || "_site/data/index.json";
const API = "https://api.themoviedb.org/3";
const OTT = [
  { key: "netflix", re: /netflix/i },
  { key: "tving",   re: /tving/i },
  { key: "watcha",  re: /watcha/i },
  { key: "wavve",   re: /wavve/i },
  { key: "coupang", re: /coupang/i },
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

let calls = 0;
async function tmdb(path, params = {}, tries = 0) {
  const u = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const headers = { accept: "application/json" };
  if (TOKEN.length > 40) headers.Authorization = "Bearer " + TOKEN; else u.searchParams.set("api_key", TOKEN);
  calls++;
  try {
    const r = await fetch(u, { headers });
    if ((r.status === 429 || r.status >= 500) && tries < 6) { await sleep(1000 * 2 ** tries); return tmdb(path, params, tries + 1); }
    if (!r.ok) throw new Error(`TMDB ${r.status} ${path}`);
    return r.json();
  } catch (e) {
    if (tries < 6 && !/TMDB 4/.test(e.message)) { await sleep(1000 * 2 ** tries); return tmdb(path, params, tries + 1); }
    throw e;
  }
}
async function pool(tasks, limit = 8) {
  let i = 0;
  const worker = async () => { while (i < tasks.length) { const k = i++; await tasks[k](); } };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const [pm, pt] = await Promise.all([
  tmdb("/watch/providers/movie", { watch_region: "KR" }),
  tmdb("/watch/providers/tv", { watch_region: "KR" }),
]);
const allP = [...pm.results, ...pt.results];
const providers = {};
for (const o of OTT) {
  const hits = [...new Map(allP.filter(p => o.re.test(p.provider_name)).map(p => [p.provider_id, p.provider_name])).entries()];
  providers[o.key] = { ids: hits.map(h => h[0]), names: hits.map(h => h[1]), count: 0 };
}
console.log("제공사:", JSON.stringify(providers));

const map = new Map();
const thisYear = new Date().getFullYear() + 1;

async function crawl(oi, type, y1, y2) {
  const o = OTT[oi];
  const dk = type === "movie" ? "primary_release_date" : "first_air_date";
  const base = {
    watch_region: "KR", with_watch_providers: providers[o.key].ids.join("|"),
    with_watch_monetization_types: "flatrate|free|ads", language: "ko-KR",
    sort_by: "popularity.desc", include_adult: "false",
  };
  if (y1 != null) { base[dk + ".gte"] = `${y1}-01-01`; base[dk + ".lte"] = `${y2}-12-31`; }
  const first = await tmdb(`/discover/${type}`, { ...base, page: 1 });
  if (first.total_pages > 500) {
    if (y1 == null) return Promise.all([crawl(oi, type, 1900, 1999), crawl(oi, type, 2000, thisYear)]);
    if (y2 > y1) { const m = Math.floor((y1 + y2) / 2); return Promise.all([crawl(oi, type, y1, m), crawl(oi, type, m + 1, y2)]); }
  }
  const add = res => (res?.results || []).forEach(r => {
    const k = (type === "movie" ? "m" : "t") + r.id;
    let e = map.get(k);
    if (!e) {
      e = [type === "movie" ? 0 : 1, r.id, r.title || r.name || "", r.original_title || r.original_name || "",
           (r.release_date || r.first_air_date || "").slice(0, 4), r.poster_path || "", Math.round((r.popularity || 0) * 10) / 10, 0];
      map.set(k, e);
    }
    e[7] |= 1 << oi;
  });
  add(first);
  const pages = Math.min(first.total_pages, 500);
  const tasks = [];
  for (let p = 2; p <= pages; p++) tasks.push(() => tmdb(`/discover/${type}`, { ...base, page: p }).then(add));
  await pool(tasks, 8);
}

for (let oi = 0; oi < OTT.length; oi++) {
  if (!providers[OTT[oi].key].ids.length) { console.log(`${OTT[oi].key}: KR 데이터 없음 — 건너뜀`); continue; }
  for (const type of ["movie", "tv"]) {
    const before = map.size;
    await crawl(oi, type, null, null);
    console.log(`${OTT[oi].key}/${type}: 누적 ${map.size} (+${map.size - before})`);
  }
}

const items = [...map.values()].sort((a, b) => b[6] - a[6]);
OTT.forEach((o, oi) => providers[o.key].count = items.filter(e => e[7] & (1 << oi)).length);
const out = {
  builtAt: new Date().toISOString(),
  source: "TMDB API (watch provider data by JustWatch)",
  schema: ["type(0=movie,1=tv)", "id", "title_ko", "original_title", "year", "poster", "popularity", "ott_bitmask(netflix,tving,watcha,wavve,coupang)"],
  ott: OTT.map(o => o.key),
  providers, items,
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`완료: 작품 ${items.length}건, API 호출 ${calls}회 → ${OUT}`);
console.log("OTT별:", Object.entries(providers).map(([k, v]) => `${k}=${v.count}`).join(", "));
