import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Window } from 'happy-dom'
import { createKakaoMapProvider, loadKakaoMaps, type KakaoMapsSdk } from '../src/kakaoMapProvider.ts'
import { createCctvMapScene } from '../src/mapProvider.ts'

const dom = new Window({ url: 'https://mira.test', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } })
const descriptors = new Map(['window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom })
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.document })
after(async () => {
  await dom.happyDOM.abort()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

function sdkDouble() {
  const overlays: { options: Record<string, any>; setMap: (map: unknown) => void; zIndex: number }[] = []
  const listeners = new Map<string, () => void>()
  const views: { options: Record<string, any>; level: number; maxLevel: number; center: unknown; fits: number }[] = []
  class Overlay {
    zIndex = 0
    constructor(public options: Record<string, any>) {
      overlays.push(this)
      if (options.content) options.map.container.append(options.content)
    }
    setMap(map: unknown) { this.options.map = map; if (!map) this.options.content?.remove() }
    setZIndex(index: number) { this.zIndex = index }
    setOptions(options: object) { Object.assign(this.options, options) }
    getBounds() { return { radius: this.options.radius, center: this.options.center } }
  }
  const sdk = {
    load(callback: () => void) { callback() },
    LatLng: class { constructor(public latitude: number, public longitude: number) {} },
    Map: class {
      level = 7
      maxLevel = 14
      center: unknown
      fits = 0
      constructor(public container: HTMLElement, public options: Record<string, any>) { views.push(this); this.center = options.center }
      setBounds() { this.fits++; this.level = 8; listeners.get('tilesloaded')?.() }
      setCenter(center: unknown) { this.center = center }
      getLevel() { return this.level }
      setLevel(level: number) { this.level = level }
      setMaxLevel(level: number) { this.maxLevel = level }
      setDraggable() {}
      setZoomable() {}
      setKeyboardShortcuts() {}
      relayout() {}
    },
    Circle: Overlay,
    CustomOverlay: Overlay,
    Polyline: Overlay,
    event: {
      addListener(_target: object, event: string, listener: () => void) { listeners.set(event, listener) },
      removeListener(_target: object, event: string) { listeners.delete(event) },
    },
  } as unknown as KakaoMapsSdk
  return { sdk, overlays, views, listeners }
}

const scene = createCctvMapScene({ latitude: 37, longitude: 127 }, [
  { id: 'ITS:one', provider: 'ITS', providerId: 'one', name: '<script>unsafe label</script>', latitude: 37.001, longitude: 127, distanceMeters: 111, format: 'hls', streamUrl: 'https://example.test/one.m3u8' },
  { id: 'ITS:two', provider: 'ITS', providerId: 'two', name: '다음 CCTV', latitude: 37.002, longitude: 127, distanceMeters: 222, format: 'hls', streamUrl: 'https://example.test/two.m3u8' },
])

test('Kakao renders a dashed 2000m circle, distinct user marker, direct lines and synchronized markers', async () => {
  const { sdk, overlays, views, listeners } = sdkDouble()
  const host = dom.document.createElement('div')
  dom.document.body.append(host)
  const controller = new AbortController()
  const selections: string[] = []
  const map = await createKakaoMapProvider(sdk).mount(host as unknown as HTMLElement, {
    scene, signal: controller.signal, reducedMotion: true, onSelect: (id) => selections.push(id), onError() { assert.fail('Unexpected map failure') },
  })
  try {
    const circle = overlays.find((overlay) => overlay.options.radius)
    assert.equal(circle?.options.radius, 2_000)
    assert.equal(circle?.options.strokeStyle, 'dashed')
    assert.ok(circle!.options.fillOpacity < 0.05)
    assert.deepEqual(views[0].center, circle?.options.center)
    assert.equal(views[0].maxLevel, views[0].level)
    assert.equal(host.querySelectorAll('.cctv-map-user').length, 1)
    const buttons = host.querySelectorAll('.cctv-map-marker')
    assert.equal(buttons.length, 2)
    assert.equal(host.querySelector('script'), null)
    assert.match(buttons[0].getAttribute('aria-label') || '', /111m/)
    buttons[0].click()
    assert.deepEqual(selections, ['ITS:one'])
    map.setSelected('ITS:two')
    assert.equal(buttons[0].getAttribute('aria-pressed'), 'false')
    assert.equal(buttons[1].getAttribute('aria-pressed'), 'true')
    const lines = overlays.filter((overlay) => overlay.options.path)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].options.path.length, 2)
    assert.deepEqual(lines[0].options.path[0], circle?.options.center)
    assert.equal(lines[0].options.strokeWeight, 1)
    assert.equal(lines[1].options.strokeWeight, 2)
    host.querySelector('[aria-label="지도 확대"]')!.click()
    assert.equal(views[0].level, 7)
    host.querySelector('[aria-label="현재 위치와 반경 2km 보기"]')!.click()
    assert.equal(views[0].level, 8)
    assert.equal(host.textContent.includes('37.001'), false)
    assert.equal(host.textContent.includes('127'), false)
    controller.abort()
    buttons[1].click()
    assert.deepEqual(selections, ['ITS:one'])
    assert.ok(overlays.every((overlay) => overlay.options.map === null))
    assert.equal(listeners.size, 0)
    assert.equal(host.childElementCount, 0)
  } finally { map.destroy(); host.remove() }
})

