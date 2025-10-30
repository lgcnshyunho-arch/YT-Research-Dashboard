// server/yt.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { google } from 'googleapis';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

/* =========================
   환경변수
   ========================= */
const PORT = Number(process.env.PORT || 8820);

// CORS_ORIGIN 또는 CLIENT_ORIGIN 둘 다 허용(쉼표로 다중 도메인 지원, '*' 허용 시 전체 허용)
const RAW_ORIGINS =
  process.env.CORS_ORIGIN ||
  process.env.CLIENT_ORIGIN ||
  'http://localhost:5173';
const ALLOWED_ORIGINS = RAW_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

// API 키
const YT_API_KEY = (process.env.YT_API_KEY || '').trim();
if (!YT_API_KEY) console.warn('[warn] YT_API_KEY is empty. YouTube API calls will fail.');

// --- OpenAI ---
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90_000);

// --- Gemini ---
const LLM_PROVIDER = (process.env.LLM_PROVIDER || '').toLowerCase(); // 'openai' | 'gemini' | ''
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_MAX_TOKENS = Number(process.env.GEMINI_MAX_TOKENS || 1600);
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 90_000);

// 인사이트에 투입할 최대 행 수
const INSIGHT_MAX_ROWS = Number(process.env.INSIGHT_MAX_ROWS || 1000);

// 수집 한도/배치 (videos.list 상한 = 50)
const RAW_FETCH_MAX = Number(process.env.YT_FETCH_MAX_NEW || 2000);
const YT_FETCH_MAX_NEW = Math.max(1, RAW_FETCH_MAX);

const RAW_BATCH = Number(process.env.YT_VIDEOS_BATCH || 50);
const YT_VIDEOS_BATCH = Math.max(1, Math.min(50, RAW_BATCH)); // ★ 50 상한 강제

// 키워드 검색 상한(쿼터 보호: 페이지 수 제한)
const YT_SEARCH_MAX_PAGES = Number(process.env.YT_SEARCH_MAX_PAGES || 20);

// 데이터 저장 디렉터리(환경변수로 재지정 가능: Render persistent disk 경로 등)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'yt-store.json');

// 클라이언트
const openai = OPENAI_KEY
  ? new OpenAI({ apiKey: OPENAI_KEY, timeout: OPENAI_TIMEOUT_MS })
  : null;

const genai = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const youtube = google.youtube({ version: 'v3', auth: YT_API_KEY });

/* =========================
   로컬 저장소(JSON) 유틸
   ========================= */
function loadDB() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE))
      fs.writeFileSync(DB_FILE, JSON.stringify({ channels: {} }, null, 2));
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    console.error('[db] load error:', e);
    return { channels: {} };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/* =========================
   Express
   ========================= */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: (origin, cb) => {
    // same-origin or server-to-server requests (no origin)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed: ' + origin));
  }
}));

// 기본 루트 및 헬스체크
app.get('/', (req, res) => {
  res.type('text/plain').send('YT API running');
});
app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* =========================
   채널 식별/메타
   ========================= */
async function resolveToChannelId(handleOrId) {
  if (/^UC[0-9A-Za-z_-]{22}$/.test(handleOrId || '')) return handleOrId;
  const q = (handleOrId || '').replace(/^@/, '').trim();
  const r = await youtube.search.list({
    part: 'snippet',
    q,
    type: 'channel',
    maxResults: 1,
  });
  const id =
    r.data?.items?.[0]?.snippet?.channelId ||
    r.data?.items?.[0]?.id?.channelId ||
    null;
  if (!id) throw new Error('cannot resolve channelId');
  return id;
}
async function fetchChannelMeta(channelId) {
  const r = await youtube.channels.list({
    part: 'snippet,statistics,contentDetails',
    id: channelId,
  });
  const it = r.data?.items?.[0];
  if (!it) throw new Error('channel not found');
  const sn = it.snippet || {};
  const st = it.statistics || {};
  return {
    channelId,
    title: sn.title,
    description: sn.description,
    thumbnails: sn.thumbnails,
    stats: {
      subscriberCount: Number(st.subscriberCount || 0),
      videoCount: Number(st.videoCount || 0),
      viewCount: Number(st.viewCount || 0),
    },
    uploadsId: it.contentDetails?.relatedPlaylists?.uploads || null,
    fetchedAt: new Date().toISOString(),
  };
}

/* =========================
   업로드 플레이리스트 + 증분/백필 수집
   ========================= */
