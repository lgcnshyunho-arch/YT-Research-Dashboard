// server/yt.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import { google } from 'googleapis';
import OpenAI from 'openai';

/* =========================
   환경변수
   ========================= */
const PORT = Number(process.env.PORT || 8820);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const YT_API_KEY = (process.env.YT_API_KEY || '').trim();
if (!YT_API_KEY) console.warn('[warn] YT_API_KEY is empty. YouTube API calls will fail.');

const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);
const INSIGHT_MAX_ROWS = Number(process.env.INSIGHT_MAX_ROWS || 250);

// 수집 한도/배치
const YT_FETCH_MAX_NEW = Number(process.env.YT_FETCH_MAX_NEW || 1200);
const YT_VIDEOS_BATCH = Number(process.env.YT_VIDEOS_BATCH || 50);

// 키워드 검색 상한(쿼터 보호: 페이지 수 제한)
const YT_SEARCH_MAX_PAGES = Number(process.env.YT_SEARCH_MAX_PAGES || 3);

// 데이터 저장 파일
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'yt-store.json');

// OpenAI 클라이언트(타임아웃 옵션!)
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY, timeout: OPENAI_TIMEOUT_MS }) : null;

// YouTube API 클라이언트
const youtube = google.youtube({ version: 'v3', auth: YT_API_KEY });

/* =========================
   로컬 저장소(JSON) 유틸
   ========================= */
function loadDB() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ channels: {} }, null, 2));
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
app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN }));

/* =========================
   도우미: 채널 식별
   - UC로 시작하면 그대로 channelId
   - 아니면(핸들/채널명) search.list로 1회만 확인
   (가능하면 프런트에서 한번 캐싱해 재사용하세요)
   ========================= */
