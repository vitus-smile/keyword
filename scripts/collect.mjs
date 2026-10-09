// 비투스의 키워드 세상 — 일일 수집기
// 키 없이 동작: 구글 급상승(RSS), 구글·유튜브·네이버 자동완성
// 키가 있으면 추가: 유튜브 인기 동영상(YOUTUBE_API_KEY), 네이버 데이터랩(NAVER_HUB_KEY_ID/KEY 또는 NAVER_CLIENT_ID/SECRET),
//                  네이버 검색광고 키워드도구(NAVER_AD_API_KEY/SECRET/CUSTOMER_ID)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHmac, createHash } from 'node:crypto';
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
// 자정 직후에는 어제 데이터가 아직 없을 수 있어 하루 더 앞을 쓴다
async function naverShopping() {
  for (const back of [1, 2]) {
    const r = await naverShoppingDay(new Date(Date.now() + 9 * 3600e3 - back * 86400e3).toISOString().slice(0, 10));
    if (r.categories.length) return r;
  }
  throw new Error('네이버 쇼핑 전 분야 실패');
}
async function naverShoppingDay(day) {
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
        const keywords = (j.ranks || []).map((r) => r.keyword);
        if (keywords.length) out.push({ cid, name, keywords });
        break;
      } catch (e) {
        console.warn(`쇼핑 ${name} 재시도 ${attempt + 1}:`, e.message);
        await sleep(5000 * (attempt + 1));
      }
    }
    await sleep(1500);
  }
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

// ── 유튜브 인기 동영상 (키 필요) — 전체 + 분야별 ──────────────────
// 객체 키가 숫자면 순서가 바뀌므로 배열로 둔다
const YT_CATS = [['0', '전체'], ['24', '엔터테인먼트'], ['10', '음악'], ['26', '노하우/스타일'], ['22', '인물/블로그'],
  ['25', '뉴스/정치'], ['17', '스포츠'], ['20', '게임'], ['23', '코미디'], ['1', '영화/애니'], ['28', '과학기술'], ['15', '동물']];
