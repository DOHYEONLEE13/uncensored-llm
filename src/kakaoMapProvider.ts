import { formatCctvDistance } from './cctv'
import type { CctvMapProvider } from './mapProvider'

// Only the official SDK surface used by this adapter. No runtime dependency.
type LatLng = object
type Bounds = object
type MapView = {
  setBounds(bounds: Bounds, top: number, right: number, bottom: number, left: number): void
  setCenter(center: LatLng): void
  setLevel(level: number): void
  getLevel(): number
  setMaxLevel(level: number): void
  setDraggable(enabled: boolean): void
  setZoomable(enabled: boolean): void
  setKeyboardShortcuts(enabled: boolean): void
  relayout(): void
}
type Overlay = { setMap(map: MapView | null): void; setZIndex(index: number): void }
type Stroke = { strokeWeight: number; strokeColor: string; strokeOpacity: number; strokeStyle: 'solid' | 'dashed' }
type Line = Overlay & { setOptions(options: Partial<Stroke>): void }

export type KakaoMapsSdk = {
  load(callback: () => void): void
  LatLng: new (latitude: number, longitude: number) => LatLng
  Map: new (container: HTMLElement, options: { center: LatLng; level: number; keyboardShortcuts: boolean }) => MapView
  Circle: new (options: Stroke & { map: MapView; center: LatLng; radius: number; fillColor: string; fillOpacity: number }) => Overlay & { getBounds(): Bounds }
  Polyline: new (options: Stroke & { map: MapView; path: LatLng[] }) => Line
  CustomOverlay: new (options: { map: MapView; content: HTMLElement; position: LatLng; xAnchor: number; yAnchor: number; zIndex: number; clickable?: boolean }) => Overlay
  event: {
    addListener(target: object, type: string, listener: () => void): void
    removeListener(target: object, type: string, listener: () => void): void
  }
}

type KakaoWindow = Window & { kakao?: { maps?: KakaoMapsSdk } }
const readSdk = () => (window as KakaoWindow).kakao?.maps
const sdkError = () => new Error('카카오맵을 불러올 수 없습니다.')
const abortError = () => new DOMException('지도 요청이 취소되었습니다.', 'AbortError')

// Cache only the SDK's in-flight load, never map instances or user coordinates.
let pendingSdk: Promise<KakaoMapsSdk> | undefined

function getSdk(javascriptKey: string): Promise<KakaoMapsSdk> {
  const loaded = readSdk()
  if (loaded?.Map) return Promise.resolve(loaded)
  if (pendingSdk) return pendingSdk
  const pending = new Promise<KakaoMapsSdk>((resolve, reject) => {
    const script = document.createElement('script')
    const url = new URL('https://dapi.kakao.com/v2/maps/sdk.js')
    url.searchParams.set('appkey', javascriptKey)
    url.searchParams.set('autoload', 'false')
    script.src = url.href
    script.async = true
    script.referrerPolicy = 'origin'
    script.dataset.miraKakaoSdk = 'true'
    let finished = false
    const finish = (sdk?: KakaoMapsSdk) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      script.onload = null
      script.onerror = null
      if (sdk) resolve(sdk)
      else { script.remove(); reject(sdkError()) }
    }
    const timer = setTimeout(() => finish(), 12_000)
    script.onerror = () => finish()
    script.onload = () => {
      try {
        const sdk = readSdk()
        if (!sdk?.load) { finish(); return }
        sdk.load(() => finish(readSdk()?.Map ? readSdk() : undefined))
      } catch { finish() }
    }
    document.head.append(script)
  })
  pendingSdk = pending
  void pending.then(
    () => { pendingSdk = undefined },
    () => { pendingSdk = undefined },
  )
  return pending
}

export function loadKakaoMaps(javascriptKey: string, signal: AbortSignal): Promise<KakaoMapsSdk> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void getSdk(javascriptKey).then(
      (sdk) => { signal.removeEventListener('abort', onAbort); if (!signal.aborted) resolve(sdk) },
      () => { signal.removeEventListener('abort', onAbort); reject(sdkError()) },
    )
  })
}