test('Kakao tile failure cleans up the view and calls the recoverable error callback once', async () => {
  const { sdk, overlays } = sdkDouble()
  const host = dom.document.createElement('div')
  let errors = 0
  const map = await createKakaoMapProvider(sdk).mount(host as unknown as HTMLElement, { scene, signal: new AbortController().signal, reducedMotion: false, onSelect() {}, onError() { errors++ } })
  const tile = dom.document.createElement('img')
  host.append(tile)
  tile.dispatchEvent(new dom.Event('error'))
  assert.equal(errors, 1)
  assert.ok(overlays.every((overlay) => overlay.options.map === null))
  map.destroy()
  assert.equal(errors, 1)
})

test('Kakao SDK loading is lazy, deduplicated, abortable and retries a failed script', async (t) => {
  // Keep the loader's real DOM/script events, but let this test control the
  // network outcome instead of happy-dom auto-failing disabled script loads.
  const append = dom.document.head.append.bind(dom.document.head)
  t.mock.method(dom.document.head, 'append', (...nodes: any[]) => {
    for (const node of nodes) if (node.tagName === 'SCRIPT') node.type = 'application/x-mira-test'
    append(...nodes)
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loadKakaoMaps('test-public-key', controller.signal), { name: 'AbortError' })
  assert.equal(dom.document.querySelectorAll('script').length, 0)
  const first = loadKakaoMaps('test-public-key', new AbortController().signal)
  const failedScript = dom.document.querySelector('script')!
  const firstFailure = assert.rejects(first, /카카오맵을 불러올 수 없습니다/)
  failedScript.dispatchEvent(new dom.Event('error'))
  await firstFailure
  assert.equal(dom.document.querySelectorAll('script').length, 0)
  const abortedController = new AbortController()
  const aborted = loadKakaoMaps('test-public-key', abortedController.signal)
  const success = loadKakaoMaps('test-public-key', new AbortController().signal)
  const abortCheck = assert.rejects(aborted, { name: 'AbortError' })
  assert.equal(dom.document.querySelectorAll('script').length, 1)
  const script = dom.document.querySelector('script')!
  const url = new URL(script.src)
  assert.equal(url.origin, 'https://dapi.kakao.com')
  assert.equal(url.searchParams.get('autoload'), 'false')
  assert.equal(url.searchParams.has('latitude'), false)
  assert.equal(script.referrerPolicy, 'origin')
  abortedController.abort()
  await abortCheck
  const { sdk } = sdkDouble()
  Object.defineProperty(dom, 'kakao', { configurable: true, value: { maps: sdk } })
  script.dispatchEvent(new dom.Event('load'))
  assert.equal(await success, sdk)
  assert.equal(await loadKakaoMaps('test-public-key', new AbortController().signal), sdk)
  assert.equal(dom.document.querySelectorAll('script').length, 1)
})
