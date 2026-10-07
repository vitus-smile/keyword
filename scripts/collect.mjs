// 비투스의 키워드 세상 — 일일 수집기
// 키 없이 동작: 구글 급상승(RSS), 구글·유튜브·네이버 자동완성
// 키가 있으면 추가: 유튜브 인기 동영상(YOUTUBE_API_KEY), 네이버 데이터랩(NAVER_HUB_KEY_ID/KEY 또는 NAVER_CLIENT_ID/SECRET),
//                  네이버 검색광고 키워드도구(NAVER_AD_API_KEY/SECRET/CUSTOMER_ID)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36';
const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`);
  return res;
}

const decode = (s = '') =>
  s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const tag = (xml, name) => decode((xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]);

// ── 구글 급상승 검색어 ──────────────────────────────────────────
async function googleTrends() {
  const xml = await (await get('https://trends.google.com/trending/rss?geo=KR')).text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    keyword: tag(it, 'title'),
    traffic: tag(it, 'ht:approx_traffic'),
    trafficNum: parseInt(tag(it, 'ht:approx_traffic').replace(/\D/g, ''), 10) || 0,
    pubDate: new Date(tag(it, 'pubDate')).toISOString(),
    picture: tag(it, 'ht:picture'),
    news: [...it.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)].slice(0, 3).map(([, n]) => ({
      title: tag(n, 'ht:news_item_title'),
      url: tag(n, 'ht:news_item_url'),
      source: tag(n, 'ht:news_item_source'),
    })),
  }));
}

// ── 네이버 쇼핑인사이트 분야별 인기 검색어 (어제 하루 기준) ─────────
const NAVER_CATS = {
  50000000: '패션의류', 50000001: '패션잡화', 50000002: '화장품/미용', 50000003: '디지털/가전',
  50000004: '가구/인테리어', 50000005: '출산/육아', 50000006: '식품', 50000007: '스포츠/레저',
  50000008: '생활/건강', 50000009: '여가/생활편의',
};
async function naverShopping() {
  const day = new Date(Date.now() + 9 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const out = [];
  for (const [cid, name] of Object.entries(NAVER_CATS)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await get('https://datalab.naver.com/shoppingInsight/getCategoryKeywordRank.naver', {
          method: 'POST',
          headers: {
            Referer: 'https://datalab.naver.com/shoppingInsight/sCategory.naver',
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          body: `cid=${cid}&timeUnit=date&startDate=${day}&endDate=${day}&age=&gender=&device=&page=1&count=20`,
        });
        const j = await res.json();
        out.push({ cid, name, keywords: (j.ranks || []).map((r) => r.keyword) });
        break;
      } catch (e) {
        console.warn(`쇼핑 ${name} 재시도 ${attempt + 1}:`, e.message);
        await sleep(5000 * (attempt + 1));
      }
    }
    await sleep(1500);
  }
  if (!out.length) throw new Error('네이버 쇼핑 전 분야 실패');
  return { day, categories: out };
}

// ── 자동완성(연관 검색어) ───────────────────────────────────────
async function suggestGoogle(q, yt = false) {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr${yt ? '&ds=yt' : ''}&q=${encodeURIComponent(q)}`;
  const buf = await (await get(u)).arrayBuffer();
  const [, list] = JSON.parse(new TextDecoder('utf-8').decode(buf));
  return list.filter((s) => s !== q);
}
async function suggestNaver(q) {
  const u = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(q)}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`;
  const j = await (await get(u)).json();
  return (j.items?.[0] || []).map((x) => x[0]).filter((s) => s !== q);
}
async function suggestAll(q) {
  const safe = (p) => p.catch(() => []);
  const [google, youtube, naver] = await Promise.all([
    safe(suggestGoogle(q)), safe(suggestGoogle(q, true)), safe(suggestNaver(q)),
  ]);
  return { google, youtube, naver };
}

// ── 유튜브 인기 동영상 (키 필요) ─────────────────────────────────
async function youtubeTrending() {
  if (!env.YOUTUBE_API_KEY) return null;
  const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=KR&maxResults=50&key=${env.YOUTUBE_API_KEY}`;
  const j = await (await get(u)).json();
  const videos = j.items.map((v) => ({
    id: v.id,
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    thumb: v.snippet.thumbnails?.medium?.url,
    views: +v.statistics.viewCount || 0,
    tags: (v.snippet.tags || []).slice(0, 15),
  }));
  // 태그와 제목 해시태그로 키워드 빈도 집계
  const freq = new Map();
  for (const v of videos) {
    const words = new Set([...v.tags, ...(v.title.match(/#[^\s#]+/g) || []).map((h) => h.slice(1))]
      .map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 20));
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const keywords = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([keyword, count]) => ({ keyword, count }));
  return { videos, keywords };
}

// ── 네이버 데이터랩 검색어 트렌드 (키 필요) — 최근 30일 상대 추이 ──
// 2026-07-31 이후 신규 키는 NAVER API HUB(네이버 클라우드)에서만 발급된다. HUB 키가 있으면 HUB, 없으면 기존 개발자센터 키
function datalabEndpoint() {
  if (env.NAVER_HUB_KEY_ID && env.NAVER_HUB_KEY) {
    return { url: 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search',
      headers: { 'X-NCP-APIGW-API-KEY-ID': env.NAVER_HUB_KEY_ID, 'X-NCP-APIGW-API-KEY': env.NAVER_HUB_KEY } };
  }
  if (env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) {
    return { url: 'https://openapi.naver.com/v1/datalab/search',
      headers: { 'X-Naver-Client-Id': env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET } };
  }
  return null;
}
async function naverDatalab(keywords) {
  const ep = datalabEndpoint();
  if (!ep) return null;
  const end = new Date(Date.now() + 9 * 3600e3);
  const start = new Date(end - 30 * 86400e3);
  const out = {};
  for (let i = 0; i < keywords.length; i += 5) {
    const group = keywords.slice(i, i + 5);
    try {
      const res = await get(ep.url, {
        method: 'POST',
        headers: { ...ep.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          timeUnit: 'date',
          keywordGroups: group.map((k) => ({ groupName: k, keywords: [k] })),
        }),
      });
      for (const r of (await res.json()).results) out[r.title] = r.data.map((d) => d.ratio);
    } catch (e) { console.warn('datalab', e.message); }
  }
  return out;
}

