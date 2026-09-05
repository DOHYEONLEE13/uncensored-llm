import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'

const dom = new Window({ url: 'https://mira.test', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } })
dom.document.write('<!doctype html><html><head></head><body></body></html>')
// These tests cover application state, not happy-dom's incomplete WAAPI.
Reflect.deleteProperty(dom.Element.prototype, 'animate')
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, SVGElement: dom.SVGElement, Element: dom.Element,
  Node: dom.Node, ResizeObserver: dom.ResizeObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
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

const coordinates = { latitude: 37.123456, longitude: 127.123456 }
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }

async function setup(
  getPosition: (success: PositionCallback, failure: PositionErrorCallback) => void,
  nearbyFailure?: () => Response,
  searchText?: string,
) {
  dom.localStorage.clear()
  const originalFetch = globalThis.fetch
  const requests: { url: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/status') return Response.json({ configured: true, model: 'obsidian/Qwen3.8-27B' })
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url === '/api/cctv/nearby' && nearbyFailure) return nearbyFailure()
    if (url === '/api/cctv/search') return Response.json({ query: '올림픽대로', total: 1, cctvs: [{
      id: 'ITS:road', provider: 'ITS', name: '[올림픽대로] 청담',
      latitude: 37, longitude: 127, streamUrl: 'https://example.test/live.m3u8', format: 'hls',
    }] })
    if (url === '/api/cctv/nearby') return Response.json({ cctvs: [{
      id: 'ITS:test', provider: 'ITS', name: '테스트 도로', providerId: 'test',
      latitude: 37.124, longitude: 127.124, distanceMeters: 78,
      streamUrl: 'https://example.test/live.m3u8', format: 'hls',
    }] })
    throw new Error('Unexpected request in isolated CCTV test')
  }
  let locationReads = 0
  Object.defineProperty(dom.navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(success: PositionCallback, failure: PositionErrorCallback) { locationReads++; getPosition(success, failure) },
  } })
  const host = dom.document.createElement('div')
  dom.document.body.append(host)
  const root = createRoot(host as unknown as HTMLElement)
  await act(async () => root.render(createElement(App)))
  await act(async () => host.querySelector('textarea')!.focus())
  await settle()
  async function click(label: string) {
    const button = host.querySelector(`button[aria-label="${label}"]`)
    assert.ok(button, label)
    await act(async () => button.click())
    await settle()
  }
  if (searchText) {
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, searchText)
      textarea.dispatchEvent(new dom.Event('input', { bubbles: true }))
      textarea.dispatchEvent(new dom.Event('change', { bubbles: true }))
    })
    await act(async () => textarea.closest('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })))
    await settle()
  } else {
    await click('채팅 도구 열기')
    await click('현재 위치에서 가까운 ITS 도로 CCTV 찾기')
  }
  for (let i = 0; i < 10 && !host.querySelector('.cctv-results') && requests.length; i++) await settle()
  return {
    host, requests, click, get locationReads() { return locationReads },
    async dispose() { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch },
  }
}

test('CCTV button reads GPS once, posts 2km/20, and never saves GPS or CCTV data in history', async () => {
  const view = await setup((success) => success({ coords: coordinates } as GeolocationPosition))
  try {
    assert.equal(view.locationReads, 1)
    assert.deepEqual(view.requests, [{ url: '/api/cctv/nearby', body: { ...coordinates, radiusKm: 2, limit: 20 } }])
    assert.ok(view.host.querySelector('.cctv-results'))
    const history = dom.localStorage.getItem('mira-conversations') || ''
    assert.match(history, /내 주변 CCTV 보여줘/)
    assert.doesNotMatch(history, /37\.123456|127\.123456|latitude|longitude|coordinates|streamUrl|distanceMeters|cctvs/)
    await view.click('채팅 닫기')
    await act(async () => {
      view.host.querySelector('textarea')!.blur()
      view.host.querySelector('textarea')!.focus()
    })
    for (let i = 0; i < 20 && !view.host.querySelector('.cctv-results'); i++) await settle()
    assert.match(view.host.textContent, /이전 조회의 위치는 보관하지 않습니다/)
    assert.equal(view.locationReads, 1)
  } finally { await view.dispose() }
})

test('named road chat searches only that road without asking for GPS or calling AI chat', async () => {
  const view = await setup(() => { throw new Error('Named road searches must not ask for location') }, undefined, '올림픽대로 CCTV 열어줘')
  try {
    assert.equal(view.locationReads, 0)
    assert.deepEqual(view.requests, [{ url: '/api/cctv/search', body: { query: '올림픽대로', limit: 20 } }])
    assert.match(view.host.textContent, /올림픽대로.*일치하는 ITS CCTV 1곳/)
    assert.equal(view.host.querySelectorAll('.cctv-list-button').length, 1)
    assert.equal(view.host.querySelector('.cctv-map-frame'), null)
    assert.doesNotMatch(dom.localStorage.getItem('mira-conversations') || '', /latitude|longitude|streamUrl|cctvs|cctvSearch/)
  } finally { await view.dispose() }
})

test('location denial keeps chat usable and never calls nearby API', async () => {
  const view = await setup((_success, failure) => failure({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 } as GeolocationPositionError))
  try {
    assert.equal(view.locationReads, 1)
    assert.deepEqual(view.requests, [])
    assert.match(view.host.textContent, /위치 권한이 필요합니다/)
    assert.equal(view.host.querySelector('textarea')?.disabled, false)
    assert.equal(view.host.querySelector('.cctv-results'), null)
  } finally { await view.dispose() }
})

test('an ITS configuration failure explains the cause and keeps diagnostics out of chat history', async () => {
  const view = await setup(
    (success) => success({ coords: coordinates } as GeolocationPosition),
    () => Response.json({ error: {
      code: 'configuration_error',
      message: 'ITS_API_KEY=private-value GPS=37.123456,127.123456',
    } }, { status: 503 }),
  )
  try {
    assert.match(view.host.textContent, /CCTV 서비스 인증 설정이 누락되어 있습니다/)
    assert.equal(view.host.querySelector('textarea')?.disabled, false)
    assert.equal(view.host.querySelector('.cctv-results'), null)
    const history = dom.localStorage.getItem('mira-conversations') || ''
    assert.match(history, /CCTV 서비스 인증 설정이 누락/)
    assert.doesNotMatch(history, /private-value|37\.123456|127\.123456|ITS_API_KEY|GPS/)
  } finally { await view.dispose() }
})

test('closing chat during geolocation discards the late position without sending or restoring it', async () => {
  let finish!: PositionCallback
  const view = await setup((success) => { finish = success })
  try {
    await view.click('채팅 닫기')
    await act(async () => finish({ coords: coordinates } as GeolocationPosition))
    assert.deepEqual(view.requests, [])
    assert.equal(view.host.querySelector('.cctv-results'), null)
    assert.doesNotMatch(dom.localStorage.getItem('mira-conversations') || '', /37\.123456|127\.123456/)
  } finally { await view.dispose() }
})
