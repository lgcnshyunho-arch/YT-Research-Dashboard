// server/yt.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

// CORS (필요시 수정)
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: ORIGIN }));

// Keys & client
const YT_KEY = (process.env.YT_API_KEY || '').trim();
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// OpenAI 호출 최대 대기시간(ms) — 기본 90초
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);
const openai = OPENAI_KEY
  ? new OpenAI({ apiKey: OPENAI_KEY, timeout: OPENAI_TIMEOUT_MS })
  : null;

const MAX_PAGES = Number(process.env.YT_MAX_PAGES || 1);
const MAX_KEYWORDS = Number(process.env.YT_MAX_KEYWORDS || 3);
const UNIT_BUDGET = Number(process.env.YT_UNIT_BUDGET || 8000);

let unitsUsed = 0;
function spend(cost) {
  unitsUsed += cost;
  if (unitsUsed > UNIT_BUDGET) {
    throw new Error(`predicted quota budget exceeded (used≈${unitsUsed})`);
  }
}


// ---------------------------------- YouTube helpers
const isChannelId = (s = '') => /^UC[0-9A-Za-z_-]{22}$/.test(s);

// 채널 정보(핸들/ID)
async function fetchChannelInfo(handleOrId) {
  if (!YT_KEY) throw new Error('YT_API_KEY missing');

  // 1) 채널ID 바로 조회
  if (isChannelId(handleOrId)) {
    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('part', 'snippet,statistics');
    url.searchParams.set('id', handleOrId);
    url.searchParams.set('key', YT_KEY);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`channels failed: ${r.status}`);
    const js = await r.json();
    const c = js.items?.[0];
    if (!c) throw new Error('channel not found');
    return {
      channelId: c.id,
      title: c.snippet?.title,
      description: c.snippet?.description,
      thumbnails: c.snippet?.thumbnails || {},
      stats: {
        subscriberCount: c.statistics?.subscriberCount,
        videoCount: c.statistics?.videoCount,
      }
    };
  }

  // 2) 핸들/문자열 → search로 채널 찾기
  const q = String(handleOrId || '').replace(/^@/, '');
  const sUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  sUrl.searchParams.set('part', 'snippet');
  sUrl.searchParams.set('type', 'channel');
  sUrl.searchParams.set('q', q);
  sUrl.searchParams.set('maxResults', '1');
  sUrl.searchParams.set('key', YT_KEY);
  const sr = await fetch(sUrl);
  if (!sr.ok) throw new Error(`search failed: ${sr.status}`);
  const sjs = await sr.json();
  const ch = sjs.items?.[0];
  if (!ch) throw new Error('channel not found');

  return await fetchChannelInfo(ch.snippet?.channelId || ch.id?.channelId || '');
}

// 채널 업로드 목록 수집
async function fetchChannelVideos(channelId, { sinceISO, maxPages = 3 }) {
  const items = [];
  let pageToken = '';
  for (let p = 0; p < maxPages; p++) {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('channelId', channelId);
    url.searchParams.set('maxResults', '50');
    if (sinceISO) url.searchParams.set('publishedAfter', sinceISO);
    url.searchParams.set('order', 'date');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('key', YT_KEY);

    const r = await fetch(url);
    if (!r.ok) throw new Error(`channel search failed: ${r.status}`);
    const js = await r.json();

    const ids = (js.items || []).map(v => v.id?.videoId).filter(Boolean);
    if (!ids.length) break;

    const vurl = new URL('https://www.googleapis.com/youtube/v3/videos');
    vurl.searchParams.set('part', 'snippet,statistics');
    vurl.searchParams.set('id', ids.join(','));
    vurl.searchParams.set('key', YT_KEY);

    const vr = await fetch(vurl);
    if (!vr.ok) throw new Error(`videos failed: ${vr.status}`);
    const vjs = await vr.json();

    (vjs.items || []).forEach(v => {
      items.push({
        videoId: v.id,
        title: v.snippet?.title || '',
        publishedAt: v.snippet?.publishedAt,
        channelId: v.snippet?.channelId,
        channelTitle: v.snippet?.channelTitle,
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
      });
    });

    pageToken = js.nextPageToken || '';
    if (!pageToken) break;
  }
  return items;
}