async function getUploadsPlaylistId(channelId) {
  const r = await youtube.channels.list({ part: 'contentDetails', id: channelId });
  const uploads = r.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('uploads playlist not found');
  return uploads;
}

/**
 * listNewVideoIds
 * @param uploadsId
 * @param { sinceISO?: string, lastSeenVideoId?: string, backfill?: boolean }
 *
 * - backfill=false(기본): lastSeenVideoId를 만나면 중단(증분)
 * - backfill=true: lastSeenVideoId를 무시하고 sinceISO까지 “뒤로” 탐색(백필)
 */
async function listNewVideoIds(
  uploadsId,
  { sinceISO, lastSeenVideoId, backfill = false }
) {
  const out = []; // [{ id, publishedAt }]
  let pageToken;
  let stop = false;
  const cutoff = sinceISO ? new Date(sinceISO).toISOString() : null;

  do {
    const r = await youtube.playlistItems.list({
      part: 'contentDetails',
      playlistId: uploadsId,
      maxResults: 50,
      pageToken,
    });

    const items = r.data?.items || [];
    // playlistItems 는 최신 → 과거 순서
    for (const it of items) {
      const id = it?.contentDetails?.videoId;
      const pub = it?.contentDetails?.videoPublishedAt;
      if (!id) continue;

      // ★ 백필 아닐 때만 lastSeen에서 멈춤(증분)
      if (!backfill && lastSeenVideoId && id === lastSeenVideoId) {
        stop = true;
        break;
      }

      // 기간 컷(과거로 더 내려가면 중단)
      if (cutoff && pub && pub < cutoff) {
        stop = true;
        break;
      }

      out.push({ id, publishedAt: pub });
      if (out.length >= YT_FETCH_MAX_NEW) {
        stop = true;
        break;
      }
    }

    if (stop) break;
    pageToken = r.data?.nextPageToken || null;
  } while (pageToken);

  return out.reverse(); // oldest → newest
}

async function fetchVideoDetails(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += YT_VIDEOS_BATCH) {
    const batch = ids.slice(i, i + YT_VIDEOS_BATCH); // 50 상한 보장
    const r = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    });
    for (const v of r.data?.items || []) {
      rows.push({
        videoId: v.id,
        title: v.snippet?.title || '',
        description: v.snippet?.description || '',
        publishedAt: v.snippet?.publishedAt,
        channelId: v.snippet?.channelId,
        channelTitle: v.snippet?.channelTitle,
        duration: v.contentDetails?.duration,
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
      });
    }
  }
  return rows;
}

/* =========================
   메트릭 계산
   ========================= */
function makeMetricsFromChannel(db, channelId, days = 90) {
  const ch = db.channels[channelId];
  if (!ch) return { byDay: {}, rows: [], top: [], total: 0 };

  const cutoff = dayjs().subtract(days, 'day').startOf('day');
  const rows = Object.values(ch.videos || {})
    .filter((v) => dayjs(v.publishedAt).isAfter(cutoff))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

  const byDay = {};
  for (const v of rows) {
    const d = v.publishedAt.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }
  const top = rows.slice().sort((a, b) => b.views - a.views).slice(0, 10);
  return { byDay, rows, top, total: rows.length };
}

/* =========================
   문자열 AND 매칭(키워드 검색용)
   ========================= */
function isMatchAllKeywords(text, keywords) {
  const t = (text || '').toLowerCase();
  return keywords.every((k) => t.includes(k.toLowerCase()));
}

/* =========================
   LLM(인사이트) 유틸
   ========================= */

// 어느 공급자를 우선 쓸지 결정
function pickProvider() {
  if (LLM_PROVIDER === 'gemini') return 'gemini';
  if (LLM_PROVIDER === 'openai') return 'openai';
  // 지정이 없으면: OpenAI 키 없고 Gemini 키 있으면 gemini, 그 외 openai
  if (!OPENAI_KEY && GEMINI_KEY) return 'gemini';
  return 'openai';
}