export function createKakaoMapProvider(sdk: KakaoMapsSdk): CctvMapProvider {
  return {
    mount(container, { scene, signal, onSelect, onError }) {
      if (signal.aborted) throw abortError()
      let map: MapView | null = null
      let destroyed = false
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      const overlays: Overlay[] = []
      const cleanup: (() => void)[] = []
      const markers: { id: string; button: HTMLButtonElement; overlay: Overlay; line: Line }[] = []
      const safely = (action: () => void) => { try { action() } catch { /* No raw SDK diagnostics. */ } }
      const destroy = () => {
        if (destroyed) return
        destroyed = true
        clearTimeout(readyTimer)
        signal.removeEventListener('abort', destroy)
        cleanup.splice(0).forEach((remove) => safely(remove))
        overlays.splice(0).forEach((overlay) => safely(() => overlay.setMap(null)))
        markers.splice(0)
        // Kakao exposes no Map.destroy(); detach overlays/listeners, disable map
        // interaction and release its entire dedicated container and reference.
        const previousMap = map
        map = null
        if (previousMap) {
          safely(() => previousMap.setDraggable(false))
          safely(() => previousMap.setZoomable(false))
          safely(() => previousMap.setKeyboardShortcuts(false))
        }
        container.replaceChildren()
      }
      const fail = () => { if (!destroyed) { destroy(); onError() } }
      const addClick = (button: HTMLButtonElement, action: () => void) => {
        const handle = (event: MouseEvent) => {
          event.preventDefault()
          event.stopPropagation()
          if (!destroyed) { try { action() } catch { fail() } }
        }
        button.addEventListener('click', handle)
        cleanup.push(() => button.removeEventListener('click', handle))
      }
      try {
        const center = new sdk.LatLng(scene.center[1], scene.center[0])
        map = new sdk.Map(container, { center, level: 7, keyboardShortcuts: false })
        map.setZoomable(false)
        const circle = new sdk.Circle({
          map, center, radius: scene.radiusMeters,
          strokeWeight: 2, strokeColor: '#42796d', strokeOpacity: 0.85,
          strokeStyle: 'dashed', fillColor: '#c8f2e0', fillOpacity: 0.035,
        })
        overlays.push(circle)
        const user = document.createElement('div')
        user.className = 'cctv-map-user'
        user.setAttribute('aria-label', '현재 위치')
        const dot = document.createElement('span')
        dot.className = 'cctv-map-user-dot'
        dot.setAttribute('aria-hidden', 'true')
        const userLabel = document.createElement('span')
        userLabel.textContent = '내 위치'
        user.append(dot, userLabel)
        overlays.push(new sdk.CustomOverlay({ map, position: center, content: user, xAnchor: 0.5, yAnchor: 0.5, zIndex: 30 }))

        scene.cctvs.forEach((cctv, index) => {
          const position = new sdk.LatLng(cctv.latitude, cctv.longitude)
          const line = new sdk.Polyline({ map: map!, path: [center, position], strokeWeight: 1, strokeColor: '#42796d', strokeOpacity: 0.48, strokeStyle: 'solid' })
          overlays.push(line)
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'cctv-map-marker'
          button.textContent = String(index + 1)
          button.title = `${cctv.name} · 직선 ${formatCctvDistance(cctv.distanceMeters)}`
          button.setAttribute('aria-label', `${cctv.name}, 직선 ${formatCctvDistance(cctv.distanceMeters)}, CCTV 선택`)
          button.setAttribute('aria-pressed', 'false')
          addClick(button, () => onSelect(cctv.id))
          const overlay = new sdk.CustomOverlay({ map: map!, position, content: button, xAnchor: 0.5, yAnchor: 1, zIndex: 10, clickable: true })
          overlays.push(overlay)
          markers.push({ id: cctv.id, button, overlay, line })
        })

        let fittedLevel = 9
        const fitRadius = () => {
          if (!map || destroyed) return
          map.setMaxLevel(14)
          map.relayout()
          map.setBounds(circle.getBounds(), 24, 24, 24, 24)
          map.setCenter(center)
          fittedLevel = map.getLevel()
          map.setMaxLevel(fittedLevel)
        }
        const controls = document.createElement('div')
        controls.className = 'cctv-map-controls'
        for (const [label, text, action] of [
          ['지도 확대', '+', () => map?.setLevel(Math.max(1, map.getLevel() - 1))],
          ['지도 축소', '−', () => map?.setLevel(Math.min(fittedLevel, map.getLevel() + 1))],
          ['현재 위치와 반경 2km 보기', '2km', fitRadius],
        ] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.textContent = text
          button.setAttribute('aria-label', label)
          addClick(button, action)
          controls.append(button)
        }
        container.append(controls)
        const onTilesLoaded = () => clearTimeout(readyTimer)
        const mapInstance = map
        sdk.event.addListener(mapInstance, 'tilesloaded', onTilesLoaded)
        cleanup.push(() => sdk.event.removeListener(mapInstance, 'tilesloaded', onTilesLoaded))
        const onImageError = (event: Event) => {
          if ((event.target as HTMLElement | null)?.tagName === 'IMG') fail()
        }
        container.addEventListener('error', onImageError, true)
        cleanup.push(() => container.removeEventListener('error', onImageError, true))
        signal.addEventListener('abort', destroy, { once: true })
        readyTimer = setTimeout(fail, 12_000)
        fitRadius()
        let width = container.clientWidth
        let height = container.clientHeight
        return {
          setSelected(id) {
            if (destroyed) return
            markers.forEach((marker) => {
              const selected = marker.id === id
              marker.button.setAttribute('aria-pressed', String(selected))
              marker.overlay.setZIndex(selected ? 40 : 10)
              marker.line.setZIndex(selected ? 2 : 1)
              marker.line.setOptions({ strokeWeight: selected ? 2 : 1, strokeOpacity: selected ? 0.95 : 0.48, strokeColor: selected ? '#164f45' : '#42796d' })
            })
          },
          resize() {
            if (destroyed || !container.clientWidth || !container.clientHeight) return
            if (width === container.clientWidth && height === container.clientHeight) return
            width = container.clientWidth
            height = container.clientHeight
            fitRadius()
          },
          destroy,
        }
      } catch {
        destroy()
        throw sdkError()
      }
    },
  }
}

export async function loadKakaoMapProvider(javascriptKey: string, signal: AbortSignal): Promise<CctvMapProvider> {
  return createKakaoMapProvider(await loadKakaoMaps(javascriptKey, signal))
}