// 제목에서 키워드 후보: 해시태그, [대괄호], '따옴표' 속 말
function titleTerms(title) {
  const out = [];
  for (const m of title.matchAll(/#([^\s#]+)/g)) out.push(m[1]);
  for (const m of title.matchAll(/[\[【「『<]([^\]】」』>]{2,20})[\]】」』>]/g)) out.push(m[1]);
  for (const m of title.matchAll(/['‘"“]([^'’"”]{2,20})['’"”]/g)) out.push(m[1]);
  return out;
}
async function youtubeTrending() {
  if (!env.YOUTUBE_API_KEY) return null;
  const categories = [];
  const seen = new Map();
  for (const [cid, name] of YT_CATS) {
    const u = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=KR&maxResults=${cid === '0' ? 50 : 20}${cid === '0' ? '' : `&videoCategoryId=${cid}`}&key=${env.YOUTUBE_API_KEY}`;
    let items;
    try { items = (await (await get(u)).json()).items || []; } catch { continue; } // 한국에 없는 분야는 건너뜀
    if (!items.length) continue;
    const videos = items.map((v) => ({
      id: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      thumb: v.snippet.thumbnails?.medium?.url,
      views: +v.statistics.viewCount || 0,
      tags: (v.snippet.tags || []).slice(0, 15),
      catId: v.snippet.categoryId,
    }));
    for (const v of videos) {
      v.ytCat = v.catId || (cid !== '0' ? cid : null);
      seen.set(v.id, { ...seen.get(v.id), ...v, ytCat: v.ytCat || seen.get(v.id)?.ytCat });
    }
    categories.push({ cid, name, videos });
  }
  if (!categories.length) throw new Error('유튜브 인기 동영상 0건');

  // 전 분야 영상의 태그·제목 키워드 빈도 (한 영상에서는 한 번만 셈)
  const freq = new Map();
  const kwCats = new Map();
  const skip = /^(shorts?|쇼츠|youtube|유튜브|vlog|브이로그|funny|video|official|mv|m\/v|teaser|예고편|full|ep\.?\d*|뉴스|news|예능|정치|리얼리티|유머|코미디|comedy|entertainment|kpop|k-pop|music|음악|게임|game|gaming|동물|스포츠|sports|mbc|kbs|sbs|jtbc|tvn|ytn|mbn)$/i;
  for (const v of seen.values()) {
    const words = new Set([...v.tags, ...titleTerms(v.title)]
      .map((w) => w.trim()).filter((w) => w.length >= 2 && w.length <= 20 && !skip.test(w)));
    for (const w of words) {
      freq.set(w, (freq.get(w) || 0) + 1);
      if (v.ytCat) { const m = kwCats.get(w) || {}; m[v.ytCat] = (m[v.ytCat] || 0) + 1; kwCats.set(w, m); }
    }
  }
  for (const c of categories) for (const v of c.videos) v.ytCat = seen.get(v.id)?.ytCat || (c.cid !== '0' ? c.cid : null);
  const sorted = [...freq].sort((a, b) => b[1] - a[1]);
  const keywords = [...sorted.filter(([, n]) => n >= 2), ...sorted.filter(([, n]) => n < 2)].slice(0, 50)
    .map(([keyword, count]) => {
      const m = kwCats.get(keyword) || {};
      const ytCat = Object.keys(m).sort((a, b) => m[b] - m[a])[0] || null;
      return { keyword, count, ytCat };
    });
  return { videos: categories[0].videos, categories, keywords };
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
  // 데이터랩은 어제까지만 집계되므로 어제를 끝으로 31일
  const end = new Date(Date.now() + 9 * 3600e3 - 86400e3);
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
      for (const r of (await res.json()).results) out[r.title] = r.data.map((d) => Math.round(d.ratio * 10) / 10);
    } catch (e) { console.warn('datalab', e.message); }
  }
  return out;
}

// ── 네이버 블로그 글 수 (키 필요) — 글이 적을수록 블로그로 노리기 쉬움 ──
async function naverBlogCount(keywords) {
  let url, headers;
  if (env.NAVER_HUB_KEY_ID && env.NAVER_HUB_KEY) {
    url = 'https://naverapihub.apigw.ntruss.com/search/v1/blog';
    headers = { 'X-NCP-APIGW-API-KEY-ID': env.NAVER_HUB_KEY_ID, 'X-NCP-APIGW-API-KEY': env.NAVER_HUB_KEY };
  } else if (env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) {
    url = 'https://openapi.naver.com/v1/search/blog.json';
    headers = { 'X-Naver-Client-Id': env.NAVER_CLIENT_ID, 'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET };
  } else return null;
  const out = {};
  for (const k of keywords) {
    try {
      const j = await (await get(`${url}?query=${encodeURIComponent(k)}&display=1&format=json`, { headers })).json();
      if (typeof j.total === 'number') out[k] = j.total;
    } catch (e) { console.warn('blog', k, e.message); }
    await sleep(60);
  }
  return out;
}

// 데이터랩 추이에서 급상승 찾기: 최근 3일 평균 ÷ 그 전 평균 (키워드마다 자기 최댓값으로 정규화)
function findRising(datalab) {
  const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const out = [];
  for (const [keyword, raw] of Object.entries(datalab || {})) {
    if (!raw || raw.length < 14) continue;
    const max = Math.max(...raw);
    if (max <= 0) continue;
    const arr = raw.map((v) => (v / max) * 100);
    const recent = avg(arr.slice(-3));
    const base = avg(arr.slice(0, -3));
    const score = recent / Math.max(base, 5);
    if (score >= 1.5 && recent >= 20) out.push({ keyword, score: Math.round(score * 10) / 10 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 40);
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

// ── 틱톡 인기 해시태그 (APIFY_TOKEN 필요) — 하루 1번, 무료 크레딧(월 5달러) 안에서 ──
// Apify의 data_xplorer/tiktok-trends: 해시태그 1개 0.0015달러 + 실행 1회 0.025달러 → 50개면 하루 약 0.1달러
const TIKTOK_INDUSTRY_TO_CAT = { 'Beauty & Personal Care': '패션·뷰티', 'Apparel & Accessories': '패션·뷰티', Games: '게임',
  'Food & Beverage': '푸드', Pets: '반려동물', Travel: '여행·여가', 'Tech & Electronics': 'IT·가전', 'News & Entertainment': '연예·방송',
  'Sports & Outdoor': '스포츠', 'Baby, Kids & Maternity': '육아', 'Household Products': '생활·리빙', 'Home Improvement': '생활·리빙',
  Health: '생활·리빙', 'Financial Services': '경제·재테크', 'Life Services': '생활·리빙', 'Vehicle & Transportation': '기타' };
async function tiktokTrending() {
  if (!env.APIFY_TOKEN) return null;
  const res = await fetch('https://api.apify.com/v2/acts/data_xplorer~tiktok-trends/run-sync-get-dataset-items?timeout=280', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ countryCode: 'KR', period: '7', sortBy: 'popular', maxHashtags: 50 }),
  });
  if (!res.ok) throw new Error(`apify ${res.status} ${(await res.text()).slice(0, 200)}`);
  const items = await res.json();
  if (items[0]) console.log('틱톡 결과 필드:', Object.keys(items[0]).join(', '));
  const pick = (o, ...ks) => ks.map((k) => k.split('.').reduce((a, x) => a?.[x], o)).find((v) => v != null && v !== '');
  // 필드 이름은 'Hashtag', 'Video Views'처럼 공백 포함 대문자 (2026-10-07 실제 응답 기준)
  const industryOf = (v) => {
    const x = Array.isArray(v) ? v[0] : v;
    return (typeof x === 'string' ? x : x?.value || x?.name || x?.label) || null;
  };
  const hashtags = items.map((it, i) => ({
    keyword: String(pick(it, 'Hashtag', 'hashtagName', 'hashtag_name', 'hashtag', 'name') || '').replace(/^#/, '').trim(),
    rank: +pick(it, 'Rank', 'rank') || i + 1,
    views: +pick(it, 'Video Views', 'videoViews', 'video_views') || 0,
    posts: +pick(it, 'Posts', 'publishCnt', 'posts') || 0,
    industry: industryOf(pick(it, 'Industries', 'Industry', 'industryInfo', 'industry')),
    trend: pick(it, 'Trend Direction') || null,
    isNew: !!pick(it, 'Is New', 'isNew'),
  })).filter((h) => h.keyword).sort((a, b) => a.rank - b.rank);
  if (!hashtags.length) {
    console.log('틱톡 첫 결과 예시:', JSON.stringify(items[0] || null).slice(0, 600));
    throw new Error('틱톡 해시태그 0건');
  }
  return { fetchedAt: new Date().toISOString(), hashtags };
}

// ── 스레드 반응 (THREADS_ACCESS_TOKEN 필요) ──────────────────────
// 스레드 키워드 검색은 좋아요 수를 주지 않아서, 최근 24시간 게시물 수(최대 100)로 반응을 잰다.
// 하루 2,200번 한도 → 통합 상위 100개 × 하루 4번 = 400번
let prevThreadsInfo = null;
async function threadsReaction(keywords) {
  const token = env.THREADS_ACCESS_TOKEN;
  if (!token) return null;
  // 토큰 연장 API는 매번 '새' 토큰을 돌려줘서 Secret에 넣어 둔 토큰은 그대로 만료된다.
  // 그래서 연장하지 않고, 이 토큰을 처음 본 날 + 60일을 만료일로 보여준다 (해시만 저장, 토큰은 저장 안 함)
  const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 12);
  const prevThreads = prevThreadsInfo;
  const firstSeen = prevThreads?.tokenHash === tokenHash && prevThreads.tokenFirstSeen ? prevThreads.tokenFirstSeen : new Date().toISOString();
  const expiresAt = new Date(new Date(firstSeen).getTime() + 60 * 86400e3).toISOString();

  const since = Math.floor(Date.now() / 1000) - 86400;
  const counts = {};
  let fails = 0;
  let lastError = null;
  for (const k of keywords) {
    const u = `https://graph.threads.net/v1.0/keyword_search?q=${encodeURIComponent(k)}&search_type=RECENT&since=${since}&limit=100&fields=id&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(u);
    const j = await res.json().catch(() => ({}));
    if (res.ok) counts[k] = (j.data || []).length;
    else {
      // 권한 문제면 키워드마다 같은 오류라 처음 한 번만 보여주고 멈춘다
      lastError = j.error?.message || `HTTP ${res.status}`;
      console.warn('threads', k, res.status, JSON.stringify(j.error || j).slice(0, 300));
      if (++fails >= 3 && !Object.keys(counts).length) break;
    }
    await sleep(300);
  }
  return { expiresAt, tokenHash, tokenFirstSeen: firstSeen, counts, error: Object.keys(counts).length ? null : lastError };
}

// ── 스레드 반응: Apify (공식 API는 앱 심사 전이라 본인 게시물만 검색돼서 대신 쓴다) ──
// scrapersdelight/threads-keyword-search-scraper: 게시물 1개 0.001달러, 실행 1번에 키워드 여러 개.
// 하루 1번(00시) × 통합 상위 12개 × 최근 24시간 인기 게시물 5개 = 60개 ≈ 하루 0.06달러
const THREADS_KEYWORDS = 12; // 인스타와 합쳐 무료 크레딧 안에 들도록 15 → 12
const THREADS_POSTS_PER_KEYWORD = 5;
async function threadsApify(keywords) {
  if (!env.APIFY_TOKEN) return null;
  const res = await fetch('https://api.apify.com/v2/acts/scrapersdelight~threads-keyword-search-scraper/run-sync-get-dataset-items?timeout=280', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords, searchType: 'top', maxPostsPerKeyword: THREADS_POSTS_PER_KEYWORD,
      maxItems: keywords.length * THREADS_POSTS_PER_KEYWORD, postedWithinDays: 1, excludeReplies: true }),
  });
  if (!res.ok) throw new Error(`apify threads ${res.status} ${(await res.text()).slice(0, 200)}`);
  const items = await res.json();
  if (items[0]) console.log('스레드 결과 필드:', Object.keys(items[0]).join(', '));
  // 작성자 정보는 저장하지 않고 키워드별 합계만 남긴다
  const counts = Object.fromEntries(keywords.map((k) => [k, 0]));
  const engagement = Object.fromEntries(keywords.map((k) => [k, 0]));
  for (const it of items) {
    const k = it.searchKeyword ?? it.keyword;
    if (!(k in counts)) continue;
    counts[k] += 1;
    engagement[k] += (+it.likeCount || 0) + (+it.replyCount || 0) + (+it.repostCount || 0);
  }
  return { source: 'apify', fetchedAt: new Date().toISOString(), counts, engagement, postsPerKeyword: THREADS_POSTS_PER_KEYWORD };
}

