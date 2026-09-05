/**
 * Client-side contract for the nearby CCTV endpoint.
 *
 * Coordinates deliberately only exist as short-lived values while this module
 * asks the browser and posts to the API. They are never added to chat history,
 * localStorage, query strings, or diagnostics.
 */
export type Coordinates = {
  latitude: number
  longitude: number
}

export const CCTV_RADIUS_METERS = 2_000
export const CCTV_LIMIT = 20

export function formatCctvDistance(distanceMeters: number): string {
  return distanceMeters < 1_000
    ? `${Math.max(0, Math.round(distanceMeters))}m`
    : `${(distanceMeters / 1_000).toFixed(1)}km`
}

export function formatCctvRoadType(roadType?: string): string {
  if (roadType === 'ex') return '고속도로'
  if (roadType === 'its') return '국도'
  return roadType || '도로 유형 미제공'
}

/** Geometry is only a boundary guard; displayed distances remain the server's. */
export function cctvDistanceMeters(from: Coordinates, to: Coordinates): number {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const a = Math.sin(radians(to.latitude - from.latitude) / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) *
    Math.sin(radians(to.longitude - from.longitude) / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

export function selectNearbyCctvs(
  cctvs: NearbyCctv[],
  coordinates?: Coordinates,
  radiusMeters = CCTV_RADIUS_METERS,
  limit = CCTV_LIMIT,
): NearbyCctv[] {
  return cctvs.filter((cctv) =>
    cctv.provider === 'ITS' && hasValidCoordinates(cctv) &&
    Number.isFinite(cctv.distanceMeters) && cctv.distanceMeters >= 0 &&
    cctv.distanceMeters <= radiusMeters &&
    (!coordinates || cctvDistanceMeters(coordinates, cctv) <= radiusMeters)
  ).sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id))
    .slice(0, limit)
}

export type CctvFormat = 'hls' | 'mp4' | 'image' | 'unknown'

export type NearbyCctv = {
  id: string
  provider: 'ITS' | 'UTIC'
  providerId: string
  name: string
  latitude: number
  longitude: number
  distanceMeters: number
  streamUrl: string
  format: CctvFormat
  roadType?: string
  roadSectionId?: string
  updatedAt?: string
}

export type CctvCacheMetadata = {
  status: 'fresh' | 'cached' | 'stale'
  fetchedAt?: string
}

export type NearbyCctvResponse = {
  cctvs: NearbyCctv[]
  cache?: CctvCacheMetadata
}

export type CctvClientErrorCode =
  | 'location_denied'
  | 'location_unavailable'
  | 'location_timeout'
  | 'location_unsupported'
  | 'invalid_location'
  | 'invalid_response'
  | 'network_error'
  | 'request_failed'
  | 'service_unavailable'
  | 'configuration_error'
  | 'its_connection_error'
  | 'its_timeout'
  | 'its_http_error'
  | 'its_api_error'
  | 'its_invalid_response'
  | 'its_empty_response'
  | 'cctv_cache_unavailable'
  | 'cctv_service_error'

const ERROR_MESSAGES: Record<CctvClientErrorCode, string> = {
  location_denied: '주변 CCTV를 찾으려면 위치 권한이 필요합니다.',
  location_unavailable: '현재 위치를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  location_timeout: '위치 확인 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
  location_unsupported: '이 브라우저에서는 위치 정보를 사용할 수 없습니다.',
  invalid_location: '유효한 위치 정보를 받지 못했습니다.',
  invalid_response: 'CCTV 정보를 읽는 중 문제가 발생했습니다.',
  network_error: 'CCTV 서비스에 연결할 수 없습니다. 네트워크를 확인해 주세요.',
  request_failed: '주변 CCTV를 불러오지 못했습니다.',
  service_unavailable: '현재 CCTV 서비스를 이용할 수 없습니다.',
  configuration_error: 'CCTV 서비스 인증 설정이 누락되어 있습니다. 관리자에게 문의해 주세요.',
  its_connection_error: 'CCTV 제공 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  its_timeout: 'CCTV 조회 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
  its_http_error: 'CCTV 제공 서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  its_api_error: 'CCTV 제공 서비스의 인증 또는 요청 처리에 문제가 있습니다. 관리자에게 문의해 주세요.',
  its_invalid_response: 'CCTV 제공 서버에서 올바른 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.',
  its_empty_response: 'CCTV 제공 서버에서 정보를 받지 못했습니다. 잠시 후 다시 시도해 주세요.',
  cctv_cache_unavailable: 'CCTV 정보를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  cctv_service_error: '현재 CCTV 서비스를 이용할 수 없습니다.',
}

export class CctvClientError extends Error {
  readonly code: CctvClientErrorCode | string
  readonly status?: number

  constructor(
    code: CctvClientErrorCode | string,
    message?: string,
    status?: number,
  ) {
    super(message || (Object.hasOwn(ERROR_MESSAGES, code)
      ? ERROR_MESSAGES[code as CctvClientErrorCode]
      : ERROR_MESSAGES.request_failed))
    this.name = 'CctvClientError'
    this.code = code
    this.status = status
  }
}

const EXPLICIT_CCTV_INTENT = /(?:\bcctv\b|교통\s*(?:카메라|영상)|도로\s*(?:카메라|영상)|실시간\s*(?:교통|도로)\s*영상)/i

/**
 * Deliberately narrow routing: ordinary traffic, travel, or weather questions
 * remain normal AI chat messages. The composer CCTV button bypasses this check.
 */
