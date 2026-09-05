import { lazy, Suspense, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, LoaderCircle, RotateCcw, Sparkles, Square } from 'lucide-react'
import type { DomainReport } from '../server/domainTypes'
import { consumeChatStream } from './chatStream'
import { buildDomainChatMessages, DOMAIN_QUESTION_LIMIT, type DomainChatMessage } from './domainAnalysis'

const MarkdownResponse = lazy(() => import('./MarkdownResponse'))
type Attempt = { history: DomainChatMessage[]; question?: string }

export default function DomainAnalysisChat({ report, model, reasoningEnabled }: { report: DomainReport; model: string; reasoningEnabled?: boolean }) {
  const [messages, setMessages] = useState<DomainChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const attemptRef = useRef<Attempt | null>(null)
  const messageIdRef = useRef(0)
  const activeMessageRef = useRef<number | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottom = useRef(true)
  const questionId = useId()
  const hasEvidence = report.dns.length + report.facts.length + report.timeline.length + report.connections.length + report.findings.length > 0

  useEffect(() => {
    if (hasEvidence) void run({ history: [] })
    return () => { controllerRef.current?.abort(); controllerRef.current = null }
    // Each report owns a new chat; model preferences are read when sending a message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report])

  useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const follow = () => { if (stickToBottom.current) viewport.scrollTop = viewport.scrollHeight }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (stickToBottom.current && viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [messages, busy, error])

  async function run(attempt: Attempt) {
    if (controllerRef.current) return
    let requestMessages
    try { requestMessages = buildDomainChatMessages(report, attempt.history, attempt.question) }
    catch (caught) { setError(caught instanceof Error ? caught.message : '질문을 확인해 주세요.'); return }
    const controller = new AbortController()
    controllerRef.current = controller
    attemptRef.current = attempt
    const user: DomainChatMessage[] = attempt.question === undefined ? [] : [{ id: ++messageIdRef.current, role: 'user', content: attempt.question, status: 'complete' }]
    const assistantId = ++messageIdRef.current
    activeMessageRef.current = assistantId
    setMessages([...attempt.history, ...user, { id: assistantId, role: 'assistant', content: '', status: 'streaming', model }])
    setError(''); setBusy(true); stickToBottom.current = true
    const active = () => controllerRef.current === controller && !controller.signal.aborted
    const update = (content: string, status: DomainChatMessage['status']) => setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content, status } : message))
    let content = ''
    const timeout = setTimeout(() => controller.abort('timeout'), 90_000)
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model, reasoningEnabled, webSearchMode: 'off', messages: requestMessages }),
      })
      if (!active()) return
      if (!response.ok || !response.body) throw new Error('AI 응답을 가져오지 못했습니다. 분석 결과와 이전 대화는 유지됩니다.')
      await consumeChatStream(response.body, { onContent(chunk) {
        if (!active()) return
        if (content.length + chunk.length > 32_000) { controller.abort('too_long'); throw new Error('응답 길이 제한') }
        content += chunk
        update(content, 'streaming')
      } })
      if (!active()) return
      if (!content.trim()) throw new Error('AI가 답변을 반환하지 않았습니다. 다시 요청해 주세요.')
      update(content, 'complete')
    } catch (caught) {
      if (controllerRef.current !== controller) return
      update(content, 'error')
      setError(controller.signal.reason === 'timeout' ? 'AI 응답 시간이 초과되었습니다. 다시 요청할 수 있습니다.'
        : controller.signal.reason === 'too_long' ? '응답이 길어 중단했습니다. 질문을 나누어 보내 주세요.'
        : caught instanceof Error ? caught.message : 'AI 응답을 가져오지 못했습니다.')
    } finally {
      clearTimeout(timeout)
      if (controllerRef.current === controller) { controllerRef.current = null; activeMessageRef.current = null; setBusy(false) }
    }
  }

  function stop() {
    const id = activeMessageRef.current
    controllerRef.current?.abort()
    controllerRef.current = null
    activeMessageRef.current = null
    setBusy(false); setError('')
    setMessages((current) => current.map((message) => message.id === id ? { ...message, status: 'stopped' } : message))
  }

  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (controllerRef.current || !hasEvidence || !draft.trim()) return
    const question = draft.trim()
    if (question.length > DOMAIN_QUESTION_LIMIT) { setError(`질문은 ${DOMAIN_QUESTION_LIMIT}자까지 입력할 수 있습니다.`); return }
    setDraft('')
    void run({ history: messages, question })
  }
  const last = messages.at(-1)
  const retry = !busy && attemptRef.current && (last?.status === 'error' || last?.status === 'stopped')

  return <aside className="domain-ai" aria-label="AI 해설 및 대화">
    <div className="domain-ai-heading"><div><span className="domain-eyebrow">INTELLIGENCE BRIEF</span><h3><Sparkles size={16} aria-hidden="true" />AI 해설</h3></div><span className={`domain-ai-presence ${busy ? 'active' : ''}`}><i aria-hidden="true" />{busy ? '응답 중' : '대화 가능'}</span></div>
    <div className="domain-chat-context"><span>CONTEXT</span><strong>{report.domain}</strong></div>
    <div ref={viewportRef} className="domain-chat-viewport" tabIndex={0} aria-label="분석 대화 내역" onScroll={() => {
      const viewport = viewportRef.current!
      stickToBottom.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 60
    }}><div ref={contentRef} className="domain-chat-messages">
      {messages.map((message) => <article key={message.id} className={`domain-chat-message ${message.role}`} aria-label={message.role === 'user' ? '내 질문' : 'AI 답변'}>
        <div className="domain-chat-speaker"><span>{message.role === 'user' ? 'YOU' : 'MIRA'}</span>{message.role === 'assistant' && <span>{message.model}</span>}</div>
        {message.content && (message.role === 'assistant' ? <div className="domain-explanation"><Suspense fallback={<p>{message.content}</p>}><MarkdownResponse content={message.content} /></Suspense></div> : <p className="domain-user-question">{message.content}</p>)}
        {message.status === 'streaming' && <p className="domain-chat-status" role="status"><LoaderCircle size={14} className="domain-spinner" aria-hidden="true" />{message.content ? '답변을 작성하고 있습니다…' : '수집된 근거를 살펴보고 있습니다…'}</p>}
        {message.status === 'stopped' && <p className="domain-chat-status">응답을 중지했습니다.</p>}
        {message.status === 'error' && message.content && <p className="domain-chat-status">응답이 완료되지 않았습니다.</p>}
      </article>)}
      {!hasEvidence && <p className="domain-note">해설할 근거가 부족합니다. 출처별 조회 상태를 확인해 주세요.</p>}
      {error && <p className="domain-error" role="alert">{error}</p>}
      {retry && <button type="button" className="domain-text-button" onClick={() => void run(attemptRef.current!)}><RotateCcw size={13} aria-hidden="true" />{attemptRef.current!.question === undefined ? 'AI 해설 다시 요청' : '답변 다시 요청'}</button>}
    </div></div>
    <form className="domain-chat-composer" onSubmit={submit}>
      <label htmlFor={questionId}>이 분석에 대해 질문하기</label>
      <div className="domain-question-wrap"><textarea ref={inputRef} id={questionId} rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={DOMAIN_QUESTION_LIMIT} disabled={!hasEvidence} placeholder="이 결과가 어떤 의미인지 물어보세요…" onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); submit() }
      }} />
        {busy ? <button type="button" className="domain-question-send stop" onClick={stop} aria-label="AI 응답 중지"><Square size={15} aria-hidden="true" /></button> : <button type="submit" className="domain-question-send" disabled={!hasEvidence || !draft.trim()} aria-label="분석 질문 보내기"><ArrowUp size={18} aria-hidden="true" /></button>}
      </div>
      <p className="domain-chat-footnote">분석 결과와 최근 대화를 참고합니다. 창을 닫으면 대화가 지워집니다.</p>
    </form>
    <p className="domain-ai-disclaimer">AI 답변은 출처와 관측 시점을 함께 확인해 주세요.</p>
  </aside>
}