// ── 인스타그램 해시태그 (APIFY_TOKEN 필요) ───────────────────────
// apify/instagram-hashtag-analytics-scraper: 해시태그 1개 0.0023달러 + 실행 0.001달러.
// 하루 1번(00시) × 통합 상위 15개 ≈ 하루 0.036달러. 전체 게시물 수와 관련 해시태그를 받고, 어제와 비교해 하루 증가량을 계산한다.
// 월 비용: 틱톡 약 1.7 + 스레드 약 1.9 + 인스타 약 1.1 = 약 4.7달러 (무료 5달러)
const INSTAGRAM_KEYWORDS = 15;
const toHashtag = (k) => k.replace(/[\s#·.,'"!?()\[\]{}:;/\\&+-]/g, '');
async function instagramHashtags(keywords) {
  if (!env.APIFY_TOKEN) return null;
  const tags = [...new Set(keywords.map(toHashtag).filter((t) => t.length >= 2))];
  const res = await fetch('https://api.apify.com/v2/acts/apify~instagram-hashtag-analytics-scraper/run-sync-get-dataset-items?timeout=280', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.APIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashtags: tags, includeLatestPosts: false, includeTopPosts: false }),
  });
  if (!res.ok) throw new Error(`apify instagram ${res.status} ${(await res.text()).slice(0, 200)}`);
  const items = await res.json();
  console.log('인스타 요청:', tags.join(', '));
  console.log('인스타 응답:', items.length + '개');
  const byTag = {};
  for (const it of items) {
    // 한글 태그는 '%EA%B9%80…'처럼 URL 인코딩돼서 온다
    let name = String(it.name || it.id || '').replace(/^#/, '');
    try { name = decodeURIComponent(name); } catch {}
    if (!name) continue;
    byTag[name.toLowerCase()] = {
      posts: Math.round(+it.postsCount || 0),
      perDay: Number.isFinite(+it.postsPerDay) ? +it.postsPerDay : null,
      related: (it.related || []).slice(0, 10).map((r) => r.hash || r.name || r).filter((x) => typeof x === 'string'),
    };
  }
  // 키워드 → 해시태그 결과로 되돌린다
  const result = {};
  for (const k of keywords) {
    const r = byTag[toHashtag(k).toLowerCase()];
    if (r) result[k] = { tag: toHashtag(k), ...r };
  }
  return { source: 'apify', fetchedAt: new Date().toISOString(), tags: result, attempts: 1 };
}

// ── 분야 분류 ───────────────────────────────────────────────────
// 모든 플랫폼을 같은 분야 이름으로 맞춘다
const CATEGORIES = ['연예·방송', '음악', '스포츠', '게임', '뉴스·사회', '경제·재테크', 'IT·가전', '패션·뷰티',
  '푸드', '생활·리빙', '육아', '반려동물', '여행·여가', '기타'];
const SHOP_TO_CAT = { 50000000: '패션·뷰티', 50000001: '패션·뷰티', 50000002: '패션·뷰티', 50000003: 'IT·가전',
  50000004: '생활·리빙', 50000005: '육아', 50000006: '푸드', 50000007: '스포츠', 50000008: '생활·리빙', 50000009: '여행·여가' };
const YT_TO_CAT = { 24: '연예·방송', 10: '음악', 26: '생활·리빙', 22: '기타', 25: '뉴스·사회', 17: '스포츠', 20: '게임',
  23: '연예·방송', 1: '연예·방송', 28: 'IT·가전', 15: '반려동물', 2: '생활·리빙', 19: '여행·여가', 27: '기타', 29: '뉴스·사회' };
// 키워드와 관련 뉴스 제목에 이 단어가 많이 나오는 분야로 분류
const RULES = [
  ['스포츠', /경기|골|감독|리그|선수|우승|야구|축구|농구|배구|골프|올림픽|월드컵|KBO|MLB|EPL|홈런|투수|타자|챔피언|대표팀|PGA|LPGA|마라톤/],
  ['연예·방송', /배우|드라마|예능|아이돌|컴백|열애|결혼|방송|출연|팬미팅|시청률|영화|개봉|웹툰|애니|넷플릭스|티빙|웨이브/],
  ['음악', /가수|앨범|신곡|음원|뮤직|콘서트|MV|차트|멜론|빌보드/],
  ['게임', /게임|롤|LOL|리그오브레전드|배그|발로란트|스팀|닌텐도|플스|피파|메이플|로스트아크/],
  ['경제·재테크', /주가|증시|코스피|코스닥|금리|환율|코인|비트코인|은행|금융|주식|부동산|청약|대출|ETF|상장|실적|배당|연금|세금|보험|신협|카드|적금|예금/],
  ['뉴스·사회', /대통령|국회|의원|장관|정부|검찰|경찰|법원|사고|화재|지진|태풍|선거|정책|북한|재판|사망|구속|수사|인구|지자체|시장|도지사/],
  ['IT·가전', /아이폰|갤럭시|AI|인공지능|출시|애플|삼성전자|챗GPT|반도체|노트북|태블릿|앱|스마트폰|발사|위성|우주/],
  ['패션·뷰티', /화장품|메이크업|코디|패션|스킨케어|향수|자켓|패딩|원피스|신발|운동화|런닝화|러닝화|스니커즈|가방/],
  ['푸드', /맛집|레시피|요리|먹방|라면|커피|디저트|과자|빵|음식|식단/],
  ['육아', /육아|아기|임신|출산|어린이|유아|키즈/],
  ['반려동물', /강아지|고양이|반려|펫|댕댕/],
  ['여행·여가', /여행|단풍|축제|캠핑|호텔|항공|관광|등산|휴가|연휴|공연|전시/],
  ['생활·리빙', /인테리어|청소|살림|건강|다이어트|운동|병원|날씨|가습기|난방/],
];
function ruleCategory(text) {
  let best = null, bestN = 0;
  for (const [cat, re] of RULES) {
    // 긴 단어가 맞을수록 높게 (리그오브레전드 > 리그)
    const n = (text.match(new RegExp(re.source, 'g')) || []).reduce((a, m) => a + m.length, 0);
    if (n > bestN) { best = cat; bestN = n; }
  }
  return best;
}

