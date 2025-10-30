// dashboard/src/App.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';

/* ========== fetch 헬퍼 (기본 90초 타임아웃) ========== */
const api = (path, opts = {}, timeout = Number(import.meta.env.VITE_HTTP_TIMEOUT || 90000)) => {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort('timeout'), timeout);
  return fetch(path, { ...opts, signal: ctrl.signal })
    .then(async (r) => {
      let data = {};
      try { data = await r.json(); } catch {}
      if (!r.ok) throw new Error(data.error || r.statusText || `HTTP ${r.status}`);
      return data;
    })
    .catch((e) => {
      if (String(e).includes('AbortError') || String(e).includes('timeout')) {
        throw new Error('요청이 시간 제한을 초과했습니다. 다시 시도해 주세요.');
      }
      throw e;
    })
    .finally(() => clearTimeout(id));
};

/* ========== days 컷팅 유틸 ========== */
const filterRowsByDays = (rows, days) => {
  if (!Array.isArray(rows)) return [];
  const cutoff = dayjs().subtract(days, 'day').startOf('day');
  return rows.filter(v => dayjs(v.publishedAt).isAfter(cutoff));
};

/* ========== App ========== */
export default function App() {
  // 모드
  const [mode, setMode] = useState('channel'); // 'channel' | 'keyword'

  // 채널 입력 & 캐시
  const [handle, setHandle] = useState('@LGGlobal');
  const [chResol, setChResol] = useState(null);
  const [chMetrics, setChMetrics] = useState(null);
  const [chInsight, setChInsight] = useState('');

  // 키워드 입력 & 캐시
  const [keywords, setKeywords] = useState('LG, air conditioner');
  const [kwMetrics, setKwMetrics] = useState(null);
  const [kwInsight, setKwInsight] = useState('');

  // 공통
  const [days, setDays] = useState(180);
  const [since, setSince] = useState(dayjs().subtract(180, 'day').startOf('day').toISOString());
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState('');

  // 인사이트 로딩
  const [insightLoading, setInsightLoading] = useState(false);
  const insightRef = useRef(null);

  const CONTROL_H = 42;
  const isChannelId = (v) => /^UC[0-9A-Za-z_-]{22}$/.test(v || '');

  // 기간 변경 → since 갱신
  useEffect(() => {
    setSince(dayjs().subtract(days, 'day').startOf('day').toISOString());
  }, [days]);

  // 탭 전환(캐시는 유지, 에러/로딩만 초기화)
  const switchMode = (m) => {
    setMode(m);
    setError('');
    setInsightLoading(false);
  };

  /* ---------- 채널 확인 ---------- */
  const resolveHandle = async () => {
    if (mode !== 'channel') return;
    setError(''); setLoading(true);
    try {
      const r = await api(`/api/yt/resolve?handle=${encodeURIComponent(handle)}`);
      setChResol(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  /* ---------- 지표 로딩 (모드별) ---------- */
  const loadMetrics = async () => {
    setError(''); setLoading(true);
    try {
      if (mode === 'channel') {
        const r = await api(`/api/yt/metrics-by-handle?handle=${encodeURIComponent(handle)}&days=${days}`);
        setChMetrics(r);
      } else {
        const q = new URLSearchParams({ q: keywords, days: String(days), manual: '1' });
        const r = await api(`/api/yt/metrics-by-query?${q.toString()}`);
        setKwMetrics(r);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  /* ---------- 증분 수집 (채널만) ---------- */
  const ingest = async () => {
    if (mode !== 'channel') return;
    setError(''); setIngesting(true);
    try {
      const r = await api('/api/yt/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle, since })
      });
      if (r.error) throw new Error(r.error);
      await loadMetrics();
    } catch (e) {
      setError(String(e));
    } finally {
      setIngesting(false);
    }
  };

  /* ---------- 인사이트 ---------- */
  const loadInsight = async () => {
    setInsightLoading(true);
    if (mode === 'channel') setChInsight('분석 중…');
    else setKwInsight('분석 중…');

    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (mode === 'channel') {
        if (isChannelId(handle)) qs.set('channelId', handle);
        else qs.set('handle', handle);
      } else {
        qs.set('q', keywords);
        qs.set('manual', '1');
      }
      const r = await api(`/api/yt/insight?${qs.toString()}`);
      if (mode === 'channel') setChInsight(r.text || '(no result)');
      else setKwInsight(r.text || '(no result)');
      setTimeout(() => insightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 10);
    } catch (e) {
      if (mode === 'channel') setChInsight(`❌ ${e.message || String(e)}`);
      else setKwInsight(`❌ ${e.message || String(e)}`);
    } finally {
      setInsightLoading(false);
    }
  };

  /* ---------- 화면에 뿌릴 데이터 선택 ---------- */
  const resol = mode === 'channel' ? chResol : null;

  // 서버 메트릭(캐시)
  const effectiveMetrics = useMemo(() => {
    if (mode === 'keyword') {
      return kwMetrics?.query ? kwMetrics : null; // 키워드 응답만 유효
    }
    return chMetrics;
  }, [mode, chMetrics, kwMetrics]);

  // 서버 rows에서 days 재컷팅하여 **화면용 데이터** 생성 (API 재호출 없이 즉시 반영)
  const baseRows = effectiveMetrics?.rows || [];
  const visibleRows = useMemo(() => filterRowsByDays(baseRows, days), [baseRows, days]);

  // 차트 데이터 (visibleRows 기준)
  const chartData = useMemo(() => {
    const byDay = {};
    for (const v of visibleRows) {
      const d = (v.publishedAt || '').slice(0, 10);
      if (!d) continue;
      byDay[d] = (byDay[d] || 0) + 1;
    }
    return Object.keys(byDay).sort().map(d => ({ date: d, count: byDay[d] }));
  }, [visibleRows]);

  // Top10 (조회수)도 visibleRows 기준
  const top = useMemo(() => {
    return visibleRows.slice().sort((a,b) => b.views - a.views).slice(0, 10);
  }, [visibleRows]);

  // 표 데이터
  const rows = visibleRows;

  // 최초 로드: 채널만 자동 로딩(키워드는 자동 호출 X)
  useEffect(() => {
    resolveHandle();
    loadMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const primaryBtnLabel = loading
    ? (mode === 'channel' ? '지표 새로고침 중…' : '검색 중…')
    : (mode === 'channel' ? '지표 새로고침' : '검색 실행');

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontWeight: 700, fontSize: 24, marginBottom: 12 }}>📺 YouTube 채널/키워드 대시보드</h1>

      {/* 상단 컨트롤 */}
      <div style={{ display:'grid', gridTemplateColumns:'auto 1fr 160px auto', gap:12, alignItems:'end', marginBottom:12 }}>
        <div style={{ display:'flex', gap:8 }}>
          <button
            onClick={() => switchMode('channel')}
            style={{ ...btnSecondary, background: mode==='channel' ? '#4f46e5':'#e5e7eb', color: mode==='channel' ? '#fff':'#111' }}
          >채널</button>
          <button
            onClick={() => switchMode('keyword')}
            style={{ ...btnSecondary, background: mode==='keyword' ? '#4f46e5':'#e5e7eb', color: mode==='keyword' ? '#fff':'#111' }}
          >키워드</button>
        </div>

        {mode === 'channel' ? (
          <div>
            <label style={{ display:'block', fontSize:12, color:'#666' }}>채널 핸들</label>
            <input
              value={handle}
              onChange={e=>setHandle(e.target.value)}
              placeholder="@brand"
              style={{ width:'100%', padding:'8px 10px', border:'1px solid #ddd', borderRadius:8 }}
            />
          </div>
        ) : (
          <div>
            <label style={{ display:'block', fontSize:12, color:'#666' }}>키워드(쉼표로 구분)</label>
            <input
              value={keywords}
              onChange={e=>setKeywords(e.target.value)}
              placeholder="예: LG, OLED, UltraGear"
              style={{ width:'100%', padding:'8px 10px', border:'1px solid #ddd', borderRadius:8 }}
            />
          </div>
        )}

        <div>
          <label style={{ display:'block', fontSize:12, color:'#666' }}>지표 기간(일)</label>
          <input
            type="number" min={7} max={720}
            value={days}
            onChange={e=>setDays(Number(e.target.value))}
            style={{ width:'100%', padding:'8px 10px', border:'1px solid #ddd', borderRadius:8 }}
          />
        </div>

        <div style={{ display:'flex', gap:8 }}>
          <button onClick={resolveHandle} disabled={loading || mode==='keyword'} style={{...btnStyle, opacity: mode==='keyword'?0.5:1}}>채널 확인</button>
          <button onClick={loadMetrics} disabled={loading || (mode==='keyword' && !keywords.trim())} style={btnStyle}>{primaryBtnLabel}</button>
          <button onClick={loadInsight} disabled={insightLoading || (mode==='keyword' && !keywords.trim())} style={btnStyle}>{insightLoading ? 'AI 분석 중…' : 'AI 인사이트'}</button>
        </div>
      </div>

      {/* 상단 카드 2열 */}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 2.2fr) minmax(320px, 1fr)', gap: 12, marginBottom: 12 }}>
        {/* 좌: 채널 정보 or 검색 요약 */}
        <div style={cardStyle}>
          <div style={cardTitle}>{mode==='channel' ? '채널 정보' : '검색 요약'}</div>
          {mode === 'channel' ? (
            chResol ? (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <img src={chResol.thumbnails?.default?.url} width={64} height={64} alt="" style={{ borderRadius: 8 }}/>
                  <div>
                    <div style={{ fontWeight: 700 }}>{chResol.title}</div>
                    <div style={{ fontSize: 13, color: '#666' }}>channelId: {chResol.channelId}</div>
                    {chResol.stats && (
                      <div style={{ fontSize: 13, color: '#444', marginTop: 4 }}>
                        구독자: {Number(chResol.stats.subscriberCount || 0).toLocaleString()} ·
                        영상: {Number(chResol.stats.videoCount || 0).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
                {chResol.description && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>설명</div>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: '#333' }}>
                      {chResol.description}
                    </div>
                  </div>
                )}
              </>
            ) : <div>핸들을 확인해 주세요.</div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: '#666' }}>키워드</div>
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  {String(keywords).split(',').map(s=>s.trim()).filter(Boolean).map((k,i)=>(
                    <span key={i} style={{ background:'#eef2ff', color:'#3730a3', padding:'4px 8px', borderRadius:999 }}>{k}</span>
                  ))}
                </div>
              </div>
              {effectiveMetrics ? (
                <>
                  {/* 총계도 visibleRows 기준으로 표기 */}
                  <div style={{ fontSize: 13, color: '#444', marginBottom: 8 }}>
                    기간: 최근 {days}일 · 총 {Number(visibleRows.length || 0).toLocaleString()}건
                  </div>
                  {/* 서버가 topChannels를 내려줄 때만 표시(옵션) */}
                  {effectiveMetrics.topChannels?.length ? (
                    <div>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>상위 채널</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {effectiveMetrics.topChannels.map((c,i)=>(
                          <li key={i} style={{ margin:'2px 0' }}>
                            {c.channelTitle} · {c.count}건 · 조회 {Number(c.views).toLocaleString()}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : (
                <div>데이터가 없습니다. 먼저 “검색 실행”을 눌러 주세요.</div>
              )}
            </>
          )}
        </div>

        {/* 우: 수집 실행/검색 실행 */}
        <div style={cardStyle}>
          <div style={cardTitle}>{mode==='channel' ? '수집 실행 (증분)' : '검색 실행'}</div>
          {mode === 'channel' ? (
            <>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <input
                  value={since}
                  readOnly
                  style={{
                    flex: 1, height: CONTROL_H, padding: '0 12px',
                    border: '1px solid #ddd', borderRadius: 8,
                    background: '#f7f7f7', color: '#555', cursor: 'default',
                  }}
                />
                <button onClick={ingest} disabled={ingesting} style={{ ...btnStyle, height: CONTROL_H }}>
                  {ingesting ? '수집 중…' : '수집 실행'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
                지표 기간 {days}일 기준으로 자동 계산됩니다.
              </div>
            </>
          ) : (
            <button
              onClick={loadMetrics}
              disabled={loading || !keywords.trim()}
              style={{ ...btnStyle, height: CONTROL_H }}
            >
              {primaryBtnLabel}
            </button>
          )}
        </div>
      </div>

      {/* 🧠 AI 인사이트 */}
      <div style={{ ...cardStyle, marginTop: 12 }} ref={insightRef}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <div style={cardTitle}>🧠 AI 인사이트</div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={loadInsight} disabled={insightLoading || (mode==='keyword' && !keywords.trim())} style={btnStyle}>
              {insightLoading ? '분석 중…' : '다시 분석'}
            </button>
            <button
              onClick={() => (mode==='channel' ? setChInsight('') : setKwInsight(''))}
              style={btnSecondary}
            >지우기</button>
            <button
              onClick={() => {
                const text = mode==='channel' ? chInsight : kwInsight;
                text && navigator.clipboard.writeText(text);
              }}
              style={btnSecondary}
              disabled={!(mode==='channel' ? chInsight : kwInsight)}
            >복사</button>
          </div>
        </div>
        <pre style={{ whiteSpace:'pre-wrap', fontSize:13, lineHeight:1.6, margin:0 }}>
          {(mode==='channel' ? chInsight : kwInsight) || '“AI 인사이트” 버튼을 눌러 요약을 생성하세요.'}
        </pre>
      </div>

      {/* 업로드 수 (일별) */}
      <div style={cardStyle}>
        <div style={cardTitle}>업로드 수 (일별)</div>
        {loading && mode === 'keyword' && (
          <div style={{ padding: 8, color: '#6b7280', fontSize: 13 }}>검색 결과를 불러오는 중…</div>
        )}
        <div style={{ height: 280, opacity: loading ? 0.7 : 1 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="#4f46e5" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* TOP10 / 최근 업로드 */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12 }}>
        <div style={cardStyle}>
          <div style={cardTitle}>TOP 10 (조회수)</div>
          <div style={{ display:'grid', gap:8 }}>
            {top.map(v => (
              <a key={v.videoId}
                 href={`https://www.youtube.com/watch?v=${v.videoId}`}
                 target="_blank" rel="noreferrer"
                 style={{ display:'grid', gridTemplateColumns:'140px 1fr', gap:8, textDecoration:'none', color:'inherit' }}>
                <img src={`https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`} alt="" style={{ width:'100%', borderRadius:8 }}/>
                <div>
                  <div style={{ fontWeight:700, marginBottom:4 }}>{v.title}</div>
                  <div style={{ fontSize:12, color:'#666' }}>
                    {dayjs(v.publishedAt).format('YYYY-MM-DD HH:mm')} · 조회 {Number(v.views).toLocaleString()} · 좋아요 {Number(v.likes).toLocaleString()} · 댓글 {Number(v.comments).toLocaleString()}
                  </div>
                </div>
              </a>
            ))}
            {top.length === 0 && <div>데이터가 없습니다. 먼저 “수집/검색 실행”을 해보세요.</div>}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={cardTitle}>최근 업로드</div>
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>제목</th>
                  <th style={thSmall}>업로드</th>
                  <th style={thSmall}>조회</th>
                  <th style={thSmall}>좋아요</th>
                  <th style={thSmall}>댓글</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice().reverse().map(v => (
                  <tr key={v.videoId}>
                    <td style={td}><a href={`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noreferrer">{v.title}</a></td>
                    <td style={tdSmall}>{dayjs(v.publishedAt).format('YY.MM.DD HH:mm')}</td>
                    <td style={tdSmall}>{Number(v.views).toLocaleString()}</td>
                    <td style={tdSmall}>{Number(v.likes).toLocaleString()}</td>
                    <td style={tdSmall}>{Number(v.comments).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {error && <div style={{ marginTop:12, color:'#b91c1c' }}>⚠ {error}</div>}
    </div>
  );
}

/* ========== styles ========== */
const btnStyle = {
  padding: '10px 14px',
  background: '#4f46e5',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontWeight: 700,
};
const btnSecondary = {
  padding: '8px 12px',
  background: '#e5e7eb',
  color: '#111',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontWeight: 600,
};
const cardStyle = {
  border: '1px solid #eee',
  borderRadius: 12,
  padding: 12,
  background: '#fff',
};
const cardTitle = { fontWeight: 700, marginBottom: 8 };
const th = { textAlign:'left', borderBottom:'1px solid #eee', padding:'6px 8px', position:'sticky', top:0, background:'#fafafa' };
const thSmall = { ...th, width: 90 };
const td = { borderBottom:'1px solid #f3f4f6', padding:'6px 8px', fontSize:13 };
const tdSmall = { ...td, textAlign:'right', whiteSpace:'nowrap' };