// OpenAI 호출
async function callOpenAI(sample, days) {
  if (!openai) throw new Error('OPENAI_API_KEY not configured');

  const sys = [
    '당신은 마케팅/콘텐츠 분석가입니다.',
    '입력 데이터(YouTube 업로드/성과 로그)를 바탕으로 한국어로 상세하고 실무적인 리포트를 작성합니다.',
    '항상 번호와 불릿을 활용해 가독성을 높이고, 과도한 수사를 피합니다.',
    '주요 패턴과 예외, 인사이트, 리스크, 실행 제안을 명확히 나눠 주세요.',
  ].join(' ');

  const usr = [
    `기간: 최근 ${days}일`,
    `데이터 샘플(최대 ${INSIGHT_MAX_ROWS}건):`,
    JSON.stringify(sample, null, 2),
    '',
    '아래 형식으로 작성해 주세요:',
    '',
    '## 1) 업로드 빈도/요일·시즌 패턴',
    '- 업로드 양/주기/특이한 급증일(이벤트 여부 추정 포함)',
    '',
    '## 2) 메시지/제품/시리즈 변화(추정 근거)',
    '- 강조 메시지 변화, 제품군/시리즈 비중 변화, 포맷(숏폼/롱폼) 변화',
    '',
    '## 3) 성과 TOP 영상 공통점(제목/주제/길이/시기)',
    '- 공통 키워드/포맷, 조회/참여수(좋아요/댓글) 관점의 특징',
    '',
    '## 4) 주요 업로드 컨텐츠 유형 분석',
    '- 캠페인/USP/리뷰/하우투/행사/기업PR 등 유형별 특징과 성과 비교',
    '',
    '## 5) 리스크/모니터링 포인트',
    '- 과거 대비 하락 지표, 콘텐츠 포맷/메시지 편향 리스크',
    '',
    '## 6) 제품 분석',
    '- 에어컨/공기청정기/HVAC 제품에 대한 영상 제목과 내용 요약',
    '',
    '## 7) 종합 의견 및 제안',
    '- 브랜드/마케팅/콘텐츠 전략에 대한 상세 제안',
  ].join('\n');

  const out = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ],
    temperature: 0.2,
    max_tokens: 1400,
  });

  const text = out.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned empty content');
  return text;
}

// Gemini 호출
async function callGemini(sample, days) {
  if (!genai) throw new Error('GEMINI_API_KEY not configured');

  const model = genai.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      maxOutputTokens: GEMINI_MAX_TOKENS,
      temperature: 0.2,
    },
  });

  const prompt = [
    '당신은 마케팅/콘텐츠 분석가입니다.',
    '입력 데이터(YouTube 업로드/성과 로그)를 바탕으로 한국어로 상세하고 실무적인 리포트를 작성합니다.',
    '항상 번호와 불릿을 활용해 가독성을 높이고, 과도한 수사를 피합니다.',
    '주요 패턴과 예외, 인사이트, 리스크, 실행 제안을 명확히 나눠 주세요.',
    '',
    `기간: 최근 ${days}일`,
    `데이터 샘플(최대 ${INSIGHT_MAX_ROWS}건):`,
    JSON.stringify(sample, null, 2),
    '',
    '아래 형식으로 작성해 주세요:',
    '',
    '## 1) 업로드 빈도/요일·시즌 패턴',
    '- 업로드 양/주기/특이한 급증일(이벤트 여부 추정 포함)',
    '',
    '## 2) 메시지/제품/시리즈 변화(추정 근거)',
    '- 강조 메시지 변화, 제품군/시리즈 비중 변화, 포맷(숏폼/롱폼) 변화',
    '',
    '## 3) 성과 TOP 영상 공통점(제목/주제/길이/시기)',
    '- 공통 키워드/포맷, 조회/참여수(좋아요/댓글) 관점의 특징',
    '',
    '## 4) 주요 업로드 컨텐츠 유형 분석',
    '- 캠페인/USP/리뷰/하우투/행사/기업PR 등 유형별 특징과 성과 비교',
    '',
    '## 5) 리스크/모니터링 포인트',
    '- 과거 대비 하락 지표, 콘텐츠 포맷/메시지 편향 리스크',
    '',
    '## 6) 제품 분석',
    '- 에어컨/공기청정기/HVAC 제품에 대한 영상 제목과 내용 요약',
    '',
    '## 7) 종합 의견 및 제안',
    '- 브랜드/마케팅/콘텐츠 전략에 대한 상세 제안',
  ].join('\n');

  // 타임아웃 처리
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout')), ms)),
    ]);

  const resp = await withTimeout(model.generateContent([{ text: prompt }]), GEMINI_TIMEOUT_MS);
  const text = resp?.response?.text?.() || '';
  if (!text) throw new Error('Gemini returned empty content');
  return text;
}