// ── 통합 순위 ───────────────────────────────────────────────────
// 플랫폼마다 1위 100점에서 순위가 내려갈수록 점수가 줄어든다.
// 쇼핑은 분야가 10개라 1위가 10개 나오므로 70%만 반영한다. 한 플랫폼 안에서는 가장 높은 점수 하나만 센다.
// 여러 플랫폼(구글·네이버·유튜브·틱톡)에 동시에 뜨면 플랫폼 하나 늘 때마다 +50점.
const norm = (k) => k.replace(/\s+/g, '').toLowerCase();
function buildUnified({ trends, rising, shopping, youtube, tiktok }) {
  const map = new Map();
  const add = (kw, platform, label, points, catHint) => {
    const id = norm(kw);
    let e = map.get(id);
    if (!e) map.set(id, (e = { keyword: kw, signals: [], platforms: new Set(), hints: [] }));
    e.signals.push({ platform, label, points: Math.round(points) });
    e.platforms.add(platform);
    if (catHint) e.hints.push(catHint);
  };
  const pts = (i, n) => 100 * (1 - i / Math.max(n, 1));
  trends.forEach((t, i) => add(t.keyword, 'google', `구글 급상승 ${i + 1}위`, pts(i, trends.length),
    ruleCategory([t.keyword, ...t.news.map((n) => n.title)].join(' '))));
  (rising || []).forEach((r, i) => add(r.keyword, 'naver', `네이버 급상승 ${i + 1}위`, pts(i, rising.length), null));
  for (const c of shopping?.categories || []) {
    c.keywords.forEach((k, i) => add(k, 'naver', `쇼핑 ${c.name} ${i + 1}위`, 0.7 * pts(i, c.keywords.length), `shop:${SHOP_TO_CAT[c.cid]}`));
  }
  (youtube?.keywords || []).forEach((k, i) => add(k.keyword, 'youtube', `유튜브 인기영상 ${k.count}개`, pts(i, youtube.keywords.length),
    k.ytCat ? `yt:${YT_TO_CAT[k.ytCat]}` : null));

  (tiktok?.hashtags || []).forEach((h, i) => add(h.keyword, 'tiktok', `틱톡 해시태그 ${h.rank}위`, pts(i, tiktok.hashtags.length),
    TIKTOK_INDUSTRY_TO_CAT[h.industry] ? `tt:${TIKTOK_INDUSTRY_TO_CAT[h.industry]}` : null));

  return [...map.values()].map((e) => {
    // 플랫폼마다 가장 높은 점수 하나만 센다
    const best = {};
    for (const sg of e.signals) best[sg.platform] = Math.max(best[sg.platform] || 0, sg.points);
    const base = Object.values(best).reduce((a, b) => a + b, 0);
    // 분야: 쇼핑 분야 > 키워드·뉴스 단어 규칙 > 유튜브 영상 분야 > 기타
    const shop = e.hints.find((h) => h.startsWith('shop:'));
    const rule = e.hints.find((h) => !h.includes(':')) || ruleCategory(e.keyword);
    const yt = e.hints.find((h) => h.startsWith('yt:') || h.startsWith('tt:'));
    const category = shop?.slice(5) || rule || yt?.slice(3) || '기타';
    return { keyword: e.keyword, category, platforms: [...e.platforms],
      score: Math.round(base + 50 * (e.platforms.size - 1)), signals: e.signals };
  }).sort((a, b) => b.score - a.score);
}

// ── 검색엔진용 정적 페이지 ───────────────────────────────────────
// 화면은 자바스크립트로 그리지만, 검색엔진이 바로 읽도록 페이지마다 그날 목록을 HTML에 미리 써 둔다.
//  - index.html(통합), p/<플랫폼>.html: 같은 앱에 제목·설명·canonical·정적 목록만 다르게
//  - day/<날짜>.html: 날짜별 트렌드 키워드 기록 (계속 쌓이는 롱테일 페이지)
const SITE = 'https://keyword.8282ok.com';
const SITE_NAME = '비투스의 키워드 세상';
const PF = { google: '구글', naver: '네이버', youtube: '유튜브', tiktok: '틱톡' };
const escH = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}만` : `${n}`);
const korDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${y}년 ${m}월 ${dd}일`; };

