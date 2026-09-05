import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, ArrowUpRight, Check, Clock3, Globe2, LoaderCircle, Network, Search, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { DomainConnection, DomainReport, DomainSourceId } from '../server/domainTypes'
import { consumeChatStream } from './chatStream'
import { buildDomainExplanationPrompt, domainSourceUrl, fetchDomainReport } from './domainAnalysis'

const MarkdownResponse = lazy(() => import('./MarkdownResponse'))
const views = ['요약', '연결 지도', '타임라인', '보안 단서', '출처'] as const
type View = typeof views[number]
const statusLabels = { ok: '조회 완료', empty: '기록 없음', unavailable: '일부 확인 불가', not_configured: '연결 필요' }
const kinds = { certificate: '인증서에 등장', request: '외부 요청', shared_identifier: '공통 식별자' }

function timestamp(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '관측 시각 미제공'
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replace(/-/g, '.')
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function SourceLink({ report, id, observedAt }: { report: DomainReport; id: DomainSourceId; observedAt?: string }) {
  const source = report.sources.find((source) => source.id === id)
  const url = source && domainSourceUrl(source.url)
  return <span className="domain-evidence-source">
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.label}<ArrowUpRight size={12} aria-hidden="true" /></a> : source?.label ?? id}
    <span>{timestamp(observedAt ?? source?.observedAt ?? (id === 'dns' ? report.queriedAt : undefined))}</span>
  </span>
}

function ConnectionMap({ report }: { report: DomainReport }) {
  const [kind, setKind] = useState<DomainConnection['kind'] | 'all'>('all')
  const [selected, setSelected] = useState<DomainConnection | null>(null)
  const [expanded, setExpanded] = useState(false)
  const connections = report.connections.filter((item) => kind === 'all' || item.kind === kind)
  const visible = expanded ? connections : connections.slice(0, 8)
  return <>
    <p className="domain-note">선을 선택하면 연결의 근거를 볼 수 있습니다. 같은 운영자이거나 현재 운영 중이라는 뜻은 아닙니다.</p>
    <div className="domain-filters" aria-label="연결 종류">
      {(['all', 'certificate', 'request', 'shared_identifier'] as const).map((value) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => { setKind(value); setSelected(null); setExpanded(false) }}>{value === 'all' ? '전체' : kinds[value]}</button>)}
    </div>
    {connections.length ? <>
      <div className="domain-graph">
        <div className="domain-graph-root"><Globe2 size={23} aria-hidden="true" /><strong>{report.domain}</strong><span>관측된 연결 {connections.length}개</span></div>
        <div className="domain-graph-nodes">
          {visible.map((item) => <button type="button" key={`${item.kind}:${item.domain}`} aria-pressed={selected === item} onClick={() => setSelected(item)} className="domain-graph-node"><span>{kinds[item.kind]}</span><strong>{item.domain}</strong><ArrowRight size={15} aria-hidden="true" /></button>)}
        </div>
      </div>
      {connections.length > 8 && <button type="button" className="domain-text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '접기' : `연결 ${connections.length}개 모두 보기`}</button>}
      {selected && <div className="domain-selected" aria-live="polite"><h3>{selected.domain}</h3><p>{selected.evidence}</p><SourceLink report={report} id={selected.sourceId} observedAt={selected.observedAt} /></div>}
    </> : <div className="domain-empty"><Network size={28} aria-hidden="true" /><h3>표시할 연결 기록이 없습니다</h3><p>공개 인증서·웹 관측·연관 사이트 기록이 확보되면 여기에 표시됩니다. ‘출처’에서 조회 상태를 확인할 수 있습니다.</p></div>}
  </>
}