async function resolveToChannelId(handleOrId) {
  if (/^UC[0-9A-Za-z_-]{22}$/.test(handleOrId || '')) return handleOrId;

  // @ 제거
  const q = (handleOrId || '').replace(/^@/, '').trim();
  // search.list(100 quota) - 자주 부르지 않도록 프런트/서버에서 캐싱을 권장
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

/* =========================
   도우미: 채널 메타(24h 캐시 추천)
   ========================= */
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
   업로드 플레이리스트 + 증분 수집
   ========================= */
// 1) 채널 → 업로드 플레이리스트 ID
async function getUploadsPlaylistId(channelId) {
  const r = await youtube.channels.list({ part: 'contentDetails', id: channelId });
  const uploads = r.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('uploads playlist not found');
  return uploads;
}

// 2) playlistItems에서 신규 videoId만 긁기(증분)
async function listNewVideoIds(uploadsId, { sinceISO, lastSeenVideoId }) {
  const out = []; // [{ id, publishedAt }]
  let pageToken;
  const cutoff = sinceISO ? new Date(sinceISO).toISOString() : null;

  do {
    const r = await youtube.playlistItems.list({
      part: 'contentDetails',
      playlistId: uploadsId,
      maxResults: 50,
      pageToken,
    });
    const items = r.data?.items || [];

    // playlistItems는 최신→과거 순서
    for (const it of items) {
      const id = it?.contentDetails?.videoId;
      const pub = it?.contentDetails?.videoPublishedAt;
      if (!id) continue;

      if (lastSeenVideoId && id === lastSeenVideoId) { pageToken = null; break; } // 증분 종료
      if (cutoff && pub && pub < cutoff)            { pageToken = null; break; } // 기간 컷
      out.push({ id, publishedAt: pub });

      if (out.length >= YT_FETCH_MAX_NEW) { pageToken = null; break; } // 상한
    }

    if (!pageToken) break;
    pageToken = r.data?.nextPageToken;
  } while (pageToken);

  // 오래된 것부터 videos.list로 넣고 싶으면 뒤집기
  return out.reverse(); // oldest → newest
}

// 3) 상세 정보 일괄 조회(videos.list, 50개씩)
async function fetchVideoDetails(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += YT_VIDEOS_BATCH) {
    const batch = ids.slice(i, i + YT_VIDEOS_BATCH);
    const r = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    });
    for (const v of (r.data?.items || [])) {
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
   메트릭 계산(저장소 → byDay/rows/top)
   ========================= */
function makeMetricsFromChannel(db, channelId, days = 90) {
  const ch = db.channels[channelId];
  if (!ch) return { byDay: {}, rows: [], top: [], total: 0 };

  const cutoff = dayjs().subtract(days, 'day').startOf('day');
  const rows = Object.values(ch.videos || {})
    .filter(v => dayjs(v.publishedAt).isAfter(cutoff))
    .sort((a,b) => a.publishedAt.localeCompare(b.publishedAt));

  const byDay = {};
  for (const v of rows) {
    const d = v.publishedAt.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }
  const top = rows.slice().sort((a,b) => b.views - a.views).slice(0, 10);
  return { byDay, rows, top, total: rows.length };
}

/* =========================
   (보조) 문자열 AND 매칭
   ========================= */
function isMatchAllKeywords(text, keywords) {
  const t = (text || '').toLowerCase();
  return keywords.every(k => t.includes(k.toLowerCase()));
}

/* =========================
   라우트: 채널 확인
   ========================= */
app.get('/api/yt/resolve', async (req, res) => {
  try {
    const { handle = '' } = req.query;
    const channelId = await resolveToChannelId(handle);
    const db = loadDB();

    // 메타 캐시(24h)
    const cached = db.channels[channelId]?.meta;
    const freshEnough = cached && dayjs().diff(dayjs(cached.fetchedAt), 'hour') < 24;
    const meta = freshEnough ? cached : await fetchChannelMeta(channelId);

    // 저장
    db.channels[channelId] = db.channels[channelId] || { videos: {} };
    db.channels[channelId].meta = meta;
    saveDB(db);

    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* =========================
   라우트: 채널 증분 수집(쿼터 절감)
   body: { handle, since }
   ========================= */
app.post('/api/yt/ingest', async (req, res) => {
  const { handle, since } = req.body || {};
  try {
    const db = loadDB();
    const channelId = await resolveToChannelId(handle);
    const uploadsId = await getUploadsPlaylistId(channelId);

    const ch = db.channels[channelId] || { videos: {}, lastSeenVideoId: null, lastPublishedAt: null };
    // 신규 videoId 목록
    const newList = await listNewVideoIds(uploadsId, {
      sinceISO: since,
      lastSeenVideoId: ch.lastSeenVideoId,
    });
    const ids = newList.map(x => x.id);
    if (ids.length === 0) {
      return res.json({ ok: true, added: 0, channelId });
    }

    const details = await fetchVideoDetails(ids);

    // 저장
    for (const v of details) ch.videos[v.videoId] = v;
    const newest = newList[newList.length - 1]; // latest
    ch.lastSeenVideoId = newest?.id || ch.lastSeenVideoId;
    ch.lastPublishedAt = newest?.publishedAt || ch.lastPublishedAt;

    // 메타 없으면 채우기
    if (!ch.meta) {
      try { ch.meta = await fetchChannelMeta(channelId); } catch {}
    }

    db.channels[channelId] = ch;
    saveDB(db);

    res.json({ ok: true, added: details.length, channelId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/* =========================
   라우트: 채널 메트릭(저장소에서 계산)
   ========================= */
app.get('/api/yt/metrics-by-handle', async (req, res) => {
  try {
    const { handle = '', days = 90 } = req.query;
    const channelId = await resolveToChannelId(handle);
    const db = loadDB();
    res.json(makeMetricsFromChannel(db, channelId, Number(days)));
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* =========================
   라우트: 키워드 메트릭(검색)
   - publishedAfter로 범위 제한
   - 페이지 상한(YT_SEARCH_MAX_PAGES)로 쿼터 보호
   - 모든 키워드가 제목/설명에 "AND"로 포함될 때만 채택
   ========================= */
app.get('/api/yt/metrics-by-query', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const days = Number(req.query.days || 90);
    if (!q) return res.json({ query: null, byDay: {}, rows: [], top: [], total: 0 });

    const keywords = q.split(',').map(s => s.trim()).filter(Boolean);
    const publishedAfter = dayjs().subtract(days, 'day').startOf('day').toISOString();

    const videoIds = [];
    let pageToken;
    let pages = 0;

    // 검색(최대 N 페이지만)
    do {
      const r = await youtube.search.list({
        part: 'snippet',
        q: keywords.join(' '), // 대략적인 프리필터
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
        if (!isMatchAllKeywords(text, keywords)) continue; // AND 매칭
        videoIds.push(id);
      }

      pageToken = r.data?.nextPageToken || null;
      pages += 1;
    } while (pageToken && pages < YT_SEARCH_MAX_PAGES);

    // 상세 조회
    const rows = [];
    for (let i = 0; i < videoIds.length; i += YT_VIDEOS_BATCH) {
      const batch = videoIds.slice(i, i + YT_VIDEOS_BATCH);
      const r = await youtube.videos.list({
        part: 'snippet,statistics,contentDetails',
        id: batch.join(','),
      });
      for (const v of (r.data?.items || [])) {
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

    // 메트릭 생성(로컬)
    const byDay = {};
    const filtered = rows
      .filter(v => dayjs(v.publishedAt).isAfter(dayjs(publishedAfter)))
      .sort((a,b) => a.publishedAt.localeCompare(b.publishedAt));

    for (const v of filtered) {
      const d = v.publishedAt.slice(0,10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    const top = filtered.slice().sort((a,b) => b.views - a.views).slice(0, 10);
    res.json({ query: q, byDay, rows: filtered, top, total: filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/* =========================
   라우트: 인사이트(OpenAI) — 상세 포맷
   ========================= */
app.get('/api/yt/insight', async (req, res) => {
  try {
    if (!openai) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

    const days = Number(req.query.days || 90);
    const handle = req.query.handle ? String(req.query.handle) : null;
    const channelIdQ = req.query.channelId ? String(req.query.channelId) : null;
    const query = req.query.q ? String(req.query.q) : null;

    // 1) rows 수집 (채널/키워드 공통)
    let rows = [];
    if (query) {
      // 키워드 메트릭(서버 측 필터 적용)
      const r = await (await fetch(
        `http://localhost:${PORT}/api/yt/metrics-by-query?` +
        new URLSearchParams({ q: query, days: String(days), manual: '1' })
      )).json();
      rows = (r.rows || []);
    } else {
      const channelId = channelIdQ || await resolveToChannelId(handle || '');
      const db = loadDB();
      rows = makeMetricsFromChannel(db, channelId, days).rows || [];
    }

    // 2) 샘플 축약(최근 N건만) — 너무 길면 모델 품질/속도 저하
    const sample = rows.slice(-INSIGHT_MAX_ROWS).map(v => ({
      d: v.publishedAt?.slice(0,10),
      title: (v.title || '').slice(0, 140),
      views: v.views, likes: v.likes, comments: v.comments,
      ch: v.channelTitle,
    }));

    // 3) 프롬프트(과거 “상세 리포트” 스타일로 회귀)
    const sys = [
      '당신은 마케팅/콘텐츠 분석가입니다.',
      '입력 데이터(YouTube 업로드/성과 로그)를 바탕으로 한국어로 간결하고 실무적인 리포트를 작성합니다.',
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
    ].join('\n');

    const out = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: usr },
      ],
      temperature: 0.2,
    });

    const text = out.choices?.[0]?.message?.content || '(no result)';
    res.json({ text });
  } catch (e) {
    console.error('[insight] error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});


/* =========================
   서버 시작
   ========================= */
app.listen(PORT, () => {
  console.log(`YT API on http://localhost:${PORT}`);
});