// 인사이트 텍스트 생성: 공급자 선택 + 폴백
async function buildInsightText(sample, days) {
  const want = pickProvider();
  if (want === 'gemini') {
    try {
      return await callGemini(sample, days);
    } catch (e) {
      console.warn('[insight] gemini failed, fallback->openai:', e?.message || e);
      return await callOpenAI(sample, days);
    }
  } else {
    try {
      return await callOpenAI(sample, days);
    } catch (e) {
      // OpenAI 429/오류 시 Gemini로 폴백
      console.warn('[insight] openai failed, fallback->gemini:', e?.message || e);
      return await callGemini(sample, days);
    }
  }
}

/* =========================
   라우트
   ========================= */

/** 채널 핸들/ID 확인 */
app.get('/api/yt/resolve', async (req, res) => {
  try {
    const { handle = '' } = req.query;
    const channelId = await resolveToChannelId(handle);
    const db = loadDB();

    // 메타 캐시(24h)
    const cached = db.channels[channelId]?.meta;
    const freshEnough = cached && dayjs().diff(dayjs(cached.fetchedAt), 'hour') < 24;
    const meta = freshEnough ? cached : await fetchChannelMeta(channelId);

    db.channels[channelId] = db.channels[channelId] || { videos: {} };
    db.channels[channelId].meta = meta;
    saveDB(db);

    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * 증분/백필 수집
 * body: { handle?, channelId?, since, backfill?: boolean }
 * - backfill=false(기본): 최신 → 과거로 가다가 lastSeenVideoId를 만나면 중단(증분)
 * - backfill=true : lastSeenVideoId 무시 + sinceISO까지 끝까지(백필)
 */
app.post('/api/yt/ingest', async (req, res) => {
  const { handle, channelId: channelIdIn, since, backfill = false } = req.body || {};
  try {
    const db = loadDB();

    const channelId = channelIdIn || (handle ? await resolveToChannelId(handle) : null);
    if (!channelId) throw new Error('channelId/handle required');

    const uploadsId = await getUploadsPlaylistId(channelId);

    const ch =
      db.channels[channelId] || { videos: {}, lastSeenVideoId: null, lastPublishedAt: null };

    const newList = await listNewVideoIds(uploadsId, {
      sinceISO: since,
      lastSeenVideoId: ch.lastSeenVideoId,
      backfill, // ★ 백필 모드
    });

    const ids = newList.map((x) => x.id);
    if (ids.length === 0) {
      return res.json({ ok: true, added: 0, channelId, backfill });
    }

    const details = await fetchVideoDetails(ids);
    for (const v of details) ch.videos[v.videoId] = v;

    // ★ 증분 모드일 때만 lastSeen 갱신(백필은 예전 데이터도 긁어오므로 유지)
    if (!backfill) {
      const newest = newList[newList.length - 1];
      ch.lastSeenVideoId = newest?.id || ch.lastSeenVideoId;
      ch.lastPublishedAt = newest?.publishedAt || ch.lastPublishedAt;
    }

    if (!ch.meta) {
      try {
        ch.meta = await fetchChannelMeta(channelId);
      } catch {}
    }

    db.channels[channelId] = ch;
    saveDB(db);

    res.json({ ok: true, added: details.length, channelId, backfill });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/** 채널 메트릭(저장소에서 계산) */
app.get('/api/yt/metrics-by-handle', async (req, res) => {
  try {
    const days = Number(req.query.days || 90);
    const channelIdQ = req.query.channelId ? String(req.query.channelId) : null;
    const handle = req.query.handle ? String(req.query.handle) : null;

    const channelId = channelIdQ || (handle ? await resolveToChannelId(handle) : null);
    if (!channelId) return res.json({ byDay: {}, rows: [], top: [], total: 0 });

    const db = loadDB();
    res.json(makeMetricsFromChannel(db, channelId, days));
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** 키워드 메트릭(검색) — 모든 키워드를 포함(AND) */
app.get('/api/yt/metrics-by-query', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const days = Number(req.query.days || 90);
    if (!q) return res.json({ query: null, byDay: {}, rows: [], top: [], total: 0 });

    const keywords = q.split(',').map((s) => s.trim()).filter(Boolean);
    const publishedAfter = dayjs().subtract(days, 'day').startOf('day').toISOString();

    const videoIds = [];
    let pageToken;
    let pages = 0;

    do {
      const r = await youtube.search.list({
        part: 'snippet',
        q: keywords.join(' '),
        type: 'video',
        order: 'date',
        maxResults: 50,
        publishedAfter,
        pageToken,
      });

      const items = r.data?.items || [];
      for (const it of items) {
        const id = it?.id?.videoId;
        if (!id) continue;
        const sn = it.snippet || {};
        const text = `${sn.title || ''}\n${sn.description || ''}`;
        if (!isMatchAllKeywords(text, keywords)) continue; // ★ 모든 키워드 AND
        videoIds.push(id);
      }

      pageToken = r.data?.nextPageToken || null;
      pages += 1;
    } while (pageToken && pages < YT_SEARCH_MAX_PAGES);

    const rows = [];
    for (let i = 0; i < videoIds.length; i += YT_VIDEOS_BATCH) {
      const batch = videoIds.slice(i, i + YT_VIDEOS_BATCH);
      const r = await youtube.videos.list({
        part: 'snippet,statistics,contentDetails',
        id: batch.join(','),
      });
      for (const v of r.data?.items || []) {
        rows.push({
          videoId: v.id,
          title: v.snippet?.title || '',
          description: v.snippet?.description || '',
          publishedAt: v.snippet?.publishedAt,
          channelId: v.snippet?.channelId,
          channelTitle: v.snippet?.channelTitle,
          duration: v.contentDetails?.duration,
          views: Number(v.statistics?.viewCount || 0),
          likes: Number(v.statistics?.likeCount || 0),
          comments: Number(v.statistics?.commentCount || 0),
        });
      }
    }

    const byDay = {};
    const filtered = rows
      .filter((v) => dayjs(v.publishedAt).isAfter(dayjs(publishedAfter)))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    for (const v of filtered) {
      const d = v.publishedAt.slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    const top = filtered.slice().sort((a, b) => b.views - a.views).slice(0, 10);
    res.json({ query: q, byDay, rows: filtered, top, total: filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * 인사이트 — rows 기반(YouTube 추가 호출 없음)
 * body: {
 *   days?: number,
 *   rows?: Array<...>  // 또는 metrics.rows
 *   metrics?: { rows: [...] },
 *   handle?: string, channelId?: string // rows 없을 때 DB에서 생성
 * }
 */
app.post('/api/yt/insight', async (req, res) => {
  try {
    const days = Number(req.body?.days || 90);

    // 1) rows 우선
    let rowsInput =
      (req.body?.metrics && Array.isArray(req.body.metrics.rows) ? req.body.metrics.rows : null) ||
      (Array.isArray(req.body?.rows) ? req.body.rows : null);

    // 2) 없으면 DB에서 생성(채널 기준)
    if (!rowsInput || rowsInput.length === 0) {
      const channelIdQ = req.body?.channelId ? String(req.body.channelId) : null;
      const handle = req.body?.handle ? String(req.body.handle) : null;
      if (channelIdQ || handle) {
        const channelId = channelIdQ || (handle ? await resolveToChannelId(handle) : null);
        if (channelId) {
          const db = loadDB();
          rowsInput = makeMetricsFromChannel(db, channelId, days).rows || [];
        }
      }
    }

    if (!rowsInput || rowsInput.length === 0) {
      return res.status(400).json({ error: 'rows data not provided (or cannot load from DB).' });
    }

    // 필요한 필드만 정규화
    const normalized = rowsInput.map((v) => ({
      publishedAt: v.publishedAt || v.published_at || v.date || null,
      title: (v.title || '').toString(),
      views: Number(v.views || 0),
      likes: Number(v.likes || 0),
      comments: Number(v.comments || 0),
      channelTitle: v.channelTitle || v.channel_title || '',
    }));

    // 모델 입력 샘플(최대 INSIGHT_MAX_ROWS)
    const sample = normalized
      .sort((a, b) => (a.publishedAt || '').localeCompare(b.publishedAt || ''))
      .slice(-INSIGHT_MAX_ROWS)
      .map((v) => ({
        d: (v.publishedAt || '').slice(0, 10),
        title: (v.title || '').slice(0, 140),
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        ch: v.channelTitle,
      }));

    // 공급자 선택 + 폴백 처리
    const text = await buildInsightText(sample, days);
    res.json({ text, rowsUsed: sample.length });
  } catch (e) {
    console.error('[insight] error:', e?.response?.data || e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* =========================
   서버 시작
   ========================= */
app.listen(PORT, () => {
  console.log(`YT API on http://localhost:${PORT}`);
});
