import { Component, lazy, Suspense, useId, useMemo, useState, type ReactNode } from 'react'
import { MapPin, Radio, Video, X } from 'lucide-react'
import { formatCctvDistance, formatCctvRoadType, selectNearbyCctvs, type Coordinates, type NearbyCctv, type CctvCamera } from './cctv'
import CctvVideoDialog from './CctvVideoDialog'
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
  cctvs: CctvCamera[]
  search?: { query: string; total: number }
  coordinates?: Coordinates
  loadMapProvider?: MapProviderLoader
}

function SelectedCctv({ cctv, onClose }: { cctv: CctvCamera; onClose(): void }) {
  const [playing, setPlaying] = useState(false)
  return (
    <div className="cctv-selected-panel" aria-label="선택한 CCTV">
      <div className="cctv-selected-heading">
        <span className="cctv-provider">{cctv.provider}</span>
        <div className="min-w-0 flex-1" aria-live="polite">
          <h3>{cctv.name}</h3>
          <p>{cctv.distanceMeters !== undefined && `직선 ${formatCctvDistance(cctv.distanceMeters)} · `}{formatCctvRoadType(cctv.roadType)}</p>
        </div>
        <button type="button" className="cctv-close" aria-label="CCTV 선택 닫기" onClick={onClose}><X className="size-4" aria-hidden="true" /></button>
      </div>
      <button type="button" className="cctv-action" aria-label={`${cctv.name} CCTV 접근`} aria-haspopup="dialog" onClick={() => setPlaying(true)}>
        <Video className="size-4" aria-hidden="true" /> CCTV 접근
      </button>
      {playing && <CctvVideoDialog cctv={cctv} onClose={() => setPlaying(false)} />}
    </div>
  )
}

export function CctvResults({ cctvs, coordinates, search, loadMapProvider }: CctvResultsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const nearby = useMemo(() => selectNearbyCctvs(cctvs.filter((camera): camera is NearbyCctv => camera.distanceMeters !== undefined), coordinates), [cctvs, coordinates])
  const cameras = search ? cctvs : nearby
  const selected = cameras.find((cctv) => cctv.id === selectedId)
  const panelId = useId()

  return (
    <section className="cctv-results" aria-label={search ? `${search.query} CCTV 검색 결과` : '주변 도로 CCTV'}>
      <div className="cctv-results-heading">
        <Radio className="size-4 shrink-0" aria-hidden="true" />
        <span>{search ? `“${search.query}” · CCTV ${search.total}곳` : `반경 2km · CCTV ${nearby.length}곳`}</span>
        <span className="cctv-provider">ITS</span>
      </div>
      {!search && <MapBoundary>
        <Suspense fallback={<div className="cctv-map-frame cctv-map-status" role="status">지도를 불러오는 중…</div>}>
          <CctvMap coordinates={coordinates} cctvs={nearby} selectedId={selected?.id ?? null} onSelect={setSelectedId} loadProvider={loadMapProvider} />
        </Suspense>
      </MapBoundary>}
      <div id={panelId}>
        {selected && <SelectedCctv key={selected.id} cctv={selected} onClose={() => setSelectedId(null)} />}
      </div>
      {cameras.length === 0 ? (
        <p className="cctv-empty" role="status">{search ? '일치하는 도로명이나 CCTV 이름이 없습니다. ITS에서 제공하는 이름으로 다시 검색해 주세요.' : '현재 위치 반경 2km 안에서 제공 중인 ITS 도로 CCTV를 찾지 못했습니다.'}</p>
      ) : (
        <>
          <p className="cctv-list-caption">{search ? `도로명·CCTV 이름 일치 결과${search.total > cameras.length ? ` · ${cameras.length}곳 표시, 더 구체적인 이름으로 좁힐 수 있습니다` : ''}` : '가까운 순 · 조회 당시 위치 기준 직선거리'}</p>
          <ul className="cctv-list" aria-label={search ? '도로명 CCTV 검색 목록' : '거리순 CCTV 목록'}>
            {cameras.map((cctv) => (
              <li key={cctv.id}>
                <button type="button" className="cctv-list-button" aria-label={`${cctv.name}${cctv.distanceMeters !== undefined ? `, 직선 ${formatCctvDistance(cctv.distanceMeters)}` : ''}, 선택`} aria-pressed={selected?.id === cctv.id} aria-controls={panelId} onClick={() => setSelectedId(cctv.id)}>
                  <MapPin className="size-4 shrink-0" aria-hidden="true" />
                  <span className="cctv-list-name">{cctv.name}<span>{formatCctvRoadType(cctv.roadType)}</span></span>
                  {cctv.distanceMeters !== undefined && <span className="cctv-list-distance">{formatCctvDistance(cctv.distanceMeters)}</span>}
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
