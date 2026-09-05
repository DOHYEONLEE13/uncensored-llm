import { CCTV_RADIUS_METERS, selectNearbyCctvs, type Coordinates, type NearbyCctv } from './cctv'

/** GeoJSON order: longitude, latitude. Never serialize this scene into history. */
type Position = [number, number]
type LineString = { type: 'LineString'; coordinates: Position[] }

export type CctvMapScene = {
  center: Position
  radiusMeters: number
  boundary: LineString
  cctvs: NearbyCctv[]
  connections: { id: string; geometry: LineString; distanceMeters: number }[]
}

export function createCctvMapScene(coordinates: Coordinates, cctvs: NearbyCctv[]): CctvMapScene {
  const center: Position = [coordinates.longitude, coordinates.latitude]
  const latitude = coordinates.latitude * Math.PI / 180
  const longitude = coordinates.longitude * Math.PI / 180
  const angle = CCTV_RADIUS_METERS / 6_371_000
  const ring: Position[] = Array.from({ length: 128 }, (_, index) => {
    const bearing = index * 2 * Math.PI / 128
    const lat = Math.asin(Math.sin(latitude) * Math.cos(angle) +
      Math.cos(latitude) * Math.sin(angle) * Math.cos(bearing))
    const lng = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude),
      Math.cos(angle) - Math.sin(latitude) * Math.sin(lat),
    )
    return [((lng * 180 / Math.PI + 540) % 360) - 180, lat * 180 / Math.PI]
  })
  ring.push([...ring[0]])
  const nearby = selectNearbyCctvs(cctvs, coordinates)
  return {
    center,
    radiusMeters: CCTV_RADIUS_METERS,
    boundary: { type: 'LineString', coordinates: ring },
    cctvs: nearby,
    connections: nearby.map((cctv) => ({
      id: cctv.id,
      geometry: { type: 'LineString', coordinates: [center, [cctv.longitude, cctv.latitude]] },
      distanceMeters: cctv.distanceMeters,
    })),
  }
}

/** The provider owns only the map. React owns selection, labels and playback. */
export type CctvMapInstance = {
  setSelected(id: string | null): void
  resize(): void
  destroy(): void
}

export type CctvMapProvider = {
  mount(container: HTMLElement, options: {
    scene: CctvMapScene
    reducedMotion: boolean
    signal: AbortSignal
    onSelect(id: string): void
    onError(): void
  }): CctvMapInstance | Promise<CctvMapInstance>
}

export type MapProviderLoader = (signal: AbortSignal) => Promise<CctvMapProvider>

export class MapProviderError extends Error {
  constructor(readonly code: 'not_configured' | 'not_connected') {
    super('CCTV map is unavailable')
  }
}

/** Only the browser public key crosses this boundary; ITS stays server-only. */
export const loadMapProvider: MapProviderLoader = async (signal) => {
  const provider = import.meta.env?.VITE_CCTV_MAP_PROVIDER?.trim()
  const javascriptKey = import.meta.env?.VITE_KAKAO_MAP_JAVASCRIPT_KEY?.trim()
  if (!provider) throw new MapProviderError('not_configured')
  if (provider !== 'kakao') throw new MapProviderError('not_connected')
  if (!javascriptKey) throw new MapProviderError('not_configured')
  const { loadKakaoMapProvider } = await import('./kakaoMapProvider')
  return loadKakaoMapProvider(javascriptKey, signal)
}
