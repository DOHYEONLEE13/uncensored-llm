import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import Hls from 'hls.js'
import CctvResults from '../src/CctvResults.tsx'
import CctvMap from '../src/CctvMap.tsx'
import CctvVideo from '../src/CctvVideo.tsx'
import type { NearbyCctv } from '../src/cctv.ts'
import type { CctvMapProvider, MapProviderLoader } from '../src/mapProvider.ts'

// Isolated DOM/SDK test doubles only. No test camera or location is shipped.
const dom = new Window({ url: 'https://mira.test', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } })
const descriptors = new Map<string, PropertyDescriptor | undefined>()
before(() => {
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
})
after(async () => {
  await dom.happyDOM.abort()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

const coordinates = { latitude: 37, longitude: 127 }
const camera: NearbyCctv = {
  id: 'ITS:one', provider: 'ITS', providerId: 'one', name: '첫 번째 CCTV',
  latitude: 37.001, longitude: 127, distanceMeters: 111,
  format: 'hls', streamUrl: 'https://example.test/one.m3u8', roadType: 'its',
}
const second = { ...camera, id: 'ITS:two', name: '두 번째 CCTV', latitude: 37.002, distanceMeters: 222, streamUrl: 'https://example.test/two.m3u8' }
const cameras = [second, camera]
const settle = async () => { await act(async () => { await new Promise((resolve) => setImmediate(resolve)) }) }
async function mount(element: ReturnType<typeof createElement>) {
  const host = dom.document.createElement('div')
  dom.document.body.append(host)
  const root = createRoot(host as unknown as HTMLElement)
  await act(async () => root.render(element))
  // Resolve the lazily imported map without loading any external SDK.
  for (let i = 0; i < 8 && !host.querySelector('.cctv-map-canvas'); i++) await settle()
  return { host, root, async dispose() { await act(async () => root.unmount()); host.remove() } }
}
async function click(element: { click(): void } | null) { assert.ok(element); await act(async () => element.click()); await settle() }

function providerDouble() {
  let options: Parameters<CctvMapProvider['mount']>[1]
  const selections: (string | null)[] = []
  let destroyed = 0
  const loadProvider: MapProviderLoader = async () => ({ mount(_container, nextOptions) {
    options = nextOptions
    return { setSelected: (id) => selections.push(id), resize() {}, destroy() { destroyed++ } }
  } })
  return { loadProvider, selections, select: (id: string) => options.onSelect(id), fail: () => options.onError(), get destroyed() { return destroyed } }
}

test('map/list share selection, marker selection opens the panel, and switching destroys HLS', async (t) => {
  const sdk = providerDouble()
  t.mock.method(Hls, 'isSupported', () => true)
  t.mock.method(Hls.prototype, 'loadSource', () => undefined)
  t.mock.method(Hls.prototype, 'attachMedia', () => undefined)
  const destroy = t.mock.method(Hls.prototype, 'destroy', () => undefined)
  const view = await mount(createElement(CctvResults, { cctvs: cameras, coordinates, loadMapProvider: sdk.loadProvider }))
  try {
    assert.deepEqual(Array.from(view.host.querySelectorAll('.cctv-list-name')).map((node) => node.firstChild?.textContent), [camera.name, second.name])
    await act(async () => sdk.select(camera.id))
    assert.equal(view.host.querySelector('[aria-label="선택한 CCTV"] h3')?.textContent, camera.name)
    assert.match(view.host.querySelector('.cctv-map-distance')?.textContent || '', /111m/)
    assert.equal(view.host.querySelector('.cctv-list-button')?.getAttribute('aria-pressed'), 'true')
    assert.equal(view.host.querySelector('video'), null)
    await click(view.host.querySelector('.cctv-selected-panel .cctv-action'))
    await settle()
    assert.equal(view.host.querySelector('video')?.getAttribute('aria-label'), `${camera.name} CCTV 영상`)
    await click(view.host.querySelectorAll('.cctv-list-button')[1])
    assert.equal(sdk.selections.at(-1), second.id)
    assert.equal(destroy.mock.callCount(), 1)
    assert.equal(view.host.querySelector('video'), null)
    await click(view.host.querySelector('.cctv-selected-panel .cctv-action'))
    await settle()
    await act(async () => sdk.select(camera.id))
    assert.equal(destroy.mock.callCount(), 2)
    await click(view.host.querySelector('.cctv-close'))
    assert.equal(sdk.selections.at(-1), null)
    assert.equal(view.host.querySelector('[aria-label="선택한 CCTV"]'), null)
    assert.equal(view.host.innerHTML.includes('37.001'), false)
  } finally { await view.dispose() }
  assert.equal(sdk.destroyed, 1)
})

test('SDK load and runtime failures leave the CCTV list usable and allow a map-only retry', async () => {
  let attempts = 0
  const sdk = providerDouble()
  const loader: MapProviderLoader = async (signal) => {
    attempts++
    if (attempts === 1) throw new Error('private SDK diagnostic')
    return sdk.loadProvider(signal)
  }
  const view = await mount(createElement(CctvResults, { cctvs: cameras, coordinates, loadMapProvider: loader }))
  try {
    assert.match(view.host.textContent, /지도를 불러올 수 없습니다/)
    assert.equal(view.host.textContent.includes('private SDK diagnostic'), false)
    await click(view.host.querySelector('.cctv-list-button'))
    assert.ok(view.host.querySelector('.cctv-selected-panel'))
    await click(view.host.querySelector('[aria-label="CCTV 지도 다시 불러오기"]'))
    assert.equal(attempts, 2)
    assert.equal(sdk.selections.at(-1), camera.id)
    await act(async () => sdk.fail())
    assert.equal(sdk.destroyed, 1)
    assert.equal(view.host.querySelectorAll('.cctv-list-button').length, 2)
  } finally { await view.dispose() }
})

test('late map mounts are destroyed after unmount; expired positions never load a SDK', async () => {
  let resolveMount!: (value: { setSelected(): void; resize(): void; destroy(): void }) => void
  let destroyed = 0
  const loadProvider: MapProviderLoader = async () => ({ mount: () => new Promise((resolve) => { resolveMount = resolve }) })
  const view = await mount(createElement(CctvMap, { cctvs: cameras, coordinates, selectedId: null, onSelect() {}, loadProvider }))
  assert.match(view.host.textContent, /지도를 불러오는 중/)
  await view.dispose()
  await act(async () => resolveMount({ setSelected() {}, resize() {}, destroy() { destroyed++ } }))
  assert.equal(destroyed, 1)
  let loads = 0
  const expired = await mount(createElement(CctvResults, { cctvs: cameras, loadMapProvider: async (signal) => { loads++; return loadProvider(signal) } }))
  try {
    assert.equal(loads, 0)
    assert.match(expired.host.textContent, /이전 조회의 위치는 보관하지 않습니다/)
    assert.equal(expired.host.querySelectorAll('.cctv-list-button').length, 2)
  } finally { await expired.dispose() }
})

test('missing provider and empty results have distinct safe states', async () => {
  const view = await mount(createElement(CctvResults, { cctvs: [], coordinates }))
  try {
    assert.match(view.host.textContent, /지도 서비스가 아직 연결되지 않았습니다/)
    assert.match(view.host.textContent, /반경 2km 안에서 제공 중인 ITS 도로 CCTV를 찾지 못했습니다/)
    assert.equal(view.host.querySelector('script'), null)
  } finally { await view.dispose() }
})

test('native HLS remains available and HTTPS blocks HTTP video and images gracefully', async (t) => {
  const canPlay = t.mock.method(dom.HTMLVideoElement.prototype, 'canPlayType', () => 'probably')
  const view = await mount(createElement(CctvVideo, { cctv: camera }))
  try {
    assert.equal(canPlay.mock.callCount(), 1)
    assert.equal(view.host.querySelector('video')?.getAttribute('src'), camera.streamUrl)
  } finally { await view.dispose() }
  for (const format of ['hls', 'image'] as const) {
    const blocked = await mount(createElement(CctvVideo, { cctv: { ...camera, format, streamUrl: 'http://example.test/live' } }))
    try {
      assert.match(blocked.host.textContent, /현재 CCTV 영상을 불러올 수 없습니다\./)
      assert.equal(blocked.host.querySelector('[src]'), null)
    } finally { await blocked.dispose() }
  }
})