function pageDefs(snap) {
  const d = korDate(snap.date);
  const li = (arr) => `<ol>${arr.join('')}</ol>`;
  const uni = (snap.unified || []).slice(0, 50).map((u) =>
    `<li><b>${escH(u.keyword)}</b> · ${escH(u.category)} · ${u.platforms.map((p) => PF[p]).join('·')}</li>`);
  const shop = (snap.naverShopping?.categories || []).map((c) =>
    `<h3>${escH(c.name)} 인기 검색어</h3>${li(c.keywords.slice(0, 10).map((k) => `<li>${escH(k)}</li>`))}`).join('');
  const rising = (snap.naver?.rising || []).map((r) => `<li><b>${escH(r.keyword)}</b> · 최근 3일 검색량 ${Math.round((r.score - 1) * 100)}% 상승</li>`);
  const yt = snap.youtube;
  return {
    all: { path: '/', title: `오늘의 트렌드 키워드 통합 순위 (${d})`,
      desc: `${d} 구글·네이버·유튜브·틱톡에서 동시에 뜨는 트렌드 키워드 통합 순위. 1위 ${snap.unified?.[0]?.keyword || ''} 등 블로그·콘텐츠 주제를 하루 4번 갱신해요.`,
      body: `<h2>${d} 트렌드 키워드 통합 순위</h2><p>구글 급상승, 네이버 급상승·쇼핑 인기, 유튜브 인기 영상, 틱톡 인기 해시태그를 합쳐 점수를 매긴 오늘의 순위예요. 여러 플랫폼에 동시에 뜰수록 높은 점수를 받아요.</p>${li(uni)}` },
    google: { path: '/google', title: `구글 급상승 검색어 (${d})`,
      desc: `${d} 구글에서 검색이 급증한 한국 트렌드 키워드 ${snap.google?.length || 0}개와 관련 뉴스, 연관 검색어.`,
      body: `<h2>${d} 구글 급상승 검색어</h2><p>구글 트렌드에서 지금 한국 검색량이 급증한 키워드를 하루 동안 모은 목록이에요.</p>${
        li((snap.google || []).map((t) => `<li><b>${escH(t.keyword)}</b> · 검색 ${escH(t.traffic)}${t.news?.[0] ? ` · ${escH(t.news[0].title)}` : ''}</li>`))}` },
    naver: { path: '/naver', title: `네이버 급상승·쇼핑 인기 검색어 (${d})`,
      desc: `${d} 네이버 검색량이 급상승한 키워드와 패션·화장품·식품 등 쇼핑 분야별 인기 검색어 TOP 20, 블로그 글 수.`,
      body: `<h2>${d} 네이버 급상승 검색어</h2><p>최근 3일 네이버 검색량이 그 전 4주 평균보다 크게 오른 키워드예요.</p>${li(rising)}<h2>네이버 쇼핑 분야별 인기 검색어</h2>${shop}` },
    youtube: { path: '/youtube', title: `유튜브 인기 키워드·인기 영상 (${d})`,
      desc: `${d} 한국 유튜브 인기 동영상에서 많이 나온 키워드와 분야별 인기 영상.`,
      body: `<h2>${d} 유튜브 인기 키워드</h2><p>한국 유튜브 인기 동영상의 태그와 제목에서 많이 나온 키워드예요.</p>${
        li((yt?.keywords || []).slice(0, 30).map((k) => `<li><b>${escH(k.keyword)}</b> · 인기 영상 ${k.count}개</li>`))}<h2>인기 영상</h2>${
        li((yt?.videos || []).slice(0, 15).map((v) => `<li>${escH(v.title)} · ${escH(v.channel)} · 조회 ${fmtN(v.views)}</li>`))}` },
    tiktok: { path: '/tiktok', title: `틱톡 인기 해시태그 순위 (${d})`,
      desc: `${d} 틱톡 한국 인기 해시태그 순위와 게시물 수, 조회수.`,
      body: `<h2>${d} 틱톡 인기 해시태그</h2><p>틱톡 Creative Center 기준 최근 7일 한국 인기 해시태그예요.</p>${
        li((snap.tiktok?.hashtags || []).map((h) => `<li><b>#${escH(h.keyword)}</b>${h.views ? ` · 조회 ${fmtN(h.views)}` : ''}</li>`))}` },
    instagram: { path: '/instagram', title: `인스타그램 해시태그 반응 (${d})`,
      desc: `${d} 트렌드 키워드의 인스타그램 해시태그 게시물 수와 하루 증가량, 관련 해시태그.`,
      body: `<h2>${d} 인스타그램 해시태그 반응</h2><p>통합 순위 상위 키워드를 해시태그로 바꿔 인스타그램 전체 게시물 수와 관련 해시태그를 모았어요.</p>${
        li(Object.values(snap.instagram?.tags || {}).sort((a, b) => (b.dayGrowth ?? -1) - (a.dayGrowth ?? -1) || b.posts - a.posts).map((t) =>
          `<li><b>#${escH(t.tag)}</b> · 게시물 ${fmtN(t.posts)}${t.dayGrowth != null ? ` · 하루 +${fmtN(t.dayGrowth)}` : ''}${t.related?.length ? ` · 관련: ${t.related.slice(0, 5).map((r) => '#' + escH(r)).join(' ')}` : ''}</li>`))}` },
    threads: { path: '/threads', title: `스레드 키워드 반응 (${d})`,
      desc: `${d} 트렌드 키워드가 스레드에서 최근 24시간 동안 얼마나 언급됐는지.`,
      body: `<h2>${d} 스레드 키워드 반응</h2><p>통합 순위 상위 키워드가 스레드에 최근 24시간 동안 올라온 게시물 수예요.</p>${
        li(Object.entries(snap.threads?.engagement || snap.threads?.counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) =>
          `<li><b>${escH(k)}</b> · ${snap.threads?.engagement ? `반응 ${fmtN(n)}` : `${n >= 100 ? '100+' : n}개`}</li>`))}` },
  };
}

const NAV_LINKS = `<nav aria-label="플랫폼별 트렌드"><a href="/">통합 순위</a><a href="/google">구글 급상승</a><a href="/naver">네이버 급상승·쇼핑</a><a href="/youtube">유튜브 인기</a><a href="/tiktok">틱톡 해시태그</a><a href="/instagram">인스타 해시태그</a><a href="/threads">스레드 반응</a><a href="/day">지난 트렌드</a></nav>`;
function headFor(def, date) {
  const url = SITE + def.path;
  const title = `${def.title} · ${SITE_NAME}`;
  const ld = def.path === '/'
    ? { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: `${SITE}/`, inLanguage: 'ko-KR', description: def.desc }
    : { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: def.title.replace(/ \(.*\)$/, ''), item: url }] };
  return `<!--HEAD-->
<title>${escH(title)}</title>
<meta name="description" content="${escH(def.desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${escH(title)}">
<meta property="og:description" content="${escH(def.desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<meta property="article:modified_time" content="${date}">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME} 일별 트렌드" href="${SITE}/rss.xml">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<!--/HEAD-->`;
}

