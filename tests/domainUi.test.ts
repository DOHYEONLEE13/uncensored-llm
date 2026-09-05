import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { DomainReport } from '../server/domainTypes.ts'

const dom = new Window({ url: 'https://mira.test', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } })
dom.document.write('<!doctype html><html><head></head><body></body></html>')
Reflect.deleteProperty(dom.Element.prototype, 'animate')
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, SVGElement: dom.SVGElement, Element: dom.Element, Node: dom.Node,
  ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
}
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
const { createRoot } = await import('react-dom/client')
const { default: App } = await import('../src/App.tsx')
after(async () => {
  await dom.happyDOM.abort()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
async function click(label: string) {
  const button = dom.document.querySelector(`[aria-label="${label}"]`)
  assert.ok(button, label)
  await act(async () => (button as unknown as HTMLElement).click()); await settle()
}
const report: DomainReport = {
  version: 1, domain: 'example.com', queriedAt: '2026-09-06T00:00:00Z', cacheHit: false,
  sources: [{ id: 'dns', label: 'Google Public DNS', status: 'ok', message: '조회 완료', url: 'https://dns.google/query?name=example.com' }, { id: 'certificates', label: 'crt.sh', status: 'ok', message: '조회 완료', url: 'https://crt.sh/?q=example.com' }],
  facts: [{ label: '등록 도메인', value: 'example.com', sourceId: 'dns' }],
  dns: [{ type: 'A', name: 'example.com', value: '192.0.2.1', ttl: 60 }], findings: [],
  connections: [{ domain: 'www.example.com', kind: 'certificate', sourceId: 'certificates', evidence: '<script>do not execute</script>', observedAt: '2026-08-01T00:00:00Z' }],
  timeline: [{ date: '2026-08-01', label: '인증서 공개 기록', detail: 'example.com', sourceId: 'certificates' }],
}
async function setup(responder: (input: string, init?: RequestInit) => Promise<Response>) {
  dom.localStorage.clear()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => String(input) === '/api/status' ? Response.json({ configured: true, model: 'obsidian/Qwen3.8-27B' }) : responder(String(input), init)
  const host = dom.document.createElement('div'); dom.document.body.append(host)
  const root = createRoot(host as unknown as HTMLElement)
  await act(async () => root.render(createElement(App)))
  await act(async () => host.querySelector('textarea')!.focus()); await settle()
  await click('채팅 도구 열기')
  await click('웹 해킹 열기')
  for (let i = 0; i < 30 && !dom.document.querySelector('.domain-dialog'); i++) await settle()
  assert.ok(dom.document.querySelector('dialog[open]'))
  async function submit(value: string) {
    const input = dom.document.querySelector('.domain-form input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new dom.Event('input', { bubbles: true }))
      input.dispatchEvent(new dom.Event('change', { bubbles: true }))
    })
    await act(async () => input.closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })))
    await settle()
  }
  return { host, submit, async dispose() { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch } }
}

test('plus menu opens domain dialog, evidence appears before AI, graph is interactive and nothing enters conversation history', async () => {
  let aiBody: Record<string, unknown> | undefined
  let aiSignal: AbortSignal | undefined
  const view = await setup(async (url, init) => {
    if (url === '/api/domain/analyze') return Response.json(report)
    if (url === '/api/chat') { aiBody = JSON.parse(String(init!.body)); aiSignal = init!.signal!; return new Promise((_resolve, reject) => aiSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) }
    throw new Error('Unexpected endpoint')
  })
  try {
    assert.equal(dom.document.activeElement?.tagName, 'INPUT')
    await view.submit('example.com')
    assert.match(dom.document.querySelector('.domain-report-heading')!.textContent, /example.com/)
    assert.equal(aiBody?.webSearchMode, 'off')
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /살펴보고 있습니다/)
    const graph = Array.from(dom.document.querySelectorAll('.domain-tabs button')).find((button) => button.textContent === '연결 지도')!
    await act(async () => graph.click())
    await act(async () => dom.document.querySelector<HTMLButtonElement>('.domain-graph-node')!.click())
    assert.match(dom.document.querySelector('.domain-selected')!.textContent, /<script>do not execute<\/script>/)
    assert.equal(dom.document.querySelector('.domain-selected script'), null)
    assert.equal(dom.localStorage.getItem('mira-conversations')?.includes('example.com') ?? false, false)
    await click('웹 해킹 닫기')
    assert.equal(aiSignal?.aborted, true)
    assert.equal(dom.document.querySelector('.domain-dialog'), null)
    assert.equal(dom.document.body.style.overflow, '')
    assert.equal(dom.document.activeElement, view.host.querySelector('textarea'))
  } finally { await view.dispose() }
})

