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
async function threadsReaction(keywords) {
  const token = env.THREADS_ACCESS_TOKEN;
  if (!token) return null;
  // 장기 토큰(60일) 연장. 같은 토큰이면 만료일만 늘어나고, 새 토큰이 오면 Secret을 바꿔야 한다
  let expiresAt = null;
  try {
    const r = await (await get(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`)).json();
    if (r.expires_in) expiresAt = new Date(Date.now() + r.expires_in * 1000).toISOString();
    if (r.access_token && r.access_token !== token) console.warn('⚠️ 스레드 토큰이 새로 발급됐어요. THREADS_ACCESS_TOKEN Secret을 바꿔야 합니다.');
  } catch (e) { console.warn('스레드 토큰 연장 실패:', e.message); }

  const since = Math.floor(Date.now() / 1000) - 86400;
  const counts = {};
  for (const k of keywords) {
    try {
      const u = `https://graph.threads.net/v1.0/keyword_search?q=${encodeURIComponent(k)}&search_type=RECENT&since=${since}&limit=100&fields=id&access_token=${encodeURIComponent(token)}`;
      const j = await (await get(u)).json();
      counts[k] = (j.data || []).length;
    } catch (e) { console.warn('threads', k, e.message); }
    await sleep(300);
  }
  return { expiresAt, counts };
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

// ── 검색엔진용 정적 내용 ─────────────────────────────────────────
// 화면은 자바스크립트로 그리지만, 검색엔진이 바로 읽을 수 있게 오늘의 통합 순위를 index.html에 미리 써 둔다
const SITE = 'https://keyword.8282ok.com';
async function writeSeo(snap) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PF = { google: '구글', naver: '네이버', youtube: '유튜브', tiktok: '틱톡' };
  const items = (snap.unified || []).slice(0, 50).map((u) =>
    `<li><b>${esc(u.keyword)}</b> · ${esc(u.category)} · ${u.platforms.map((p) => PF[p]).join('·')}</li>`).join('');
  const block = `<!--SEO--><section class="seo"><h2>${snap.date} 오늘의 트렌드 키워드 통합 순위</h2>` +
    `<p>구글 급상승, 네이버 급상승·쇼핑 인기, 유튜브 인기 영상, 틱톡 인기 해시태그를 합쳐 매긴 순위예요.</p><ol>${items}</ol></section><!--/SEO-->`;
  const path = `${ROOT}index.html`;
  const html = await readFile(path, 'utf8');
  await writeFile(path, html.replace(/<!--SEO-->[\s\S]*?<!--\/SEO-->/, block));

  const pages = ['/', '/google', '/naver', '/youtube', '/tiktok', '/threads', '/privacy'];
  await writeFile(`${ROOT}sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    pages.map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${snap.date}</lastmod><changefreq>${p === '/privacy' ? 'yearly' : 'daily'}</changefreq></url>`).join('\n')}\n</urlset>\n`);
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

  // 틱톡은 비용 때문에 하루 한 번, 00시 갱신 때 받는다. 00시에 실패했을 때만 다음 갱신에서 다시 시도한다
  let tiktok = existing?.tiktok || null;
  if (!tiktok) {
    try { tiktok = await tiktokTrending(); } catch (e) { errors.tiktok = e.message; }
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
    try { shopping = await naverShopping(); } catch (e) { errors.naverShopping = e.message; }
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
  try { threads = await threadsReaction(unified.slice(0, 100).map((u) => u.keyword)); } catch (e) { errors.threads = e.message; }
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

  const snapshot = {
    date,
    generatedAt: new Date().toISOString(),
    sources: {
      google: !errors.google,
      youtube: !!youtube,
      naverDatalab: !!datalab,
      naverSearchAd: !!searchad,
      naverBlog: !!blog,
      naverShopping: !!shopping,
      tiktok: !!tiktok,
      threads: !!threads,
    },
    google: trends,
    youtube,
    categories: CATEGORIES,
    unified: unified.slice(0, 300),
    suggestions,
    naverShopping: shopping,
    tiktok,
    threads,
    naver: { datalab, searchad, rising, blog },
    errors,
  };

  await mkdir(`${ROOT}data/history`, { recursive: true });
  await writeFile(`${ROOT}data/history/${date}.json`, JSON.stringify(snapshot));
  await writeFile(`${ROOT}data/latest.json`, JSON.stringify(snapshot));
  const dates = [...new Set([...index.dates, date])].sort().slice(-90);
  await writeFile(`${ROOT}data/index.json`, JSON.stringify({ dates }));

  await writeSeo(snapshot);

  console.log(`✔ ${date}: 구글 ${trends.length}개, 유튜브 ${youtube ? youtube.videos.length + '개' : '키 없음'}, ` +
    `연관검색어 ${targets.length}개, 데이터랩 ${datalab ? Object.keys(datalab).length + '개(급상승 ' + rising.length + ')' : '키 없음'}, 블로그 ${blog ? Object.keys(blog).length + '개' : '키 없음'}, 검색광고 ${searchad ? 'O' : '키 없음'}, 쇼핑 ${shopping ? shopping.categories.length + '개 분야' : 'X'}, 틱톡 ${tiktok ? tiktok.hashtags.length + '개' : '키 없음'}, 스레드 ${threads ? Object.keys(threads.counts).length + '개' : '키 없음'}`);
  if (Object.keys(errors).length) console.warn('오류:', errors);
}

main().catch((e) => { console.error(e); process.exit(1); });