function Overview({ report }: { report: DomainReport }) {
  return <>
    <div className="domain-metrics">
      <div><span>공개 DNS 응답</span><strong>{report.dns.length}<small>개</small></strong></div>
      <div><span>관측된 연결</span><strong>{report.connections.length}<small>개</small></strong></div>
      <div><span>시점이 있는 기록</span><strong>{report.timeline.length}<small>개</small></strong></div>
    </div>
    {report.facts.length > 0 && <dl className="domain-facts">{report.facts.map((fact, i) => <div key={`${fact.label}:${i}`}><dt>{fact.label}{fact.inferred && <span>추정</span>}</dt><dd>{fact.value}</dd><SourceLink report={report} id={fact.sourceId} /></div>)}</dl>}
    <details className="domain-dns"><summary>DNS 레코드 <span>{report.dns.length}개</span></summary>
      {report.dns.length ? <div className="domain-dns-rows">{report.dns.map((row, i) => <div key={i}><span className="domain-record-type">{row.type}</span><div><strong>{row.value}</strong><p>{row.name} · TTL {row.ttl}초</p></div></div>)}</div> : <p className="domain-note">확보된 DNS 응답이 없습니다. 출처별 상태를 확인해 주세요.</p>}
    </details>
    <div className="domain-scope"><ShieldCheck size={18} aria-hidden="true" /><p>현재 DNS와 공개 기록을 함께 보여줍니다. 사이트에 새 스캔을 보내거나 로그인하지 않으며, 현재의 취약점·실운영자·매출을 확정하는 검사는 아닙니다.</p></div>
  </>
}

