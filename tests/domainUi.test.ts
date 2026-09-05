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
  await click('도메인 분석 열기')
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
    assert.match(dom.document.querySelector('.domain-ai')!.textContent, /해설하고 있습니다/)
    const graph = Array.from(dom.document.querySelectorAll('.domain-tabs button')).find((button) => button.textContent === '연결 지도')!
    await act(async () => graph.click())
    await act(async () => dom.document.querySelector<HTMLButtonElement>('.domain-graph-node')!.click())
    assert.match(dom.document.querySelector('.domain-selected')!.textContent, /<script>do not execute<\/script>/)
    assert.equal(dom.document.querySelector('.domain-selected script'), null)
    assert.equal(dom.localStorage.getItem('mira-conversations')?.includes('example.com') ?? false, false)
    await click('도메인 분석 닫기')
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
    assert.match(dom.document.querySelector('.domain-ai .domain-error')!.textContent, /AI 해설/)
    const retry = Array.from(dom.document.querySelectorAll('.domain-ai button')).find((button) => button.textContent === 'AI 해설 다시 요청')!
    await act(async () => retry.click()); await settle()
    assert.equal(aiCalls, 2)
    assert.match(dom.document.querySelector('.domain-explanation')!.textContent, /공개 인증서 기록/)
    assert.equal(dom.document.querySelector('.domain-ai .domain-error'), null)
  } finally { await view.dispose() }
})