// 키워드 검색 → 영상 상세
async function ytSearchFetch({ q, sinceISO, regionCode, relevanceLanguage, maxPages = 1 }) {
  if (!YT_KEY) throw new Error('YT_API_KEY missing');
  const queries = Array.isArray(q) ? q : String(q || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!queries.length) return [];

  const items = [];
  for (const term of queries) {
    let pageToken = '';
    for (let p = 0; p < maxPages; p++) {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('type', 'video');
      url.searchParams.set('maxResults', '50');
      url.searchParams.set('q', term);
      if (sinceISO) url.searchParams.set('publishedAfter', sinceISO);
      if (regionCode) url.searchParams.set('regionCode', regionCode);
      if (relevanceLanguage) url.searchParams.set('relevanceLanguage', relevanceLanguage);
      url.searchParams.set('order', 'date');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      url.searchParams.set('key', YT_KEY);

      const r = await fetch(url);
      if (!r.ok) throw new Error(`YT search failed: ${r.status}`);
      const js = await r.json();

      const ids = (js.items || []).map(v => v.id?.videoId).filter(Boolean);
      if (!ids.length) break;

      const vurl = new URL('https://www.googleapis.com/youtube/v3/videos');
      vurl.searchParams.set('part', 'snippet,statistics');
      vurl.searchParams.set('id', ids.join(','));
      vurl.searchParams.set('key', YT_KEY);
      const vr = await fetch(vurl);
      if (!vr.ok) throw new Error(`YT videos failed: ${vr.status}`);
      const vjs = await vr.json();

      (vjs.items || []).forEach(v => {
        items.push({
          videoId: v.id,
          title: v.snippet?.title || '',
          publishedAt: v.snippet?.publishedAt,
          channelId: v.snippet?.channelId,
          channelTitle: v.snippet?.channelTitle,
          views: Number(v.statistics?.viewCount || 0),
          likes: Number(v.statistics?.likeCount || 0),
          comments: Number(v.statistics?.commentCount || 0),
        });
      });

      pageToken = js.nextPageToken || '';
      if (!pageToken) break;
    }
  }
  return items;
}

// 메트릭 계산
function buildMetricsFromRows(rows, tzOffsetMinutes = 0) {
  const byDay = {};
  rows.forEach(r => {
    const t = new Date(r.publishedAt).getTime() + tzOffsetMinutes * 60 * 1000;
    const k = new Date(t).toISOString().slice(0, 10);
    byDay[k] = (byDay[k] || 0) + 1;
  });

  const ordered = rows.slice().sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  const top = rows.slice().sort((a, b) => b.views - a.views).slice(0, 10);

  const byCh = {};
  rows.forEach(r => {
    const key = r.channelTitle || r.channelId || 'unknown';
    const o = byCh[key] || (byCh[key] = { channelTitle: key, count: 0, views: 0 });
    o.count += 1; o.views += Number(r.views || 0);
  });
  const topChannels = Object.values(byCh).sort((a, b) => b.count - a.count).slice(0, 5);

  return { byDay, rows: ordered, top, topChannels, total: rows.length };
}

// ---------------------------------- Routes