export default function DomainAnalysisDialog({ model, reasoningEnabled, onClose }: { model: string; reasoningEnabled?: boolean; onClose(): void }) {
  const titleId = useId()
  const inputId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scanRef = useRef<AbortController | null>(null)
  const aiRef = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const [input, setInput] = useState('')
  const [report, setReport] = useState<DomainReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('요약')
  const [explanation, setExplanation] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiModel, setAiModel] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current!
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    dialog.showModal()
    inputRef.current?.focus()
    document.body.style.overflow = 'hidden'
    return () => {
      generation.current++
      scanRef.current?.abort()
      aiRef.current?.abort()
      dialog.close()
      document.body.style.overflow = previousOverflow
      const focus = previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLButtonElement>('[aria-controls="composer-tools-menu"]')
      focus?.focus({ preventScroll: true })
    }
  }, [])

  async function explain(result: DomainReport, currentGeneration: number) {
    aiRef.current?.abort()
    const controller = new AbortController()
    aiRef.current = controller
    setExplanation(''); setAiError(''); setAiLoading(true); setAiModel(model)
    const timeout = setTimeout(() => controller.abort('timeout'), 90_000)
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model, reasoningEnabled, webSearchMode: 'off', messages: [{ role: 'user', content: buildDomainExplanationPrompt(result) }] }),
      })
      if (!response.ok || !response.body) throw new Error('AI 해설을 가져오지 못했습니다. 수집된 결과는 아래에서 확인할 수 있습니다.')
      let content = ''
      await consumeChatStream(response.body, { onContent(chunk) {
        content += chunk
        if (generation.current === currentGeneration && !controller.signal.aborted) setExplanation(content)
      } })
      if (!content.trim()) throw new Error('AI가 해설을 반환하지 않았습니다.')
    } catch (caught) {
      if (generation.current === currentGeneration && (!controller.signal.aborted || controller.signal.reason === 'timeout')) setAiError(controller.signal.reason === 'timeout' ? 'AI 해설 시간이 초과되었습니다. 다시 요청할 수 있습니다.' : caught instanceof Error ? caught.message : 'AI 해설을 가져오지 못했습니다.')
    } finally {
      clearTimeout(timeout)
      if (generation.current === currentGeneration && aiRef.current === controller) { setAiLoading(false); aiRef.current = null }
    }
  }

  async function analyze(event: FormEvent) {
    event.preventDefault()
    if (!input.trim() || loading) return
    scanRef.current?.abort(); aiRef.current?.abort()
    const currentGeneration = ++generation.current
    const controller = new AbortController()
    scanRef.current = controller
    setLoading(true); setError(''); setReport(null); setExplanation(''); setAiError(''); setAiLoading(false); setView('요약')
    const timeout = setTimeout(() => controller.abort('timeout'), 40_000)
    try {
      const result = await fetchDomainReport(input.trim(), controller.signal)
      if (generation.current !== currentGeneration || controller.signal.aborted) return
      setReport(result)
      if (result.dns.length || result.facts.length || result.timeline.length || result.connections.length || result.findings.length) void explain(result, currentGeneration)
    } catch (caught) {
      if (generation.current === currentGeneration && (!controller.signal.aborted || controller.signal.reason === 'timeout')) setError(controller.signal.reason === 'timeout' ? '분석 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' : caught instanceof Error ? caught.message : '도메인을 분석하지 못했습니다.')
    } finally {
      clearTimeout(timeout)
      if (generation.current === currentGeneration) { setLoading(false); scanRef.current = null }
    }
  }

  const cancel = () => { generation.current++; scanRef.current?.abort(); aiRef.current?.abort(); setLoading(false); setAiLoading(false); setError('분석을 취소했습니다.') }

  return createPortal(<dialog ref={dialogRef} className="domain-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose() }} onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }}
    onClick={(event) => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose() }}>
    <header className="domain-header"><div className="domain-heading"><span className="domain-heading-icon"><Globe2 size={23} aria-hidden="true" /></span><div><span className="domain-eyebrow">MIRA / DOMAIN</span><h2 id={titleId}>도메인 분석</h2></div></div><button type="button" className="domain-close" onClick={onClose} aria-label="도메인 분석 닫기"><X size={20} aria-hidden="true" /></button></header>
    <div className="domain-scroll">
      <form className="domain-form" onSubmit={(event) => void analyze(event)}>
        <label htmlFor={inputId}>분석할 도메인</label>
        <div className="domain-input-row"><div className="domain-input-wrap"><Search size={18} aria-hidden="true" /><input ref={inputRef} id={inputId} value={input} onChange={(event) => setInput(event.target.value)} placeholder="example.com" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={2048} required aria-describedby={`${inputId}-hint`} /></div>
          {loading ? <button type="button" className="domain-primary" onClick={cancel}><X size={16} aria-hidden="true" />취소</button> : <button type="submit" className="domain-primary" disabled={!input.trim()}><Search size={16} aria-hidden="true" />분석 시작</button>}
        </div>
        <p id={`${inputId}-hint`} className="domain-note">도메인이나 웹 주소를 입력하세요. 주소의 경로는 제외하고 도메인을 공개 정보 서비스에 조회합니다.</p>
      </form>
      {error && <p className="domain-error" role="alert">{error}</p>}
      {loading && <div className="domain-loading" role="status"><LoaderCircle className="domain-spinner" size={26} aria-hidden="true" /><h3>공개 기록을 모으고 있습니다</h3><p>DNS · 등록정보 · 인증서 · 과거 웹 기록<br />일부 출처가 응답하지 않아도 확인된 결과를 보여줍니다.</p></div>}
      {!report && !loading && <div className="domain-intro"><div><Network size={22} aria-hidden="true" /><h3>연결의 흔적</h3><p>인증서와 공개 웹 기록에 등장한 도메인을 연결합니다.</p></div><div><Clock3 size={22} aria-hidden="true" /><h3>시간 속 기록</h3><p>등록·인증서·보관된 페이지를 관측 시점별로 살펴봅니다.</p></div><div><ShieldCheck size={22} aria-hidden="true" /><h3>근거 있는 해설</h3><p>확인된 정보와 확인할 수 없는 부분을 나누어 설명합니다.</p></div></div>}
      {report && <>
        <div className="domain-report-heading" role="status"><div><h3>{report.domain}</h3><p>{timestamp(report.queriedAt)} 조회{report.cacheHit && ' · 최근 조회 재사용'}</p></div><span><Check size={14} aria-hidden="true" />{report.sources.filter((source) => source.status === 'ok').length}/{report.sources.length} 출처 완료</span></div>
        <nav className="domain-tabs" aria-label="분석 결과 보기">{views.map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>{item}</button>)}</nav>
        <section className="domain-panel" aria-label={view}>
          {view === '요약' && <><Overview report={report} />
            <section className="domain-ai" aria-label="AI 해설"><div className="domain-section-heading"><h3><Sparkles size={16} aria-hidden="true" />AI 해설</h3><span>{aiModel || model}</span></div>
              {aiLoading && <p className="domain-note" role="status"><LoaderCircle className="domain-spinner" size={14} aria-hidden="true" />수집된 근거를 해설하고 있습니다…</p>}
              {explanation && <div className="domain-explanation"><Suspense fallback={<p>{explanation}</p>}><MarkdownResponse content={explanation} /></Suspense></div>}
              {aiError && <p className="domain-error" role="alert">{aiError}</p>}
              {!aiLoading && (aiError || (!explanation && (report.dns.length > 0 || report.facts.length > 0))) && <button type="button" className="domain-text-button" onClick={() => void explain(report, generation.current)}>AI 해설 다시 요청</button>}
              {!aiLoading && !explanation && !aiError && !report.dns.length && !report.facts.length && <p className="domain-note">해설할 근거가 부족합니다. 출처별 조회 상태를 확인해 주세요.</p>}
              <p className="domain-note">AI 해설은 오류가 있을 수 있습니다. 아래의 출처와 관측 시점을 기준으로 확인하세요.</p>
            </section></>}
          {view === '연결 지도' && <ConnectionMap key={report.queriedAt + report.domain} report={report} />}
          {view === '타임라인' && <><p className="domain-note">수집된 시점만 표시합니다. 최초 발견일은 생성일과 다를 수 있으며, 보관 기록이 모든 변경을 담지는 않습니다.</p>{report.timeline.length ? <ol className="domain-timeline">{report.timeline.map((item, i) => <li key={i}><time dateTime={item.date}>{timestamp(item.date)}</time><h3>{item.label}</h3><p>{item.detail}</p><SourceLink report={report} id={item.sourceId} observedAt={item.date} />{item.url && domainSourceUrl(item.url) && <a className="domain-text-button" href={domainSourceUrl(item.url)} target="_blank" rel="noopener noreferrer">이 기록 열기<ArrowUpRight size={13} aria-hidden="true" /></a>}</li>)}</ol> : <div className="domain-empty"><Clock3 size={26} aria-hidden="true" /><p>시점이 확인되는 기록을 확보하지 못했습니다.</p></div>}</>}
          {view === '보안 단서' && <><p className="domain-note">DNS는 조회 시점, 웹 응답은 공개 관측 당시의 정보입니다. 취약점 공격 검증이나 현재 TLS 연결 검사는 수행하지 않습니다.</p><div className="domain-findings">{report.findings.map((finding) => <article key={finding.id} className={`domain-finding ${finding.level}`}><h3>{finding.title}</h3><p>{finding.detail}</p><code>{finding.evidence}</code><SourceLink report={report} id={finding.sourceId} observedAt={finding.observedAt} /></article>)}</div><div className="domain-scope"><p>웹 응답 상세가 제공되지 않으면 헤더·쿠키·외부 연결도 확인할 수 없습니다. 광고 판매 정보·사이트맵·robots.txt는 이 버전에서 직접 가져오지 않습니다.</p></div></>}
          {view === '출처' && <><p className="domain-note">추가 서비스의 키는 서버 환경변수로 연결할 수 있습니다. 연결되지 않은 항목은 분석 결과에 포함되지 않습니다.</p><div className="domain-sources">{report.sources.map((source) => <article key={source.id}><div className="domain-section-heading"><h3>{source.label}</h3><span className={`domain-source-status ${source.status}`}>{statusLabels[source.status]}</span></div><p>{source.message}</p><SourceLink report={report} id={source.id} /></article>)}</div></>}
        </section>
      </>}
    </div>
  </dialog>, document.body)
}