const ARCHIVE_CSS = `body{margin:0;background:#f6f7fb;color:#161a23;font-family:'Noto Sans KR',system-ui,sans-serif;line-height:1.7}
main{max-width:860px;margin:0 auto;padding:32px 16px 80px}a{color:#5b5bf0}h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:28px 0 6px}
.muted{color:#667085;font-size:14px}nav{display:flex;flex-wrap:wrap;gap:10px;font-size:14px;margin:14px 0}
ol,ul{padding-left:22px}li{margin:3px 0}.cols{columns:2;gap:28px}
@media (prefers-color-scheme:dark){body{background:#0e1015;color:#eef0f5}.muted{color:#98a1b3}a{color:#8b8bff}}
@media (max-width:640px){.cols{columns:1}}`;
function archivePage({ title, desc, path, crumbs, body }) {
  const ld = { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map(([name, p], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + p })) };
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escH(title)} · ${SITE_NAME}</title>
<meta name="description" content="${escH(desc)}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${escH(title)}">
<meta property="og:description" content="${escH(desc)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/rss+xml" title="${SITE_NAME} 일별 트렌드" href="${SITE}/rss.xml">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌏</text></svg>">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${ARCHIVE_CSS}</style>
</head>
<body><main>
<div class="muted">${crumbs.map(([n, p]) => `<a href="${p}">${escH(n)}</a>`).join(' › ')}</div>
${body}
${NAV_LINKS}
<p class="muted">${SITE_NAME}는 구글·네이버·유튜브·틱톡 트렌드 키워드를 매일 00·06·12·18시에 모아 보여주는 블로그·콘텐츠 주제 발굴 도구예요. · <a href="/privacy">개인정보처리방침</a></p>
</main></body></html>
`;
}

function dayBody(snap, prevDate, nextDate) {
  const d = korDate(snap.date);
  const defs = pageDefs(snap);
  const byCat = {};
  for (const u of (snap.unified || []).slice(0, 150)) (byCat[u.category] ||= []).push(u.keyword);
  const cats = (snap.categories || Object.keys(byCat)).filter((c) => byCat[c]?.length)
    .map((c) => `<h3>${escH(c)}</h3><p>${byCat[c].slice(0, 12).map(escH).join(', ')}</p>`).join('');
  const pager = `<nav>${prevDate ? `<a href="/day/${prevDate}">← ${korDate(prevDate)}</a>` : ''}${nextDate ? `<a href="/day/${nextDate}">${korDate(nextDate)} →</a>` : ''}</nav>`;
  return `<h1>${d} 트렌드 키워드</h1>
