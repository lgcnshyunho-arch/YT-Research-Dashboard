// dashboard/src/App.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';

/* ================= Theme ================= */
const theme = {
  // 밝은 흰색 배경 (그라데이션 제거)
  bgGradient: '#fafafa',
  // 순수 화이트 카드
  card: '#ffffff',
  // 옅은 회색 경계선
  border: 'rgba(0, 0, 0, 0.06)',
  // 진한 회색 텍스트
  text: '#1f2937',
  // 서브 텍스트
  sub: '#6b7280',
  // 포인트 컬러: 블루 계열
  primary: '#3b82f6',
  primaryHover: '#2563eb',
  // 포커스 링 블루톤
  ring: 'rgba(59, 130, 246, 0.3)',
  // 배지/칩 색상 (중립적인 회색/블루 톤)
  chipBg: '#f3f4f6',
  chipText: '#374151',
  // 테이블 헤더/스트라이프
  tableHead: '#f9fafb',
  tableStripe: '#ffffff',
  // 경고 색상
  danger: '#ef4444',
  // 그림자 더 부드럽고 얇게
  shadow: '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.1)',
  shadowHover: '0 4px 6px rgba(0, 0, 0, 0.05), 0 2px 4px rgba(0, 0, 0, 0.1)',
};

/* ========== fetch 헬퍼 (기본 90초 타임아웃) ========== */
const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
const api = (path, opts = {}, timeout = Number(import.meta.env.VITE_HTTP_TIMEOUT || 90000)) => {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort('timeout'), timeout);
  const url = `${apiBase}${path}`;
  return fetch(url, { ...opts, signal: ctrl.signal })
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

