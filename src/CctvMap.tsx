import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, MapPin, MapPinned } from 'lucide-react'
import { formatCctvDistance, type Coordinates, type NearbyCctv } from './cctv'
import { createCctvMapScene, loadMapProvider, MapProviderError, type CctvMapInstance, type MapProviderLoader } from './mapProvider'

type MapStatus = 'loading' | 'ready' | 'not_configured' | 'not_connected' | 'error'
type Props = {
  coordinates?: Coordinates
  cctvs: NearbyCctv[]
  selectedId: string | null
  onSelect(id: string): void
  loadProvider?: MapProviderLoader
}

export default function CctvMap({ coordinates, cctvs, selectedId, onSelect, loadProvider = loadMapProvider }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<CctvMapInstance | null>(null)
  const onSelectRef = useRef(onSelect)
  const selectedRef = useRef(selectedId)
  const failRef = useRef<() => void>(() => undefined)
  const [status, setStatus] = useState<MapStatus>('loading')
  const [attempt, setAttempt] = useState(0)
  onSelectRef.current = onSelect
  selectedRef.current = selectedId
  const scene = useMemo(() => coordinates ? createCctvMapScene(coordinates, cctvs) : null, [coordinates, cctvs])
  const selected = cctvs.find((cctv) => cctv.id === selectedId)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !scene) return
    // Isolate attempts so a late SDK mount cannot tear down a newer map.
    const surface = document.createElement('div')
    surface.className = 'cctv-map-canvas'
    container.append(surface)
    let cancelled = false
    let observer: ResizeObserver | undefined
    const controller = new AbortController()
    const dispose = () => {
      observer?.disconnect()
      const instance = instanceRef.current
      instanceRef.current = null
      try { instance?.destroy() } catch { /* A failed SDK must not break chat. */ }
      surface.remove()
    }
    const fail = (next: MapStatus = 'error') => {
      if (cancelled) return
      cancelled = true
      controller.abort()
      clearTimeout(timeout)
      dispose()
      setStatus(next)
    }
    const timeout = setTimeout(() => fail(), 15_000)
    failRef.current = () => fail()
    setStatus('loading')
    void (async () => {
      try {
        const provider = await loadProvider(controller.signal)
        if (cancelled) return
        const instance = await provider.mount(surface, {
          scene,
          signal: controller.signal,
          reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
          onSelect: (id) => {
            if (!cancelled && scene.cctvs.some((cctv) => cctv.id === id)) onSelectRef.current(id)
          },
          onError: () => fail(),
        })
        if (cancelled) {
          try { instance.destroy() } catch { /* Already detached. */ }
          return
        }
        instanceRef.current = instance
        instance.setSelected(selectedRef.current)
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            try { instance.resize() } catch { fail() }
          })
          observer.observe(container)
        }
        clearTimeout(timeout)
        setStatus('ready')
      } catch (error) {
        fail(error instanceof MapProviderError ? error.code : 'error')
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timeout)
      controller.abort()
      dispose()
      failRef.current = () => undefined
    }
  }, [scene, loadProvider, attempt])

  useEffect(() => {
    try { instanceRef.current?.setSelected(selectedId) } catch { failRef.current() }
  }, [selectedId])

  const ready = Boolean(coordinates) && status === 'ready'
  const loading = Boolean(coordinates) && status === 'loading'
  const message = !coordinates
    ? '이전 조회의 위치는 보관하지 않습니다. 주변 CCTV를 다시 요청해 주세요.'
    : status === 'not_configured' || status === 'not_connected'
      ? '지도 서비스가 아직 연결되지 않았습니다. 아래 목록에서 CCTV를 선택할 수 있습니다.'
      : '지도를 불러올 수 없습니다. 아래 목록에서 CCTV를 선택할 수 있습니다.'

  return (
    <div className="cctv-map-frame" aria-label="현재 위치 반경 2km CCTV 지도" aria-busy={loading}>
      <div ref={containerRef} className="cctv-map-canvas" style={{ visibility: ready ? 'visible' : 'hidden' }} aria-hidden={!ready} />
      {!ready && (
        <div className="cctv-map-status" role="status">
          {loading
            ? <LoaderCircle className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <MapPinned className="size-7" aria-hidden="true" />}
          <p>{loading ? '지도를 불러오는 중…' : message}</p>
          {coordinates && status === 'error' && (
            <button type="button" className="cctv-action" aria-label="CCTV 지도 다시 불러오기" onClick={() => setAttempt((value) => value + 1)}>
              지도 다시 시도
            </button>
          )}
        </div>
      )}
      {ready && (
        <>
          <div className="cctv-map-legend"><MapPin className="size-3.5" aria-hidden="true" /> 내 위치 · 반경 2km</div>
          {selected && <div className="cctv-map-distance" role="status">{selected.name} · 직선 {formatCctvDistance(selected.distanceMeters)}</div>}
        </>
      )}
    </div>
  )
}
