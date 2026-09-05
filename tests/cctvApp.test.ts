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

async function setup(getPosition: (success: PositionCallback, failure: PositionErrorCallback) => void) {
  dom.localStorage.clear()
  const originalFetch = globalThis.fetch
  const requests: { url: string; body: unknown }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/status') return Response.json({ configured: true, model: 'obsidian/Qwen3.8-27B' })
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
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
  await click('채팅 도구 열기')
  await click('현재 위치에서 가까운 ITS 도로 CCTV 찾기')
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