// 채널 확인
app.get('/api/yt/resolve', async (req, res) => {
  try {
    const h = req.query.handle || '';
    const info = await fetchChannelInfo(h);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 지표(채널)
app.get('/api/yt/metrics-by-handle', async (req, res) => {
  try {
    const handle = req.query.handle || '';
    const days = Number(req.query.days || '180');
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const info = await fetchChannelInfo(handle);
    const videos = await fetchChannelVideos(info.channelId, { sinceISO: since, maxPages: 2 });
    const metrics = buildMetricsFromRows(videos, Number(req.query.tzOffsetMinutes || 0));
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 지표(키워드)
app.get('/api/yt/metrics-by-query', async (req, res) => {
  try {
    // 키워드 검색은 사용자가 명시적으로 버튼을 눌렀을 때만 허용
    if (process.env.YT_REQUIRE_MANUAL_QUERY !== '0') {
      const manual = req.query.manual === '1' || req.headers['x-manual'] === '1';
      if (!manual) {
         return res.status(400).json({ error: 'manual=1 required for keyword search' });
      }
    }

    const q = req.query.q || '';
    const days = Number(req.query.days || '180');
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const videos = await ytSearchFetch({
      q,
      sinceISO: since,
      regionCode: req.query.region || '',
      relevanceLanguage: req.query.lang || '',
      maxPages: 1
    });
    const metrics = buildMetricsFromRows(videos, Number(req.query.tzOffsetMinutes || 0));
    res.json({ query: q, days, ...metrics });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 증분 수집(채널) — 간단히 현재 수집 결과만 반환
app.post('/api/yt/ingest', async (req, res) => {
  try {
    const handle = req.body.handle || '';
    const since = req.body.since || new Date(Date.now() - 180*86400000).toISOString();
    const info = await fetchChannelInfo(handle);
    const videos = await fetchChannelVideos(info.channelId, { sinceISO: since, maxPages: 2 });
    res.json({ ok: true, count: videos.length });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// 인사이트(채널/키워드 겸용)
app.get('/api/yt/insight', async (req, res) => {
  try {
    const days = Number(req.query.days || '180');

    // --- 키워드 모드 ---
    if (req.query.q) {
      if (process.env.YT_REQUIRE_MANUAL_QUERY !== '0') {
        const manual = req.query.manual === '1' || req.headers['x-manual'] === '1';
        if (!manual) {
          return res.status(400).json({ error: 'manual=1 required for keyword search' });
        }
      }

      const q = req.query.q;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const videos = await ytSearchFetch({
        q,
        sinceISO: since,
        regionCode: req.query.region || '',
        relevanceLanguage: req.query.lang || '',
        maxPages: 1
      });
      const m = buildMetricsFromRows(videos, Number(req.query.tzOffsetMinutes || 0));
      const sample = m.rows.slice(-250).map(v => ({
        d: v.publishedAt.slice(0,10), t: v.title.slice(0,120), v: v.views, l: v.likes, c: v.comments
      }));

      if (!openai) return res.json({ mode:'query', query:q, days, text: '(OpenAI key missing)' });

      const sys =
        '당신은 유튜브 데이터에서 콘텐츠 전략을 요약하는 마케팅 분석가입니다. ' +
        '항상 Markdown으로, 섹션 제목은 ###, 항목은 - 불릿으로 간결히 작성하세요.';
      const user =
        `키워드: ${q}\n분석기간: 최근 ${days}일\n` +
        `일자별 업로드 수(byDay): ${JSON.stringify(m.byDay).slice(0, 4000)}\n` +
        `샘플(최대 250개): ${JSON.stringify(sample).slice(0, 9000)}\n\n` +
        '요청:\n' +
        '1) 업로드 빈도/요일·시즌 패턴\n' +
        '2) 메시지/제품/시리즈 변화(추정 근거)\n' +
        '3) 성과 TOP 영상 공통점(제목/형식/길이/시기)\n' +
        '4) 업로드 컨텐츠의 특성에 따른 유형 분류 및 인사이트\n' +
        '5) 리스크/모니터링 포인트';

      const out = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
      });
      const text = out.choices?.[0]?.message?.content || '(no content)';
      return res.json({ mode:'query', query:q, days, text });
    }

    // --- 채널 모드 ---
    const channelId = req.query.channelId;
    const handle = req.query.handle;
    if (!channelId && !handle) throw new Error('channelId or handle required');

    const info = await fetchChannelInfo(channelId || handle);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const videos = await fetchChannelVideos(info.channelId, { sinceISO: since, maxPages: 2 });
    const byDay = buildMetricsFromRows(videos).byDay;
    const sample = videos.slice(-250).map(v => ({
      d: v.publishedAt.slice(0,10), t: v.title.slice(0,120), v: v.views, l: v.likes, c: v.comments
    }));

    if (!openai) return res.json({ mode:'channel', channelId: info.channelId, days, text: '(OpenAI key missing)' });

    const sys =
      '당신은 유튜브 채널 데이터를 요약하는 마케팅 분석가입니다. ' +
      '항상 Markdown으로, 섹션 제목은 ###, 항목은 - 불릿으로 간결히 작성하세요.';
    const user =
      `채널ID: ${info.channelId}\n분석기간: 최근 ${days}일\n` +
      `일자별 업로드 수(byDay): ${JSON.stringify(byDay).slice(0, 4000)}\n` +
      `샘플(최대 250개): ${JSON.stringify(sample).slice(0, 9000)}\n\n` +
      '요청:\n' +
      '1) 업로드 빈도/요일·시즌 패턴\n' +
      '2) 메시지/제품/시리즈 변화(추정 근거)\n' +
      '3) 성과 TOP 영상 공통점(제목/형식/길이/시기)\n' +
      '4) 주요 업로드 컨텐츠의 유형 분석(제품 홍보/USP강조/브랜드 캠페인/사회공헌/참여 독려)\n' +
      '5) 리스크/모니터링 포인트';

    const out = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
    });
    const text = out.choices?.[0]?.message?.content || '(no content)';
    res.json({ mode:'channel', channelId: info.channelId, days, text });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------------------------------- start
const PORT = Number(process.env.YT_PORT || 8820);
app.listen(PORT, () => console.log(`YT API on http://localhost:${PORT}`));