<p class="muted">${d} 하루 동안 구글·네이버·유튜브·틱톡에서 모은 트렌드 키워드 기록이에요. 오늘 순위는 <a href="/">통합 순위</a>에서 볼 수 있어요.</p>
${pager}
${defs.all.body.replace('<ol>', '<ol class="cols">')}
<h2>분야별 트렌드 키워드</h2>${cats}
${defs.google.body.replace('<ol>', '<ol class="cols">')}
${defs.naver.body.split('<h2>네이버 쇼핑')[0]}
${defs.tiktok.body}
${pager}`;
}

async function writeSeo(snap, dates) {
  const defs = pageDefs(snap);
  const tpl = await readFile(`${ROOT}index.html`, 'utf8');
  await mkdir(`${ROOT}p`, { recursive: true });
  for (const [id, def] of Object.entries(defs)) {
    const html = tpl.replace(/<!--HEAD-->[\s\S]*?<!--\/HEAD-->/, headFor(def, snap.date))
      .replace(/<!--SEO-->[\s\S]*?<!--\/SEO-->/, `<!--SEO--><section class="seo">${def.body}${NAV_LINKS}</section><!--/SEO-->`);
    await writeFile(id === 'all' ? `${ROOT}index.html` : `${ROOT}p/${id}.html`, html);
  }

  // 날짜별 기록: 오늘 페이지는 매번 다시 쓰고, 어제 페이지는 '다음 날' 링크를 달기 위해 한 번 더 쓴다
  await mkdir(`${ROOT}day`, { recursive: true });
  const all = [...dates].sort();
  const writeDay = async (s) => {
    const i = all.indexOf(s.date);
    const d = korDate(s.date);
    const top = (s.unified || []).slice(0, 5).map((u) => u.keyword).join(', ');
    await writeFile(`${ROOT}day/${s.date}.html`, archivePage({
      title: `${d} 트렌드 키워드`, desc: `${d} 구글·네이버·유튜브·틱톡 트렌드 키워드 기록. ${top} 등`,
      path: `/day/${s.date}`, crumbs: [[SITE_NAME, '/'], ['지난 트렌드', '/day'], [d, `/day/${s.date}`]],
      body: dayBody(s, all[i - 1], all[i + 1]) }));
  };
  await writeDay(snap);
  const yIdx = all.indexOf(snap.date) - 1;
  if (yIdx >= 0) {
    const y = await readJSON(`${ROOT}data/history/${all[yIdx]}.json`, null);
    if (y?.unified) await writeDay(y);
  }
  const list = [...all].reverse().map((d) => `<li><a href="/day/${d}">${korDate(d)} 트렌드 키워드</a></li>`).join('');
  await writeFile(`${ROOT}day/index.html`, archivePage({
    title: '지난 트렌드 키워드 모음', desc: '날짜별 구글·네이버·유튜브·틱톡 트렌드 키워드 기록 모음',
    path: '/day', crumbs: [[SITE_NAME, '/'], ['지난 트렌드', '/day']],
    body: `<h1>지난 트렌드 키워드 모음</h1><p class="muted">날짜를 누르면 그날 구글·네이버·유튜브·틱톡에서 뜬 키워드를 볼 수 있어요.</p><ul>${list}</ul>` }));

  // RSS (네이버 서치어드바이저 제출용)
  const rssItems = [...all].reverse().slice(0, 30).map((d) => `  <item><title>${korDate(d)} 트렌드 키워드</title><link>${SITE}/day/${d}</link><guid>${SITE}/day/${d}</guid><pubDate>${new Date(`${d}T00:00:00+09:00`).toUTCString()}</pubDate><description>${korDate(d)} 구글·네이버·유튜브·틱톡 트렌드 키워드 기록</description></item>`).join('\n');
  await writeFile(`${ROOT}rss.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n  <title>${SITE_NAME}</title>\n  <link>${SITE}/</link>\n  <description>날짜별 트렌드 키워드 기록</description>\n  <language>ko</language>\n${rssItems}\n</channel></rss>\n`);

  const pages = Object.values(defs).map((d) => d.path);
  const urls = [
    ...pages.map((p) => [p, snap.date, 'daily']),
    ['/day', snap.date, 'daily'],
    ...all.map((d) => [`/day/${d}`, d === snap.date ? snap.date : d, 'monthly']),
    ['/privacy', '2026-10-07', 'yearly'],
  ];
  await writeFile(`${ROOT}sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map(([p, m, f]) => `  <url><loc>${SITE}${p}</loc><lastmod>${m}</lastmod><changefreq>${f}</changefreq></url>`).join('\n')}\n</urlset>\n`);
}

// ── IndexNow: 바뀐 페이지를 네이버·빙에 바로 알린다 (구글은 미지원, 사이트맵으로 수집) ──
// 키 파일은 사이트 루트의 a081b8bd62d44165ee3b1027b75420eb.txt (공개용 값이라 비밀이 아니다)
const INDEXNOW_KEY = 'a081b8bd62d44165ee3b1027b75420eb';
async function pingIndexNow(urls) {
  const body = JSON.stringify({ host: 'keyword.8282ok.com', key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: urls });
  for (const ep of ['https://searchadvisor.naver.com/indexnow', 'https://api.indexnow.org/indexnow']) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body });
      console.log('IndexNow', new URL(ep).host, r.status);
    } catch (e) { console.warn('IndexNow 실패', ep, e.message); }
  }
}

// ── 실행 ─────────────────────────────────────────────────────────
async function readJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  const date = todayKST();
  const errors = {};

  // 하루 여러 번 실행되면 오늘 스냅샷에 누적한다 (구글 RSS는 한 번에 10개만 줌)
  const existing = await readJSON(`${ROOT}data/history/${date}.json`, null);
  const index = await readJSON(`${ROOT}data/index.json`, { dates: [] });
  const prevDate = index.dates.filter((d) => d < date).at(-1);
  const prev = prevDate ? await readJSON(`${ROOT}data/history/${prevDate}.json`, null) : null;

  let fresh = [];
  // 플랫폼별 마지막 갱신 시각 (이번에 새로 받은 것만 바꾸고 나머지는 이어받는다)
  const updated = { ...(existing?.updated || {}) };
  const now = new Date().toISOString();
  try { fresh = await googleTrends(); updated.google = now; } catch (e) { errors.google = e.message; }
  const byKw = new Map((existing?.google || []).map((t) => [t.keyword, t]));
  for (const t of fresh) {
    const old = byKw.get(t.keyword);
    byKw.set(t.keyword, old ? { ...t, trafficNum: Math.max(old.trafficNum, t.trafficNum),
      traffic: old.trafficNum > t.trafficNum ? old.traffic : t.traffic, firstSeen: old.firstSeen }
      : { ...t, firstSeen: new Date().toISOString() });
  }
  const trends = [...byKw.values()].sort((a, b) => b.trafficNum - a.trafficNum);

  let youtube = existing?.youtube || null;
  try {
    const y = await youtubeTrending();
    if (y) { youtube = y; updated.youtube = now; }
  } catch (e) { errors.youtube = e.message; }

  // 틱톡은 비용 때문에 하루 한 번, 00시 갱신 때 받는다. 00시에 실패했을 때만 다음 갱신에서 다시 시도한다
  let tiktok = existing?.tiktok || null;
  if (!tiktok) {
    try { tiktok = await tiktokTrending(); if (tiktok) updated.tiktok = now; } catch (e) { errors.tiktok = e.message; }
  }
  // 광고·라이브 이벤트 같은 틱톡 시스템 해시태그는 트렌드가 아니라서 뺀다
  const TIKTOK_NOISE = /^(paidpartnership|liveincentiveprogram|liveiseasy|livefest|fyp|foryou|foryoupage|fypシ|viral|us|ad|ads|sponsored|tiktok|tiktokshop|capcut|trend|trending)$/i;
  if (tiktok) tiktok.hashtags = tiktok.hashtags.filter((h) => !TIKTOK_NOISE.test(h.keyword));
  if (tiktok && prev?.tiktok) {
    const before = new Map(prev.tiktok.hashtags.map((h) => [h.keyword, h.rank]));
    for (const h of tiktok.hashtags) h.prevRank = before.get(h.keyword) ?? null;
  }

  // 네이버 쇼핑은 어제 하루치라 하루 한 번만 받는다
  let shopping = existing?.naverShopping || null;
  if (!shopping || shopping.categories.length < Object.keys(NAVER_CATS).length) {
    try { shopping = await naverShopping(); updated.naverShopping = now; } catch (e) { errors.naverShopping = e.message; }
  }
  if (shopping) {
    const prevShop = new Set((prev?.naverShopping?.categories || []).flatMap((c) => c.keywords.map((k) => `${c.cid}|${k}`)));
    for (const c of shopping.categories) c.newOnes = prev?.naverShopping ? c.keywords.filter((k) => !prevShop.has(`${c.cid}|${k}`)) : [];
  }

  // 네이버 추이 후보: 구글 급상승 + 쇼핑 인기어 전부 + 유튜브 키워드 + 구글 급상승의 네이버 연관 검색어
  const suggestions = { ...(existing?.suggestions || {}) };
  const labPool = [...new Set([
    ...trends.map((t) => t.keyword),
    ...(shopping?.categories.flatMap((c) => c.keywords) || []),
    ...(youtube?.keywords.slice(0, 30).map((k) => k.keyword) || []),
    ...(tiktok?.hashtags.slice(0, 30).map((h) => h.keyword) || []),
    ...trends.slice(0, 10).flatMap((t) => (suggestions[t.keyword]?.naver || []).slice(0, 3)),
  ])];
  const oldLab = existing?.naver?.datalab || {};
  const oldAd = existing?.naver?.searchad || {};
  const [newLab, newAd] = await Promise.all([
    naverDatalab(labPool).catch((e) => { errors.datalab = e.message; return null; }),
    naverSearchAd(labPool.filter((k) => !oldAd[k.replace(/\s+/g, '')])).catch((e) => { errors.searchad = e.message; return null; }),
  ]);
  if (newLab) updated.naverRising = now;
  const datalab = newLab ? { ...oldLab, ...newLab } : existing?.naver?.datalab || null;
  const searchad = newAd ? { ...oldAd, ...newAd } : existing?.naver?.searchad || null;
  const rising = datalab ? findRising(datalab) : null;

  // 연관 검색어: 급상승 전체 + 네이버 급상승 + 유튜브 키워드 상위 15개 + 쇼핑 분야별 상위 5개 + 팀 시드 (오늘 이미 받은 건 건너뜀)
  const targets = [...new Set([
    ...trends.map((t) => t.keyword),
    ...(rising?.map((r) => r.keyword) || []),
    ...(youtube?.keywords.slice(0, 15).map((k) => k.keyword) || []),
    ...(tiktok?.hashtags.slice(0, 20).map((h) => h.keyword) || []),
    ...(shopping?.categories.flatMap((c) => c.keywords.slice(0, 5)) || []),
  ])];
  for (const q of targets) {
    if (suggestions[q]) continue;
    suggestions[q] = await suggestAll(q);
    await sleep(150);
  }

  // 화면에 나오는 키워드의 블로그 글 수
  const oldBlog = existing?.naver?.blog || {};
  const blogPool = [...new Set([...labPool, ...(rising?.map((r) => r.keyword) || [])])].filter((k) => oldBlog[k] == null);
  let blog = existing?.naver?.blog || null;
  try {
    const newBlog = await naverBlogCount(blogPool);
    if (newBlog) blog = { ...oldBlog, ...newBlog };
  } catch (e) { errors.blog = e.message; }

  const unified = buildUnified({ trends, rising, shopping, youtube, tiktok });
  let threads = null;
  prevThreadsInfo = existing?.threads || prev?.threads || null;
  // 공식 API에 결과가 있으면 그걸 쓰고(앱 심사 통과 후), 아니면 Apify로 하루 1번 받는다
  try {
    const official = await threadsReaction(unified.slice(0, 100).map((u) => u.keyword));
    if (official && Object.keys(official.counts).length) { threads = official; updated.threads = now; }
  } catch (e) { errors.threads = e.message; }
  // 인스타는 하루 1번(그날 첫 갱신)만 받고, 어제 게시물 수와 비교해 하루 증가량을 붙인다
  let instagram = existing?.instagram || null;
  // 결과가 거의 비었으면 그날 한 번만 다시 시도한다 (비용 때문에 최대 2번)
  if (instagram && Object.keys(instagram.tags).length < 5 && (instagram.attempts || 1) < 3) {
    const tries = (instagram.attempts || 1) + 1;
    instagram = null;
    try { instagram = await instagramHashtags(unified.slice(0, INSTAGRAM_KEYWORDS).map((u) => u.keyword)); if (instagram) instagram.attempts = tries; } catch (e) { errors.instagram = e.message; }
  }
  if (!instagram) {
    try {
      instagram = await instagramHashtags(unified.slice(0, INSTAGRAM_KEYWORDS).map((u) => u.keyword));
      if (instagram) updated.instagram = now;
    } catch (e) { errors.instagram = e.message; }
    if (instagram) updated.instagram = updated.instagram || now;
    if (instagram && prev?.instagram) {
      const before = Object.fromEntries(Object.values(prev.instagram.tags).map((t) => [t.tag.toLowerCase(), t.posts]));
      for (const t of Object.values(instagram.tags)) {
        const b = before[t.tag.toLowerCase()];
        t.dayGrowth = b != null && t.posts >= b ? t.posts - b : null;
      }
    }
  }

  if (!threads) {
    threads = existing?.threads?.source === 'apify' ? existing.threads : null;
    if (!threads) {
      try {
        threads = await threadsApify(unified.slice(0, THREADS_KEYWORDS).map((u) => u.keyword));
        if (threads) updated.threads = now;
      } catch (e) { errors.threadsApify = e.message; }
    }
  }
  const catOf = new Map(unified.map((u) => [norm(u.keyword), u.category]));
  const cat = (k) => catOf.get(norm(k)) || ruleCategory(k) || '기타';
  for (const t of trends) t.category = cat(t.keyword);
  for (const r of rising || []) r.category = cat(r.keyword);
  if (youtube) {
    for (const k of youtube.keywords) k.category = cat(k.keyword);
    for (const c of youtube.categories) for (const v of c.videos) v.category = YT_TO_CAT[v.ytCat] || '기타';
  }
  if (shopping) for (const c of shopping.categories) c.category = SHOP_TO_CAT[c.cid];
  if (tiktok) for (const h of tiktok.hashtags) h.category = cat(h.keyword);

  // 어제와 비교: 새로 등장한 급상승 키워드 표시, 연속 등장 일수
  const prevStreak = new Map((prev?.google || []).map((t) => [t.keyword, t.streak || 1]));
  for (const t of trends) {
    t.streak = prevStreak.has(t.keyword) ? prevStreak.get(t.keyword) + 1 : 1;
    t.isNew = !prevStreak.has(t.keyword);
  }

  // 이 기능을 넣기 전에 받아 둔 데이터는 그 스냅샷이 만들어진 시각을 갱신 시각으로 본다
  const had = { google: trends.length, youtube, tiktok, naverShopping: shopping, naverRising: datalab, threads };
  // (instagram은 아래에서 별도로 갱신 시각을 기록)
  for (const [k, v] of Object.entries(had)) if (v && !updated[k]) updated[k] = tiktok && k === 'tiktok' ? tiktok.fetchedAt : existing?.generatedAt || now;

  const snapshot = {
    date,
    generatedAt: now,
    updated,
    sources: {
      google: !errors.google,
      youtube: !!youtube,
      naverDatalab: !!datalab,
      naverSearchAd: !!searchad,
      naverBlog: !!blog,
      naverShopping: !!shopping,
      tiktok: !!tiktok,
      threads: !!threads,
      instagram: !!instagram,
    },
    google: trends,
    youtube,
    categories: CATEGORIES,
    unified: unified.slice(0, 300),
    suggestions,
    naverShopping: shopping,
    tiktok,
    threads,
    instagram,
    naver: { datalab, searchad, rising, blog },
    errors,
  };

  await mkdir(`${ROOT}data/history`, { recursive: true });
  await writeFile(`${ROOT}data/history/${date}.json`, JSON.stringify(snapshot));
  await writeFile(`${ROOT}data/latest.json`, JSON.stringify(snapshot));
  const dates = [...new Set([...index.dates, date])].sort().slice(-90);
  await writeFile(`${ROOT}data/index.json`, JSON.stringify({ dates }));

  await writeSeo(snapshot, dates);
  // 깃허브 액션에서만 알린다 (배포 전에 알리면 옛 페이지를 가져가므로 몇 분 늦게 수집돼도 괜찮다)
  if (env.GITHUB_ACTIONS) await pingIndexNow(['/', '/google', '/naver', '/youtube', '/tiktok', '/instagram', '/threads', '/day', `/day/${date}`].map((p) => SITE + p));

  console.log(`✔ ${date}: 구글 ${trends.length}개, 유튜브 ${youtube ? youtube.videos.length + '개' : '키 없음'}, ` +
    `연관검색어 ${targets.length}개, 데이터랩 ${datalab ? Object.keys(datalab).length + '개(급상승 ' + rising.length + ')' : '키 없음'}, 블로그 ${blog ? Object.keys(blog).length + '개' : '키 없음'}, 검색광고 ${searchad ? 'O' : '키 없음'}, 쇼핑 ${shopping ? shopping.categories.length + '개 분야' : 'X'}, 틱톡 ${tiktok ? tiktok.hashtags.length + '개' : '키 없음'}, 스레드 ${threads ? Object.keys(threads.counts).length + '개' : '키 없음'}, 인스타 ${instagram ? Object.keys(instagram.tags).length + '개' : '없음'}`);
  if (Object.keys(errors).length) console.warn('오류:', errors);
}

main().catch((e) => { console.error(e); process.exit(1); });