test('cancelled analysis ignores a late response and API errors stay inside the dialog without an AI request', async () => {
  let finish: (response: Response) => void = () => undefined
  let firstSignal: AbortSignal | undefined
  let calls = 0
  const view = await setup(async (url, init) => {
    assert.equal(url, '/api/domain/analyze')
    calls++
    if (calls === 1) { firstSignal = init?.signal ?? undefined; return new Promise((resolve) => { finish = resolve }) }
    return Response.json({ error: '공개 도메인을 입력해 주세요.' }, { status: 400 })
  })
  try {
    await view.submit('example.com')
    const cancel = dom.document.querySelector<HTMLButtonElement>('.domain-primary')!
    assert.match(cancel.textContent!, /취소/)
    await act(async () => cancel.click())
    assert.equal(firstSignal?.aborted, true)
    await act(async () => finish(Response.json(report))); await settle()
    assert.equal(dom.document.querySelector('.domain-report-heading'), null)
    await view.submit('localhost')
    assert.match(dom.document.querySelector('.domain-error')!.textContent, /공개 도메인/)
    assert.equal(calls, 2)
  } finally { await view.dispose() }
})

test('AI failure leaves collected results usable and retry streams an explanation', async () => {
  let aiCalls = 0
  const view = await setup(async (url) => {
    if (url === '/api/domain/analyze') return Response.json(report)
    aiCalls++
    return aiCalls === 1 ? Response.json({ error: 'unavailable' }, { status: 503 }) : new Response('data: {"choices":[{"delta":{"content":"공개 인증서 기록을 확인했습니다."}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  try {
    await view.submit('example.com')
    assert.ok(dom.document.querySelector('.domain-metrics'))
    assert.match(dom.document.querySelector('.domain-ai .domain-error')!.textContent, /AI 응답/)
    const retry = Array.from(dom.document.querySelectorAll('.domain-ai button')).find((button) => button.textContent === 'AI 해설 다시 요청')!
    await act(async () => retry.click()); await settle()
    assert.equal(aiCalls, 2)
    assert.match(dom.document.querySelector('.domain-explanation')!.textContent, /공개 인증서 기록/)
    assert.equal(dom.document.querySelector('.domain-ai .domain-error'), null)
  } finally { await view.dispose() }
})

async function ask(question: string) {
  const input = dom.document.querySelector('.domain-chat-composer textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, question)
    input.dispatchEvent(new dom.Event('input', { bubbles: true }))
    input.dispatchEvent(new dom.Event('change', { bubbles: true }))
  })
  await act(async () => input.closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })))
  await settle()
}
const sse = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const answer = (content: string) => new Response(`${sse(content)}data: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })

test('web hacking title, follow-up context and conversation survive result navigation without storing chat', async () => {
  const requests: { model: string; webSearchMode: string; messages: { role: string; content: string }[] }[] = []
  let scans = 0
  const view = await setup(async (url, init) => {
    if (url === '/api/domain/analyze') { scans++; return Response.json(report) }
    requests.push(JSON.parse(String(init!.body)))
    return answer(['초기 해설입니다.', 'DNS는 도메인의 연결 정보를 제공합니다.', '인증서 관측 시점을 확인하세요.'][requests.length - 1])
  })
  try {
    assert.equal(dom.document.querySelector('.domain-heading h2')!.textContent?.replace('_', ''), '웹 해킹')
    await view.submit('example.com')
    await ask('DNS는 무엇인가요?')
    const graph = Array.from(dom.document.querySelectorAll('.domain-tabs button')).find((button) => button.textContent === '연결 지도')!
    await act(async () => graph.click())
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /DNS는 도메인/)
    await ask('그럼 인증서는요?')
    assert.equal(scans, 1)
    assert.equal(requests.length, 3)
    assert.equal(requests[2].webSearchMode, 'off')
    assert.match(requests[2].messages[0].content, /evidence_json/)
    assert.match(requests[2].messages[0].content, /example\.com/)
    assert.doesNotMatch(requests[2].messages[0].content, /총 3개의 짧은 문단/)
    assert.deepEqual(requests[2].messages.slice(1), [
      { role: 'assistant', content: '초기 해설입니다.' }, { role: 'user', content: 'DNS는 무엇인가요?' },
      { role: 'assistant', content: 'DNS는 도메인의 연결 정보를 제공합니다.' }, { role: 'user', content: '그럼 인증서는요?' },
    ])
    assert.equal(dom.document.querySelectorAll('.domain-chat-message.user').length, 2)
    assert.doesNotMatch(dom.localStorage.getItem('mira-conversations') ?? '', /DNS는|인증서는|example\.com/)
  } finally { await view.dispose() }
})

test('failed follow-up retry preserves completed answers and replaces the last question once', async () => {
  const requests: unknown[] = []
  const view = await setup(async (url, init) => {
    if (url === '/api/domain/analyze') return Response.json(report)
    requests.push(JSON.parse(String(init!.body)))
    return requests.length === 2 ? Response.json({}, { status: 503 }) : answer(requests.length === 1 ? '유지할 초기 해설' : '재시도 답변')
  })
  try {
    await view.submit('example.com'); await ask('첫 번째 질문')
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /유지할 초기 해설/)
    const retry = Array.from(dom.document.querySelectorAll('.domain-ai button')).find((button) => button.textContent?.includes('답변 다시 요청'))!
    await act(async () => retry.click()); await settle()
    assert.deepEqual(requests[2], requests[1])
    assert.equal(dom.document.querySelectorAll('.domain-chat-message.user').length, 1)
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /재시도 답변/)
  } finally { await view.dispose() }
})

test('stopping a stream retains its partial text but excludes it from future context and ignores late chunks', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let calls = 0
  let request: { messages: { content: string }[] } | undefined
  const view = await setup(async (url, init) => {
    if (url === '/api/domain/analyze') return Response.json(report)
    calls++
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(sse('미완료 초기 해설'))) } }))
    request = JSON.parse(String(init!.body))
    return answer('새 질문의 정상 답변')
  })
  try {
    await view.submit('example.com')
    await click('AI 응답 중지')
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /미완료 초기 해설/)
    await ask('새로운 질문')
    assert.equal(request!.messages.some((message) => message.content.includes('미완료 초기 해설')), false)
    await act(async () => { stream!.enqueue(new TextEncoder().encode(sse('늦은 이전 청크'))); stream!.close() }); await settle()
    assert.doesNotMatch(dom.document.querySelector('.domain-ai')!.textContent, /늦은 이전 청크/)
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /새 질문의 정상 답변/)
  } finally { await view.dispose() }
})

test('new domain aborts old chat and clears messages while an old stream finishing cannot change the new chat', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let oldSignal: AbortSignal | undefined
  let calls = 0
  const view = await setup(async (url, init) => {
    if (url === '/api/domain/analyze') return Response.json({ ...report, domain: JSON.parse(String(init!.body)).domain })
    calls++
    if (calls === 1) { oldSignal = init!.signal!; return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(sse('이전 도메인 답변'))) } })) }
    assert.doesNotMatch(String(init!.body), /이전 도메인 답변/)
    return answer('새 도메인 해설')
  })
  try {
    await view.submit('example.com')
    await view.submit('example.net')
    assert.equal(oldSignal!.aborted, true)
    assert.match(dom.document.querySelector('.domain-chat-context')!.textContent, /example.net/)
    await act(async () => { stream!.enqueue(new TextEncoder().encode(sse('과거 응답'))); stream!.close() }); await settle()
    assert.doesNotMatch(dom.document.querySelector('.domain-ai')!.textContent, /이전 도메인|과거 응답/)
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /새 도메인 해설/)
  } finally { await view.dispose() }
})

test('Korean composing Enter and Shift+Enter do not send, and rapid submission sends only once', async () => {
  let calls = 0
  const view = await setup(async (url) => {
    if (url === '/api/domain/analyze') return Response.json(report)
    calls++
    return answer('정상 답변')
  })
  try {
    await view.submit('example.com')
    const input = dom.document.querySelector('.domain-chat-composer textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '조합 중 질문')
      input.dispatchEvent(new dom.Event('input', { bubbles: true }))
      input.dispatchEvent(new dom.Event('change', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))
    })
    assert.equal(calls, 1)
    await act(async () => {
      const form = input.closest('form')!
      form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }))
    })
    await settle()
    assert.equal(calls, 2)
    assert.equal(dom.document.querySelectorAll('.domain-chat-message.user').length, 1)
  } finally { await view.dispose() }
})
