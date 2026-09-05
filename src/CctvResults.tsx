import { Component, lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react'
import { MapPin, Radio, Video, X } from 'lucide-react'
import { formatCctvDistance, formatCctvRoadType, selectNearbyCctvs, type Coordinates, type NearbyCctv } from './cctv'
import CctvVideo from './CctvVideo'
import type { MapProviderLoader } from './mapProvider'

const CctvMap = lazy(() => import('./CctvMap'))

class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { /* Do not log SDK diagnostics or coordinates. */ }
  render() {
    return this.state.failed
      ? <div className="cctv-map-frame cctv-map-status" role="status">지도를 불러올 수 없습니다. 아래 목록에서 CCTV를 선택해 주세요.</div>
      : this.props.children
  }
}

type CctvResultsProps = {
  cctvs: NearbyCctv[]
  coordinates?: Coordinates
  loadMapProvider?: MapProviderLoader
}

function SelectedCctv({ cctv, onClose }: { cctv: NearbyCctv; onClose(): void }) {
  const [playing, setPlaying] = useState(false)
  const videoId = useId()
  return (
    <div className="cctv-selected-panel" aria-label="선택한 CCTV">
      <div className="cctv-selected-heading">
        <span className="cctv-provider">{cctv.provider}</span>
        <div className="min-w-0 flex-1" aria-live="polite">
          <h3>{cctv.name}</h3>
          <p>직선 {formatCctvDistance(cctv.distanceMeters)} · {formatCctvRoadType(cctv.roadType)}</p>
        </div>
        <button type="button" className="cctv-close" aria-label="CCTV 선택 닫기" onClick={onClose}><X className="size-4" aria-hidden="true" /></button>
      </div>
      <button type="button" className="cctv-action" aria-label={`${cctv.name} 영상 ${playing ? '닫기' : '보기'}`} aria-expanded={playing} aria-controls={videoId} onClick={() => setPlaying((value) => !value)}>
        <Video className="size-4" aria-hidden="true" /> 영상 {playing ? '닫기' : '보기'}
      </button>
      <div id={videoId}>{playing && <CctvVideo cctv={cctv} />}</div>
    </div>
  )
}

export function CctvResults({ cctvs, coordinates, loadMapProvider }: CctvResultsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const nearby = useMemo(() => selectNearbyCctvs(cctvs, coordinates), [cctvs, coordinates])
  const selected = nearby.find((cctv) => cctv.id === selectedId)
  const panelId = useId()

  return (
    <section className="cctv-results" aria-label="주변 도로 CCTV">
      <div className="cctv-results-heading">
        <Radio className="size-4 shrink-0" aria-hidden="true" />
        <span>반경 2km · CCTV {nearby.length}곳</span>
        <span className="cctv-provider">ITS</span>
      </div>
      <MapBoundary>
        <Suspense fallback={<div className="cctv-map-frame cctv-map-status" role="status">지도를 불러오는 중…</div>}>
          <CctvMap coordinates={coordinates} cctvs={nearby} selectedId={selected?.id ?? null} onSelect={setSelectedId} loadProvider={loadMapProvider} />
        </Suspense>
      </MapBoundary>
      <div id={panelId}>
        {selected && <SelectedCctv key={selected.id} cctv={selected} onClose={() => setSelectedId(null)} />}
      </div>
      {nearby.length === 0 ? (
        <p className="cctv-empty" role="status">현재 위치 반경 2km 안에서 제공 중인 ITS 도로 CCTV를 찾지 못했습니다.</p>
      ) : (
        <>
          <p className="cctv-list-caption">가까운 순 · 조회 당시 위치 기준 직선거리</p>
          <ul className="cctv-list" aria-label="거리순 CCTV 목록">
            {nearby.map((cctv) => (
              <li key={cctv.id}>
                <button type="button" className="cctv-list-button" aria-label={`${cctv.name}, 직선 ${formatCctvDistance(cctv.distanceMeters)}, 선택`} aria-pressed={selected?.id === cctv.id} aria-controls={panelId} onClick={() => setSelectedId(cctv.id)}>
                  <MapPin className="size-4 shrink-0" aria-hidden="true" />
                  <span className="cctv-list-name">{cctv.name}<span>{formatCctvRoadType(cctv.roadType)}</span></span>
                  <span className="cctv-list-distance">{formatCctvDistance(cctv.distanceMeters)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export default CctvResults