export function isExplicitCctvIntent(text: string): boolean {
  return typeof text === 'string' && EXPLICIT_CCTV_INTENT.test(text.trim())
}

function hasValidCoordinates(value: Coordinates): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  )
}

/** Reads browser geolocation once. The result is intentionally not persisted. */
export function getCurrentCoordinates(): Promise<Coordinates> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.reject(new CctvClientError('location_unsupported'))
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }

        if (!hasValidCoordinates(coordinates)) {
          reject(new CctvClientError('invalid_location'))
          return
        }

        resolve(coordinates)
      },
      (error) => {
        switch (error.code) {
          case error.PERMISSION_DENIED:
            reject(new CctvClientError('location_denied'))
            break
          case error.TIMEOUT:
            reject(new CctvClientError('location_timeout'))
            break
          default:
            reject(new CctvClientError('location_unavailable'))
        }
      },
      {
        enableHighAccuracy: false,
        timeout: 10_000,
        maximumAge: 300_000,
      },
    )
  })
}

function parseCctv(value: unknown): NearbyCctv | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : undefined
  const provider = record.provider === 'ITS' || record.provider === 'UTIC'
    ? record.provider
    : undefined
  const name = typeof record.name === 'string' ? record.name : undefined
  const streamUrl = typeof record.streamUrl === 'string' ? record.streamUrl : undefined
  const latitude = typeof record.latitude === 'number' ? record.latitude : undefined
  const longitude = typeof record.longitude === 'number' ? record.longitude : undefined
  const distanceMeters = typeof record.distanceMeters === 'number'
    ? record.distanceMeters
    : typeof record.distanceKm === 'number'
      ? record.distanceKm * 1_000
      : undefined
  const format = record.format

  if (
    !id || !provider || !name || !streamUrl || latitude === undefined || longitude === undefined ||
    distanceMeters === undefined || !hasValidCoordinates({ latitude, longitude }) ||
    !Number.isFinite(distanceMeters) || distanceMeters < 0
  ) {
    return undefined
  }

  try {
    const parsedStreamUrl = new URL(streamUrl)
    if (parsedStreamUrl.protocol !== 'http:' && parsedStreamUrl.protocol !== 'https:') return undefined
    if (parsedStreamUrl.username || parsedStreamUrl.password) return undefined
  } catch {
    return undefined
  }

  return {
    id,
    provider,
    providerId: typeof record.providerId === 'string' ? record.providerId : id,
    name,
    latitude,
    longitude,
    distanceMeters,
    streamUrl,
    format: format === 'hls' || format === 'mp4' || format === 'image' ? format : 'unknown',
    ...(typeof record.roadType === 'string' ? { roadType: record.roadType } : {}),
    ...(typeof record.roadSectionId === 'string' ? { roadSectionId: record.roadSectionId } : {}),
    ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}),
  }
}

function normalizeResponse(value: unknown): NearbyCctvResponse {
  if (!value || typeof value !== 'object') {
    throw new CctvClientError('invalid_response')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.cctvs)) {
    throw new CctvClientError('invalid_response')
  }

  const cctvs = record.cctvs.map(parseCctv).filter((cctv): cctv is NearbyCctv => Boolean(cctv))
  if (cctvs.length !== record.cctvs.length) {
    throw new CctvClientError('invalid_response')
  }

  const rawCache = record.cache
  const cache = rawCache && typeof rawCache === 'object'
    ? rawCache as Record<string, unknown>
    : undefined
  const status = cache?.status ?? cache?.state
  const fetchedAt = typeof cache?.fetchedAt === 'string'
    ? cache.fetchedAt
    : typeof cache?.updatedAt === 'number'
      ? new Date(cache.updatedAt).toISOString()
      : undefined

  return {
    cctvs,
    ...(status === 'fresh' || status === 'cached' || status === 'stale'
      ? {
          cache: {
            status,
            ...(fetchedAt ? { fetchedAt } : {}),
          },
        }
      : {}),
  }
}

export async function fetchNearbyCctvs(
  coordinates: Coordinates,
  options: {
    signal?: AbortSignal
    radiusKm?: number
    limit?: number
  } = {},
): Promise<NearbyCctvResponse> {
  if (!hasValidCoordinates(coordinates)) {
    throw new CctvClientError('invalid_location')
  }

  const radiusKm = options.radiusKm ?? CCTV_RADIUS_METERS / 1_000
  const limit = options.limit ?? CCTV_LIMIT

  try {
    const response = await fetch('/api/cctv/nearby', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        radiusKm,
        limit,
      }),
    })
    const bodyText = await response.text()
    let payload: unknown
    try {
      payload = bodyText ? JSON.parse(bodyText) : undefined
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const payloadRecord = payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : undefined
      const code = payloadRecord?.error && typeof payloadRecord.error === 'object'
        ? (payloadRecord.error as Record<string, unknown>).code
        : payloadRecord?.type
      const normalizedCode = typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code) ? code :
        response.status === 503 ? 'service_unavailable' : 'request_failed'
      // Never put an upstream diagnostic (which could contain GPS or credentials)
      // into a chat message or its persisted history.
      throw new CctvClientError(normalizedCode, undefined, response.status)
    }

    const result = normalizeResponse(payload)
    return {
      ...result,
      cctvs: selectNearbyCctvs(result.cctvs, coordinates, radiusKm * 1_000, limit),
    }
  } catch (error) {
    if (error instanceof CctvClientError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new CctvClientError('network_error')
  }
}