// ── 네이버 검색광고 키워드도구 (키 필요) — 월간 검색량 ─────────────
async function naverSearchAd(keywords) {
  const { NAVER_AD_API_KEY: key, NAVER_AD_SECRET: secret, NAVER_AD_CUSTOMER_ID: cid } = env;
  if (!key || !secret || !cid) return null;
  const out = {};
  const num = (v) => (typeof v === 'number' ? v : 5); // "< 10" 은 5로 표기
  for (let i = 0; i < keywords.length; i += 5) {
    const group = keywords.slice(i, i + 5).map((k) => k.replace(/\s+/g, ''));
    const ts = String(Date.now());
    const path = '/keywordstool';
    const sig = createHmac('sha256', secret).update(`${ts}.GET.${path}`).digest('base64');
    try {
      const res = await get(`https://api.searchad.naver.com${path}?hintKeywords=${encodeURIComponent(group.join(','))}&showDetail=1`, {
        headers: { 'X-Timestamp': ts, 'X-API-KEY': key, 'X-Customer': cid, 'X-Signature': sig },
      });
      for (const r of (await res.json()).keywordList || []) {
        out[r.relKeyword] = { pc: num(r.monthlyPcQcCnt), mobile: num(r.monthlyMobileQcCnt), comp: r.compIdx };
      }
    } catch (e) { console.warn('searchad', e.message); }
    await sleep(300);
  }
  return out;
}