/* ========== Tiny UI bits ========== */
function Spinner({ size = 16 }) {
  const s = {
    width: size, height: size, borderRadius: '50%',
    border: `${Math.max(2, Math.floor(size/8))}px solid rgba(0,0,0,0.08)`,
    borderTopColor: theme.primary,
    animation: 'spin 1s linear infinite',
  };
  return (
    <div style={s}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
const Input = (props) => (
  <input {...props}
    style={{
      width:'100%', padding:'10px 12px',
      borderRadius:8, border:`1px solid ${theme.border}`,
      outline:'none', background:'#ffffff',
      fontSize:14,
      transition:'all 0.2s ease',
      ...props.style
    }}
    onFocus={(e)=>{ 
      e.target.style.boxShadow = `0 0 0 3px ${theme.ring}`; 
      e.target.style.borderColor = theme.primary; 
    }}
    onBlur={(e)=>{ 
      e.target.style.boxShadow = 'none'; 
      e.target.style.borderColor = theme.border; 
    }}
  />
);
const Button = ({ children, variant='primary', iconLeft, iconRight, ...rest }) => {
  const base = {
    display:'inline-flex', alignItems:'center', gap:8,
    padding:'10px 16px', borderRadius:8, border:'none',
    cursor:'pointer', fontWeight:600, fontSize:14,
    transition:'all 0.2s ease',
    letterSpacing:'-0.01em',
  };
  const variants = {
    primary: {
      background: theme.primary, color:'#fff', boxShadow: theme.shadow,
    },
    secondary: {
      background: '#f3f4f6', color: theme.text, boxShadow:'none',
      border: `1px solid ${theme.border}`,
    }
  };
  const style = { ...base, ...variants[variant] };
  return (
    <button
      {...rest}
      style={style}
      onMouseDown={(e)=>{ e.currentTarget.style.transform = 'translateY(1px)'; }}
      onMouseUp={(e)=>{ e.currentTarget.style.transform = 'translateY(0)'; }}
      onMouseEnter={(e)=>{ 
        if(variant==='primary'){ 
          e.currentTarget.style.background = theme.primaryHover; 
          e.currentTarget.style.boxShadow = theme.shadowHover; 
        } else {
          e.currentTarget.style.background = '#e5e7eb';
        }
      }}
      onMouseLeave={(e)=>{ 
        if(variant==='primary'){ 
          e.currentTarget.style.background = theme.primary; 
          e.currentTarget.style.boxShadow = theme.shadow; 
        } else {
          e.currentTarget.style.background = '#f3f4f6';
        }
        e.currentTarget.style.transform='translateY(0)'; 
      }}
    >
      {iconLeft}{children}{iconRight}
    </button>
  );
};
const Chip = ({ children }) => (
  <span style={{
    background: theme.chipBg,
    color: theme.chipText,
    padding: '6px 12px',
    borderRadius: 6,
    fontWeight: 500,
    fontSize: 12,
    border: `1px solid ${theme.border}`,
    letterSpacing: '-0.01em',
  }}>
    {children}
  </span>
);
const Card = ({ title, actions, children, style }) => (
  <div style={{
    border:`1px solid ${theme.border}`,
    borderRadius:12,
    background: theme.card,
    boxShadow: theme.shadow,
    padding:20,
    ...style
  }}>
    {(title || actions) && (
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
        <div style={{ fontWeight:700, fontSize:15, letterSpacing:'-0.01em', color: theme.text }}>{title}</div>
        <div style={{ display:'flex', gap:8 }}>{actions}</div>
      </div>
    )}
    {children}
  </div>
);

/* ========== Insight Parser ========== */
/** 마크다운 제거하고 볼드체만 유지 */
function cleanMarkdown(text) {
  if (!text) return '';
  return text
    // **볼드** -> <strong>볼드</strong>로 변환 (나중에 렌더링)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    // 나머지 마크다운 제거
    .replace(/#{1,6}\s+/g, '')  // 헤더 제거
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')  // 링크 제거
    .replace(/`([^`]+)`/g, '$1')  // 인라인 코드 제거
    .replace(/\*([^*<]+)\*/g, '$1')  // 이탤릭 제거 (이미 변환된 <strong>은 제외)
    .replace(/~~([^~]+)~~/g, '$1')  // 취소선 제거
    .trim();
}

/** LLM 텍스트 → [{title, bullets[]}] */
function parseInsightText(text = '') {
  const out = [];
  if (!text.trim()) return out;

  // 섹션(## 제목 … 다음 ## 또는 끝까지)
  const re = /(^|\n)##\s*([^\n]+)\n+([\s\S]*?)(?=\n##\s|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = cleanMarkdown(m[2].trim());
    const body = m[3] || '';
    const bullets = [];

    body.split('\n').forEach((line) => {
      const cleaned = line
        .replace(/^\s*[-*•]+(\s*|\s*\+\+)?\s*/,'')   // - / * / • / -++ 등 접두 제거
        .replace(/^\s*—+\s*/,'')                    // em dash 변형
        .trim();
      if (!cleaned) return;
      // 번호 접두(1), 2) …) 제거
      const normalized = cleaned.replace(/^\d+\)?\s*[.)-]\s*/,'').trim();
      if (normalized) bullets.push(cleanMarkdown(normalized));
    });

    if (bullets.length) out.push({ title, bullets });
  }

  // 혹시 섹션 패턴이 전혀 없으면 통으로 하나의 섹션으로
  if (!out.length) {
    const bullets = text
      .split('\n')
      .map(s => s.replace(/^\s*[-*•]+(\s*|\s*\+\+)?\s*/,'').trim())
      .filter(Boolean)
      .map(cleanMarkdown);
    if (bullets.length) out.push({ title: '요약', bullets });
  }
  return out;
}

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
  const [days, setDays] = useState(90);
  const [since, setSince] = useState(dayjs().subtract(90, 'day').startOf('day').toISOString());
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [error, setError] = useState('');

  // 인사이트 로딩 + 파싱 결과/토글
  const [insightLoading, setInsightLoading] = useState(false);
  const [parsedSections, setParsedSections] = useState([]); // ← 표 데이터
  const [showRaw, setShowRaw] = useState(false);            // ← 원문/표 토글
  const insightRef = useRef(null);

  const CONTROL_H = 46;
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
        const qs = new URLSearchParams({ days: String(days) });
        if (chResol?.channelId) qs.set('channelId', chResol.channelId);
        else qs.set('handle', handle);
        const r = await api(`/api/yt/metrics-by-handle?${qs.toString()}`);
        setChMetrics(r);
      } else {
        const q = new URLSearchParams({ q: keywords, days: String(days) });
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
      const body = { since };
      if (chResol?.channelId) body.channelId = chResol.channelId;
      else body.handle = handle;

      const r = await api('/api/yt/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (r.error) throw new Error(r.error);
      await loadMetrics();
      // 수집 완료 후 인사이트 초기화
      setChInsight('');
      setKwInsight('');
      setParsedSections([]);
      setShowRaw(false);
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
    setParsedSections([]);
    setShowRaw(false);

    try {
      // **YouTube API 추가 호출 방지**: 화면의 rows를 그대로 서버에 전달
      const baseRows = (mode === 'channel' ? chMetrics?.rows : kwMetrics?.rows) || [];
      const visible = filterRowsByDays(baseRows, days);

      const r = await api('/api/yt/insight', {
        method:'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          days,
          rows: visible,
          ...(mode === 'channel' && visible.length === 0
            ? (chResol?.channelId ? { channelId: chResol.channelId } : { handle })
            : {})
        })
      });

      const text = r.text || '(no result)';
      if (mode === 'channel') setChInsight(text);
      else setKwInsight(text);

      // ⬇️ 파싱해서 표 데이터로 보관
      setParsedSections(parseInsightText(text));

      setTimeout(() => insightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 10);
    } catch (e) {
      const msg = `❌ ${e.message || String(e)}`;
      if (mode === 'channel') setChInsight(msg);
      else setKwInsight(msg);
    } finally {
      setInsightLoading(false);
    }
  };

  /* ---------- 화면에 뿌릴 데이터 선택 ---------- */
  const resol = mode === 'channel' ? chResol : null;

  // 서버 메트릭(캐시)
  const effectiveMetrics = useMemo(() => {
    if (mode === 'keyword') {
      return kwMetrics?.query ? kwMetrics : null;
    }
    return chMetrics;
  }, [mode, chMetrics, kwMetrics]);

  // 서버 rows에서 days 재컷팅 → **화면용 데이터**
  const baseRows = effectiveMetrics?.rows || [];
  const visibleRows = useMemo(() => filterRowsByDays(baseRows, days), [baseRows, days]);

  // 차트 데이터
  const chartData = useMemo(() => {
    const byDay = {};
    for (const v of visibleRows) {
      const d = (v.publishedAt || '').slice(0, 10);
      if (!d) continue;
      byDay[d] = (byDay[d] || 0) + 1;
    }
    return Object.keys(byDay).sort().map(d => ({ date: d, count: byDay[d] }));
  }, [visibleRows]);

  // Top10 (조회수)
  const top = useMemo(() => {
    return visibleRows.slice().sort((a,b) => b.views - a.views).slice(0, 10);
  }, [visibleRows]);

  // 표 데이터
  const rows = visibleRows;

  const primaryBtnLabel = loading
    ? (mode === 'channel' ? '지표 새로고침 중…' : '검색 중…')
    : (mode === 'channel' ? '지표 새로고침' : '검색 실행');

  /* ================= Render ================= */
  return (
    <div style={{
      minHeight:'100vh',
      background: theme.bgGradient,
      color: theme.text,
    }}>
      <header style={{
        position:'sticky', top:0, zIndex:5,
        background:'rgba(255,255,255,0.8)', backdropFilter:'blur(12px)',
        borderBottom:`1px solid ${theme.border}`,
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      }}>
        <div style={{ maxWidth:1200, margin:'0 auto', padding:'16px 20px',
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{
              width:40, height:40, borderRadius:12,
              background: '#ffffff',
              display:'grid', placeItems:'center',
              boxShadow: theme.shadow,
              padding: 7,
              overflow: 'hidden'
            }}>
              <img src="/vite.svg" alt="Logo" style={{ width:'100%', height:'100%', objectFit:'contain' }} />
            </div>
            <div>
              <div style={{ fontWeight:700, fontSize:16, letterSpacing:'-0.01em', color: theme.text }}>YouTube Intelligence Dashboard</div>
              <div style={{ fontSize:12, color: theme.sub, marginTop:2 }}>채널/키워드 트래킹 · 업로드/성과 분석 · AI 인사이트</div>
            </div>
          </div>
          <div style={{ fontSize:12, color: theme.sub, fontWeight:500 }}>since {dayjs().format('YYYY.MM.DD')}</div>
        </div>
      </header>

      <main style={{ maxWidth:1200, margin:'24px auto 80px', padding:'0 20px', display:'grid', gap:16 }}>
        {/* 컨트롤 바 */}
        <Card>
          <div className="control-grid" style={{
            display:'flex',
            flexWrap:'wrap',
            gap:20,
            alignItems:'flex-end'
          }}>
            {/* 채널 핸들 입력 */}
            <div style={{ flex:'1 1 320px', minWidth:220 }}>
              <div style={{ fontSize:12, color: theme.sub, marginBottom:8 }}>채널 핸들</div>
              <Input value={handle} onChange={e=>setHandle(e.target.value)} placeholder="@brand" />
            </div>

            {/* 채널 확인 버튼 */}
            <div style={{ flex:'0 0 120px' }}>
              <div style={{ fontSize:12, color: theme.sub, marginBottom:8, opacity:0 }}>확인</div>
              <Button onClick={resolveHandle} disabled={loading} variant="secondary" style={{ 
                width:'100%', 
                justifyContent: loading ? 'flex-start' : 'center',
                gap: loading ? 6 : 0
              }}>
                {loading ? <Spinner size={14} /> : null} 채널 확인
              </Button>
            </div>

            {/* 지표 기간 입력 */}
            <div style={{ flex:'0 0 160px', minWidth:140 }}>
              <div style={{ fontSize:12, color: theme.sub, marginBottom:8 }}>지표 기간(일)</div>
              <Input type="number" min={7} max={720} value={days} onChange={e=>setDays(Number(e.target.value))} />
            </div>

            {/* 수집 시작 날짜 표시 */}
            <div style={{ flex:'0 0 160px', minWidth:140 }}>
              <div style={{ fontSize:12, color: theme.sub, marginBottom:8 }}>수집 시작 날짜</div>
              <Input value={dayjs(since).format('YYYY-MM-DD')} readOnly style={{
                cursor:'default', background:'#f9fafb', color: theme.text
              }} />
            </div>

            {/* 수집 실행 버튼 */}
            <div style={{ flex:'0 0 180px' }}>
              <div style={{ fontSize:12, color: theme.sub, marginBottom:8, opacity:0 }}>실행</div>
              <Button onClick={ingest} disabled={ingesting || !chResol} style={{ 
                width:'100%', 
                justifyContent: ingesting ? 'flex-start' : 'center',
                gap: ingesting ? 6 : 0
              }}>
                {ingesting ? <Spinner size={14} /> : null} {ingesting ? '수집 중…' : '수집 실행'}
              </Button>
            </div>
          </div>
        </Card>

        {/* 채널 정보 */}
        <Card title="채널 정보">
          {chResol ? (
            <>
              <div style={{ display:'flex', gap:14, alignItems:'center' }}>
                <img src={chResol.thumbnails?.default?.url} width={72} height={72} alt="" style={{ borderRadius:10 }}/>
                <div>
                  <div style={{ fontWeight:900, fontSize:18 }}>{chResol.title}</div>
                  <div style={{ fontSize:13, color: theme.sub }}>channelId: {chResol.channelId}</div>
                  {chResol.stats && (
                    <div style={{ fontSize:13, color: theme.text, marginTop:6 }}>
                      구독자: {Number(chResol.stats.subscriberCount || 0).toLocaleString()} ·
                      영상: {Number(chResol.stats.videoCount || 0).toLocaleString()} ·
                      조회: {Number(chResol.stats.viewCount || 0).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
              {chResol.description && (
                <div style={{ marginTop:12, padding:14, borderRadius:10, background: theme.tableHead }}>
                  <div style={{ fontWeight:800, marginBottom:6 }}>설명</div>
                  <div style={{ fontSize:13, whiteSpace:'pre-wrap', color: theme.text }}>
                    {chResol.description}
                  </div>
                </div>
              )}
            </>
          ) : <div style={{ color: theme.sub }}>핸들을 확인해 주세요.</div>}
        </Card>

        {/* 인사이트 */}
        <Card
          title="🧠 AI 인사이트"
          actions={
            <>
              {!insightLoading && (mode==='channel' ? chInsight : kwInsight) && (mode==='channel' ? chInsight : kwInsight) !== '분석 중…' ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setShowRaw(v => !v);
                    }}
                  >
                    {showRaw ? '표 보기' : '원문 보기'}
                  </Button>
                  <Button variant="secondary" onClick={() => {
                    setParsedSections([]);
                    if (mode==='channel') setChInsight('');
                    else setKwInsight('');
                    setShowRaw(false);
                  }}>지우기</Button>
                  <Button variant="secondary" onClick={() => {
                    const text = mode==='channel' ? chInsight : kwInsight;
                    text && navigator.clipboard.writeText(text);
                  }}>복사</Button>
                  <Button onClick={loadInsight} disabled={insightLoading || !effectiveMetrics}>
                    {insightLoading ? <Spinner/> : null} 다시 분석
                  </Button>
                </>
              ) : (
                <Button onClick={loadInsight} disabled={insightLoading || !effectiveMetrics}>
                  {insightLoading ? <Spinner/> : null} AI 인사이트
                </Button>
              )}
            </>
          }
          style={{ scrollMarginTop: 90 }}
        >
          {/* 표 / 원문 토글 */}
          {showRaw || !parsedSections.length ? (
            <div ref={insightRef} style={{
              whiteSpace:'pre-wrap', fontSize:14, lineHeight:1.7, margin:0, color: theme.text,
              fontFamily: 'inherit'
            }}>
              {(mode==='channel' ? chInsight : kwInsight) || '“AI 인사이트” 버튼을 눌러 요약을 생성하세요.'}
            </div>
          ) : (
            <div ref={insightRef} style={{ display:'grid', gap:16 }}>
              {parsedSections.map((sec, sIdx) => (
                <div key={sIdx} style={{ border:`1px solid ${theme.border}`, borderRadius:12, overflow:'hidden' }}>
                  <div style={{ 
                    padding:'14px 16px', 
                    fontWeight:700, 
                    fontSize:16, 
                    background: theme.tableHead, 
                    color: theme.text,
                    letterSpacing:'-0.01em'
                  }}>
                    {sec.title}
                  </div>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thSmall, width:40 }}>#</th>
                        <th style={th}>핵심 포인트</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sec.bullets.map((b, i) => (
                        <tr key={i} style={{ background: i % 2 ? theme.tableStripe : '#fff' }}>
                          <td style={{ 
                            ...tdSmall, 
                            width:40, 
                            color: theme.sub,
                            textAlign:'center',
                            padding:'12px 8px'
                          }}>{i+1}</td>
                          <td style={{
                            ...td,
                            lineHeight:1.6
                          }} dangerouslySetInnerHTML={{ __html: b }} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {!parsedSections.length && (
                <div style={{ color: theme.sub }}>표로 변환할 항목이 없습니다. "원문 보기"로 확인하세요.</div>
              )}
            </div>
          )}
        </Card>

        {/* 업로드 수 (일별) */}
        <Card title="업로드 수 (일별)">
          {loading && mode === 'keyword' && (
            <div style={{ padding: 8, color: theme.sub, fontSize: 13, display:'flex', alignItems:'center', gap:8 }}>
              <Spinner/> 검색 결과를 불러오는 중…
            </div>
          )}
          <div style={{ height: 300, borderRadius: 12, overflow:'hidden' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke={theme.primary} dot={false} strokeWidth={2.4} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* TOP10 / 최근 업로드 */}
        <div className="two-column-grid" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <Card title="TOP 10 (조회수)">
            <div style={{ display:'grid', gap:10 }}>
              {top.map(v => (
                <a key={v.videoId}
                   href={`https://www.youtube.com/watch?v=${v.videoId}`}
                   target="_blank" rel="noreferrer"
                   style={{
                     display:'grid', gridTemplateColumns:'156px 1fr', gap:12,
                     textDecoration:'none', color:'inherit',
                     padding:10, borderRadius:12, border:`1px solid ${theme.border}`, background:'#fff',
                     transition:'box-shadow .2s, transform .06s'
                   }}
                   onMouseEnter={(e)=>{ e.currentTarget.style.boxShadow = theme.shadow; }}
                   onMouseLeave={(e)=>{ e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform='none'; }}
                   onMouseDown={(e)=>{ e.currentTarget.style.transform='translateY(1px)'; }}
                   onMouseUp={(e)=>{ e.currentTarget.style.transform='none'; }}
                >
                  <img src={`https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`} alt=""
                       style={{ width:'100%', borderRadius:10, display:'block' }}/>
                  <div>
                    <div style={{ fontWeight:800, marginBottom:4 }}>{v.title}</div>
                    <div style={{ fontSize:12, color: theme.sub }}>
                      {dayjs(v.publishedAt).format('YYYY-MM-DD HH:mm')} · 조회 {Number(v.views).toLocaleString()} · 좋아요 {Number(v.likes).toLocaleString()} · 댓글 {Number(v.comments).toLocaleString()}
                    </div>
                  </div>
                </a>
              ))}
              {top.length === 0 && <div style={{ color: theme.sub }}>데이터가 없습니다. 먼저 “수집/검색 실행”을 해보세요.</div>}
            </div>
          </Card>

          <Card title="최근 업로드">
            <div style={{ maxHeight: 380, overflow: 'auto', borderRadius:12, border:`1px solid ${theme.border}` }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead style={{ position:'sticky', top:0, zIndex:1, background: theme.tableHead }}>
                  <tr>
                    <th style={th}>제목</th>
                    <th style={thSmall}>업로드</th>
                    <th style={thSmall}>조회</th>
                    <th style={thSmall}>좋아요</th>
                    <th style={thSmall}>댓글</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice().reverse().map((v, idx) => (
                    <tr key={v.videoId} style={{ background: idx % 2 ? theme.tableStripe : '#fff' }}>
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
          </Card>
        </div>

        {error && (
          <div style={{ color: theme.danger, padding:'8px 12px' }}>
            ⚠ {error}
          </div>
        )}
      </main>

      <footer style={{ textAlign:'center', color: theme.sub, fontSize:12, padding:'16px 0 28px' }}>
        © {new Date().getFullYear()} Your Team · Built for insight, not vanity metrics.
      </footer>
    </div>
  );
}

/* ========== table styles ========== */
const th = { 
  textAlign:'left', 
  borderBottom:`1px solid ${theme.border}`, 
  padding:'12px 16px', 
  fontSize:12, 
  fontWeight:600, 
  color: theme.sub,
  letterSpacing:'-0.01em'
};
const thSmall = { ...th, width: 96, whiteSpace:'nowrap' };
const td = { 
  borderBottom:`1px solid ${theme.border}`, 
  padding:'12px 16px', 
  fontSize:13,
  color: theme.text
};
const tdSmall = { ...td, textAlign:'right', whiteSpace:'nowrap' };
