export type CctvProviderId = 'ITS' | 'UTIC'
export type ItsRoadType = 'ex' | 'its'
export type CctvFormat = 'hls' | 'mp4' | 'image' | 'iframe' | 'unavailable' | 'unknown'
export type CctvIssue = { provider: CctvProviderId; code: string }
export type Cctv = {
  id: string
  provider: CctvProviderId
  providerId: string
  name: string
  latitude: number
  longitude: number
  streamUrl: string
  format: CctvFormat
  roadSectionId?: string
  roadName?: string
  roadType?: ItsRoadType | 'urban'
  direction?: string
  updatedAt?: string
}
export type NearbyCctv = Cctv & { distanceMeters: number }
export type NearbyCctvInput = { latitude: number; longitude: number; radiusKm: number; limit: number }
export type CctvSnapshot = { cctvs: Cctv[]; updatedAt: number; partial?: boolean; retryAfter?: number; issues?: CctvIssue[] }
export type CctvBatch = Cctv[] & { partial?: boolean; issues?: CctvIssue[]; updatedAt?: number }
export type CctvCacheState = 'fresh' | 'stale'
export type NearbyCctvResult = { cctvs: NearbyCctv[]; cache: { state: CctvCacheState; updatedAt: number }; issues?: CctvIssue[] }
export interface CctvProvider {
  readonly id: CctvProviderId | 'combined'
  fetchCctvs(): Promise<CctvBatch>
}
export class CctvServiceError extends Error {
  constructor(message: string, readonly type: string, readonly status: number) {
    super(message)
    this.name = 'CctvServiceError'
  }
}

const ISSUE_CODES = new Set(['utic_ip_not_allowed', 'utic_api_error', 'utic_invalid_response', 'utic_empty_response', 'utic_connection_error', 'utic_timeout', 'utic_relay_error', 'its_connection_error', 'its_timeout', 'its_http_error', 'its_api_error', 'its_invalid_response', 'its_empty_response', 'cctv_service_error'])
export function normalizeCctvIssues(value: unknown): CctvIssue[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 2).flatMap((item) => {
    if (!item || (item.provider !== 'ITS' && item.provider !== 'UTIC')) return []
    return [{ provider: item.provider as CctvProviderId, code: ISSUE_CODES.has(item.code) ? item.code as string : 'cctv_service_error' }]
  })
}