// ── 실행 ─────────────────────────────────────────────────────────
async function readJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  const date = todayKST();
  const errors = {};
  const { seeds = [] } = await readJSON(`${ROOT}config/seeds.json`, {});

  // 하루 여러 번 실행되면 오늘 스냅샷에 누적한다 (구글 RSS는 한 번에 10개만 줌)
  const existing = await readJSON(`${ROOT}data/history/${date}.json`, null);
  const index = await readJSON(`${ROOT}data/index.json`, { dates: [] });
  const prevDate = index.dates.filter((d) => d < date).at(-1);
  const prev = prevDate ? await readJSON(`${ROOT}data/history/${prevDate}.json`, null) : null;

  let fresh = [];
  try { fresh = await googleTrends(); } catch (e) { errors.google = e.message; }
  const byKw = new Map((existing?.google || []).map((t) => [t.keyword, t]));
  for (const t of fresh) {
    const old = byKw.get(t.keyword);
    byKw.set(t.keyword, old ? { ...t, trafficNum: Math.max(old.trafficNum, t.trafficNum),
      traffic: old.trafficNum > t.trafficNum ? old.traffic : t.traffic, firstSeen: old.firstSeen }
      : { ...t, firstSeen: new Date().toISOString() });
  }
  const trends = [...byKw.values()].sort((a, b) => b.trafficNum - a.trafficNum);

  let youtube = existing?.youtube || null;
  try { youtube = (await youtubeTrending()) || youtube; } catch (e) { errors.youtube = e.message; }

  // 네이버 쇼핑은 어제 하루치라 하루 한 번만 받는다
  let shopping = existing?.naverShopping || null;
  if (!shopping || shopping.categories.length < Object.keys(NAVER_CATS).length) {
    try { shopping = await naverShopping(); } catch (e) { errors.naverShopping = e.message; }
  }
  if (shopping) {
    const prevShop = new Set((prev?.naverShopping?.categories || []).flatMap((c) => c.keywords.map((k) => `${c.cid}|${k}`)));
    for (const c of shopping.categories) c.newOnes = prev?.naverShopping ? c.keywords.filter((k) => !prevShop.has(`${c.cid}|${k}`)) : [];
  }

  // 연관 검색어: 급상승 전체 + 유튜브 키워드 상위 15개 + 쇼핑 분야별 상위 5개 + 팀 시드 (오늘 이미 받은 건 건너뜀)
  const targets = [...new Set([
    ...trends.map((t) => t.keyword),
    ...(youtube?.keywords.slice(0, 15).map((k) => k.keyword) || []),
    ...(shopping?.categories.flatMap((c) => c.keywords.slice(0, 5)) || []),
    ...seeds,
  ])];
  const suggestions = { ...(existing?.suggestions || {}) };
  for (const q of targets) {
    if (suggestions[q]) continue;
    suggestions[q] = await suggestAll(q);
    await sleep(150);
  }

  const volumeTargets = [...new Set([...trends.map((t) => t.keyword), ...seeds])];
  const oldLab = existing?.naver?.datalab || {};
  const oldAd = existing?.naver?.searchad || {};
  const [newLab, newAd] = await Promise.all([
    naverDatalab(volumeTargets.filter((k) => !oldLab[k])).catch((e) => { errors.datalab = e.message; return null; }),
    naverSearchAd(volumeTargets.filter((k) => !oldAd[k.replace(/\s+/g, '')])).catch((e) => { errors.searchad = e.message; return null; }),
  ]);
  const datalab = newLab ? { ...oldLab, ...newLab } : existing?.naver?.datalab || null;
  const searchad = newAd ? { ...oldAd, ...newAd } : existing?.naver?.searchad || null;

  // 어제와 비교: 새로 등장한 급상승 키워드 표시, 연속 등장 일수
  const prevStreak = new Map((prev?.google || []).map((t) => [t.keyword, t.streak || 1]));
  for (const t of trends) {
    t.streak = prevStreak.has(t.keyword) ? prevStreak.get(t.keyword) + 1 : 1;
    t.isNew = !prevStreak.has(t.keyword);
  }

  const snapshot = {
    date,
    generatedAt: new Date().toISOString(),
    sources: {
      google: !errors.google,
      youtube: !!youtube,
      naverDatalab: !!datalab,
      naverSearchAd: !!searchad,
      naverShopping: !!shopping,
    },
    google: trends,
    youtube,
    seeds,
    suggestions,
    naverShopping: shopping,
    naver: { datalab, searchad },
    errors,
  };

  await mkdir(`${ROOT}data/history`, { recursive: true });
  await writeFile(`${ROOT}data/history/${date}.json`, JSON.stringify(snapshot));
  await writeFile(`${ROOT}data/latest.json`, JSON.stringify(snapshot));
  const dates = [...new Set([...index.dates, date])].sort().slice(-90);
  await writeFile(`${ROOT}data/index.json`, JSON.stringify({ dates }));

  console.log(`✔ ${date}: 구글 ${trends.length}개, 유튜브 ${youtube ? youtube.videos.length + '개' : '키 없음'}, ` +
    `연관검색어 ${targets.length}개, 데이터랩 ${datalab ? 'O' : '키 없음'}, 검색광고 ${searchad ? 'O' : '키 없음'}, 쇼핑 ${shopping ? shopping.categories.length + '개 분야' : 'X'}`);
  if (Object.keys(errors).length) console.warn('오류:', errors);
}

main().catch((e) => { console.error(e); process.exit(1); });
