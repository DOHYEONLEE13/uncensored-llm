export type CctvProviderId = 'ITS' | 'UTIC'
export type ItsRoadType = 'ex' | 'its'
export type CctvFormat = 'hls' | 'mp4' | 'image' | 'unknown'

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
  roadType?: ItsRoadType
  direction?: string
  updatedAt?: string
}

export type NearbyCctv = Cctv & { distanceMeters: number }
export type NearbyCctvInput = {
  latitude: number
  longitude: number
  radiusKm: number
  limit: number
}
export type CctvSnapshot = {
  cctvs: Cctv[]
  updatedAt: number
  partial?: boolean
  retryAfter?: number
}
export type CctvBatch = Cctv[] & { partial?: boolean }
export type CctvCacheState = 'fresh' | 'stale'
export type NearbyCctvResult = {
  cctvs: NearbyCctv[]
  cache: { state: CctvCacheState; updatedAt: number }
}

export interface CctvProvider {
  readonly id: CctvProviderId
  fetchCctvs(): Promise<CctvBatch>
}

export interface CctvCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export class CctvServiceError extends Error {
  readonly type: string
  readonly status: number

  constructor(message: string, type: string, status: number) {
    super(message)
    this.name = 'CctvServiceError'
    this.type = type
    this.status = status
  }
}

export const CCTV_CACHE_FRESH_MILLISECONDS = 20 * 60 * 60 * 1_000
export const CCTV_CACHE_STALE_MILLISECONDS = 23 * 60 * 60 * 1_000
export const CCTV_REFRESH_RETRY_MILLISECONDS = 15 * 60 * 1_000
export const DEFAULT_CCTV_RADIUS_KM = 5
export const DEFAULT_CCTV_LIMIT = 5

const MAX_CCTV_RADIUS_KM = 50
const MAX_CCTV_LIMIT = 20
const MAX_REQUEST_BYTES = 16_384
const MAX_ITS_RESPONSE_CHARACTERS = 30_000_000
const MAX_PARSED_NODES = 250_000
const MAX_CCTV_ITEMS = 100_000
const ITS_REQUEST_TIMEOUT_MILLISECONDS = 25_000
const ITS_CCTV_ENDPOINT = 'https://openapi.its.go.kr:9443/cctvInfo'
const ITS_ROAD_TYPES = ['ex', 'its'] as const
const ITS_HTTPS_HLS_TYPE = '4'
const ITS_NATIONAL_BOUNDS = { minX: 124, maxX: 132, minY: 32, maxY: 39.5 } as const
const CCTV_CACHE_KEY = 'https://mira.internal/cache/cctv/its-v1'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readLimitedResponseText(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_ITS_RESPONSE_CHARACTERS) {
    await response.body?.cancel().catch(() => undefined)
    throw new CctvServiceError(
      'ITS CCTV 응답 크기가 올바르지 않습니다.',
      'its_invalid_response',
      502,
    )
  }

  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let byteLength = 0
  let text = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    byteLength += chunk.value.byteLength
    if (byteLength > MAX_ITS_RESPONSE_CHARACTERS) {
      await reader.cancel().catch(() => undefined)
      throw new CctvServiceError(
        'ITS CCTV 응답 크기가 올바르지 않습니다.',
        'its_invalid_response',
        502,
      )
    }
    text += decoder.decode(chunk.value, { stream: true })
    if (text.length > MAX_ITS_RESPONSE_CHARACTERS) {
      await reader.cancel().catch(() => undefined)
      throw new CctvServiceError(
        'ITS CCTV 응답 크기가 올바르지 않습니다.',
        'its_invalid_response',
        502,
      )
    }
  }
  return text + decoder.decode()
}

function safeText(value: unknown, maxLength = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const normalized = String(value).replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function getCaseInsensitive(record: UnknownRecord, names: readonly string[]) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) return record[name]
  }
  const expected = new Set(names.map((name) => name.toLocaleLowerCase('en-US')))
  for (const [key, value] of Object.entries(record)) {
    if (expected.has(key.toLocaleLowerCase('en-US'))) return value
  }
  return undefined
}

function finiteNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

function containsEncodedSecret(value: string, forbiddenSecret: string) {
  let candidate = value
  for (let depth = 0; depth < 5; depth += 1) {
    if (candidate.includes(forbiddenSecret)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return true
    }
  }
  return candidate.includes(forbiddenSecret)
}

function safePublicHttpUrl(value: unknown, forbiddenSecret?: string) {
  const source = safeText(value, 8_192)
  if (!source) return undefined
  try {
    const url = new URL(source)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return undefined
    }
    const hasApiKeyParameter = [...url.searchParams.keys()].some((name) =>
      /^api[-_]?key$/iu.test(name),
    )
    if (
      hasApiKeyParameter ||
      (forbiddenSecret &&
        (containsEncodedSecret(source, forbiddenSecret) ||
          containsEncodedSecret(url.toString(), forbiddenSecret)))
    ) {
      return undefined
    }
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function normalizeResultCode(value: unknown) {
  const code = safeText(value, 32)
  if (!code) return undefined
  return code.replace(/^0+(?=\d)/u, '')
}

function isSuccessResultCode(value: unknown) {
  const code = normalizeResultCode(value)
  return code === undefined || code === '0' || code.toUpperCase() === 'SUCCESS'
}

function getJsonResultCode(payload: unknown) {
  const stack: unknown[] = [payload]
  let visited = 0
  while (stack.length && visited < 100) {
    const value = stack.pop()
    visited += 1
    if (!isRecord(value)) continue
    const resultCode = getCaseInsensitive(value, ['resultCode', 'resultcode', 'code'])
    if (resultCode !== undefined) return resultCode
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:response|header|error)$/iu.test(key) && isRecord(child)) stack.push(child)
    }
  }
  return undefined
}

function getJsonDataCount(payload: unknown) {
  const stack: unknown[] = [payload]
  let visited = 0
  while (stack.length && visited < 100) {
    const value = stack.pop()
    visited += 1
    if (!isRecord(value)) continue
    const dataCount = getCaseInsensitive(value, ['datacount', 'dataCount', 'totalCount'])
    if (dataCount !== undefined) return finiteNumber(dataCount)
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:response|body|header)$/iu.test(key) && isRecord(child)) stack.push(child)
    }
  }
  return undefined
}

function collectJsonCctvRecords(payload: unknown) {
  const records: UnknownRecord[] = []
  const stack: unknown[] = [payload]
  let visited = 0
  while (stack.length && visited < MAX_PARSED_NODES && records.length < MAX_CCTV_ITEMS) {
    const value = stack.pop()
    visited += 1
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index])
      continue
    }
    if (!isRecord(value)) continue
    const hasCoordinates =
      getCaseInsensitive(value, ['coordx', 'longitude', 'lng']) !== undefined &&
      getCaseInsensitive(value, ['coordy', 'latitude', 'lat']) !== undefined
    const hasStream = getCaseInsensitive(value, ['cctvurl', 'streamUrl', 'url']) !== undefined
    if (hasCoordinates && hasStream) records.push(value)
    for (const child of Object.values(value)) {
      if (Array.isArray(child) || isRecord(child)) stack.push(child)
    }
  }
  if (visited >= MAX_PARSED_NODES) {
    throw new CctvServiceError(
      'ITS CCTV 응답이 허용된 복잡도를 초과했습니다.',
      'its_invalid_response',
      502,
    )
  }
  return records
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_match, entity: string) => {
      const hexadecimal = entity[0]?.toLocaleLowerCase('en-US') === 'x'
      const codePoint = Number.parseInt(hexadecimal ? entity.slice(1) : entity, hexadecimal ? 16 : 10)
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : ''
    })
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, '&')
}

function xmlTagValue(block: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'iu')
  const match = pattern.exec(block)
  return match ? decodeXml(match[1]).trim() : undefined
}

function collectXmlCctvRecords(xml: string) {
  const records: UnknownRecord[] = []
  const itemPattern = /<(data|item)\b[^>]*>([\s\S]*?)<\/\1>/giu
  let match: RegExpExecArray | null
  while ((match = itemPattern.exec(xml)) && records.length < MAX_CCTV_ITEMS) {
    const block = match[2]
    const coordx = xmlTagValue(block, 'coordx')
    const coordy = xmlTagValue(block, 'coordy')
    const cctvurl = xmlTagValue(block, 'cctvurl')
    if (coordx === undefined || coordy === undefined || cctvurl === undefined) continue
    records.push({
      coordx,
      coordy,
      cctvurl,
      roadsectionid: xmlTagValue(block, 'roadsectionid'),
      filecreatetime: xmlTagValue(block, 'filecreatetime'),
      cctvtype: xmlTagValue(block, 'cctvtype'),
      cctvformat: xmlTagValue(block, 'cctvformat'),
      cctvname: xmlTagValue(block, 'cctvname'),
    })
  }
  return records
}

function normalizeItsRecord(
  record: UnknownRecord,
  roadType: ItsRoadType,
  index: number,
  forbiddenSecret?: string,
): Cctv | undefined {
  const longitude = finiteNumber(getCaseInsensitive(record, ['coordx', 'longitude', 'lng']))
  const latitude = finiteNumber(getCaseInsensitive(record, ['coordy', 'latitude', 'lat']))
  const streamUrl = safePublicHttpUrl(
    getCaseInsensitive(record, ['cctvurl', 'streamUrl', 'url']),
    forbiddenSecret,
  )
  if (
    longitude === undefined ||
    latitude === undefined ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90 ||
    !streamUrl
  ) {
    return undefined
  }
  const name =
    safeText(getCaseInsensitive(record, ['cctvname', 'name']), 200) ?? `ITS CCTV ${index + 1}`
  const roadSectionId = safeText(
    getCaseInsensitive(record, ['roadsectionid', 'roadSectionId']),
    180,
  )
  const explicitProviderId = safeText(getCaseInsensitive(record, ['cctvid', 'id']), 180)
  const providerId =
    explicitProviderId ??
    `${roadSectionId ?? 'unsectioned'}:${latitude.toFixed(6)}:${longitude.toFixed(6)}`
  const rawFormat = safeText(getCaseInsensitive(record, ['cctvformat', 'format']), 40)?.toLowerCase()
  const rawType = safeText(getCaseInsensitive(record, ['cctvtype', 'type']), 20)
  const format: CctvFormat =
    rawFormat?.includes('hls') || rawFormat?.includes('m3u8') || rawType === '1' || rawType === '4'
      ? 'hls'
      : rawFormat?.includes('mp4') || rawType === '2' || rawType === '5'
        ? 'mp4'
        : rawFormat?.includes('image') || rawFormat?.includes('jpg') || rawType === '3'
          ? 'image'
          : 'unknown'
  const roadName = safeText(getCaseInsensitive(record, ['roadname', 'roadName']), 200)
  const direction = safeText(getCaseInsensitive(record, ['direction']), 120)
  const updatedAt = safeText(
    getCaseInsensitive(record, ['filecreatetime', 'updatedAt', 'updated_at']),
    40,
  )
  return {
    id: `ITS:${roadType}:${providerId}`,
    provider: 'ITS',
    providerId,
    name,
    latitude,
    longitude,
    streamUrl,
    format,
    roadType,
    ...(roadSectionId ? { roadSectionId } : {}),
    ...(roadName ? { roadName } : {}),
    ...(direction ? { direction } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

export function parseItsCctvResponse(
  responseText: string,
  roadType: ItsRoadType,
  forbiddenSecret?: string,
) {
  if (!responseText || responseText.length > MAX_ITS_RESPONSE_CHARACTERS) {
    throw new CctvServiceError(
      'ITS CCTV 응답 크기가 올바르지 않습니다.',
      'its_invalid_response',
      502,
    )
  }
  const trimmed = responseText.trim()
  let records: UnknownRecord[]
  let declaredDataCount: number | undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let payload: unknown
    try {
      payload = JSON.parse(trimmed)
    } catch {
      throw new CctvServiceError(
        'ITS CCTV JSON 응답을 해석할 수 없습니다.',
        'its_invalid_response',
        502,
      )
    }
    const resultCode = getJsonResultCode(payload)
    if (!isSuccessResultCode(resultCode)) {
      throw new CctvServiceError(
        `ITS CCTV API가 오류 코드 ${safeText(resultCode, 32) ?? 'unknown'}를 반환했습니다.`,
        'its_api_error',
        502,
      )
    }
    declaredDataCount = getJsonDataCount(payload)
    records = collectJsonCctvRecords(payload)
  } else if (trimmed.startsWith('<')) {
    const resultCode = xmlTagValue(trimmed, 'resultCode') ?? xmlTagValue(trimmed, 'resultcode')
    if (!isSuccessResultCode(resultCode)) {
      throw new CctvServiceError(
        `ITS CCTV API가 오류 코드 ${safeText(resultCode, 32) ?? 'unknown'}를 반환했습니다.`,
        'its_api_error',
        502,
      )
    }
    declaredDataCount = finiteNumber(xmlTagValue(trimmed, 'datacount'))
    records = collectXmlCctvRecords(trimmed)
  } else {
    throw new CctvServiceError(
      'ITS CCTV 응답 형식을 해석할 수 없습니다.',
      'its_invalid_response',
      502,
    )
  }
  const cctvs = records
    .map((record, index) => normalizeItsRecord(record, roadType, index, forbiddenSecret))
    .filter((cctv): cctv is Cctv => cctv !== undefined)
  if (
    declaredDataCount !== undefined &&
    declaredDataCount > 0 &&
    (declaredDataCount > MAX_CCTV_ITEMS ||
      cctvs.length * 2 < Math.min(declaredDataCount, MAX_CCTV_ITEMS))
  ) {
    throw new CctvServiceError(
      'ITS CCTV 응답의 데이터 개수와 유효한 항목이 일치하지 않습니다.',
      'its_invalid_response',
      502,
    )
  }
  return cctvs
}

export class ItsCctvProvider implements CctvProvider {
  readonly id = 'ITS' as const
  private readonly apiKey: string
  private readonly fetchImplementation: typeof fetch

  constructor(apiKey: string, fetchImplementation: typeof fetch = fetch) {
    this.apiKey = apiKey
    this.fetchImplementation = fetchImplementation
  }

  private async fetchRoadType(roadType: ItsRoadType) {
    const url = new URL(ITS_CCTV_ENDPOINT)
    url.searchParams.set('apiKey', this.apiKey)
    url.searchParams.set('type', roadType)
    url.searchParams.set('cctvType', ITS_HTTPS_HLS_TYPE)
    url.searchParams.set('minX', String(ITS_NATIONAL_BOUNDS.minX))
    url.searchParams.set('maxX', String(ITS_NATIONAL_BOUNDS.maxX))
    url.searchParams.set('minY', String(ITS_NATIONAL_BOUNDS.minY))
    url.searchParams.set('maxY', String(ITS_NATIONAL_BOUNDS.maxY))
    url.searchParams.set('getType', 'json')

    let response: Response
    try {
      response = await this.fetchImplementation(url, {
        method: 'GET',
        headers: { Accept: 'application/json, application/xml;q=0.9, text/xml;q=0.8' },
        signal: AbortSignal.timeout(ITS_REQUEST_TIMEOUT_MILLISECONDS),
      })
    } catch {
      throw new CctvServiceError(
        'ITS CCTV 서비스에 연결할 수 없습니다.',
        'its_connection_error',
        503,
      )
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new CctvServiceError(
        `ITS CCTV 서비스가 HTTP ${response.status}를 반환했습니다.`,
        'its_http_error',
        502,
      )
    }
    const cctvs = parseItsCctvResponse(
      await readLimitedResponseText(response),
      roadType,
      this.apiKey,
    )
    if (!cctvs.length) {
      throw new CctvServiceError(
        `ITS CCTV ${roadType} 응답에 CCTV가 없습니다.`,
        'its_empty_response',
        502,
      )
    }
    return cctvs
  }

  async fetchCctvs() {
    const groups = await Promise.allSettled(
      ITS_ROAD_TYPES.map((roadType) => this.fetchRoadType(roadType)),
    )
    const deduplicated = new Map<string, Cctv>()
    for (const group of groups) {
      if (group.status !== 'fulfilled') continue
      for (const cctv of group.value) deduplicated.set(cctv.id, cctv)
    }
    if (deduplicated.size === 0) {
      const providerError = groups.find(
        (group): group is PromiseRejectedResult => group.status === 'rejected',
      )?.reason
      if (providerError instanceof CctvServiceError) throw providerError
      throw new CctvServiceError(
        'ITS CCTV 서비스가 사용 가능한 CCTV를 반환하지 않았습니다.',
        'its_empty_response',
        502,
      )
    }
    const cctvs = [...deduplicated.values()] as CctvBatch
    if (groups.some((group) => group.status === 'rejected')) {
      Object.defineProperty(cctvs, 'partial', { value: true })
    }
    return cctvs
  }
}

export function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const earthRadiusMeters = 6_371_008.8
  const latitudeDelta = radians(latitudeB - latitudeA)
  const longitudeDelta = radians(longitudeB - longitudeA)
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function findNearbyCctvs(cctvs: readonly Cctv[], input: NearbyCctvInput) {
  const maximumDistance = input.radiusKm * 1_000
  return cctvs
    .map((cctv) => ({
      ...cctv,
      distanceMeters: Math.round(
        haversineDistanceMeters(input.latitude, input.longitude, cctv.latitude, cctv.longitude),
      ),
    }))
    .filter((cctv) => cctv.distanceMeters <= maximumDistance)
    .sort((left, right) => left.distanceMeters - right.distanceMeters || left.id.localeCompare(right.id))
    .slice(0, input.limit)
}

export function parseNearbyCctvInput(value: unknown): NearbyCctvInput {
  if (!isRecord(value)) {
    throw new CctvServiceError('위치 요청 형식이 올바르지 않습니다.', 'invalid_request', 400)
  }
  const latitude = finiteNumber(value.latitude ?? value.lat)
  const longitude = finiteNumber(value.longitude ?? value.lng)
  const radiusValue = value.radiusKm ?? value.radius
  const radiusKm =
    radiusValue === undefined ? DEFAULT_CCTV_RADIUS_KM : finiteNumber(radiusValue)
  const limitValue = value.limit === undefined ? DEFAULT_CCTV_LIMIT : finiteNumber(value.limit)
  if (latitude === undefined || latitude < -90 || latitude > 90) {
    throw new CctvServiceError('latitude는 -90에서 90 사이여야 합니다.', 'invalid_request', 400)
  }
  if (longitude === undefined || longitude < -180 || longitude > 180) {
    throw new CctvServiceError('longitude는 -180에서 180 사이여야 합니다.', 'invalid_request', 400)
  }
  if (radiusKm === undefined || radiusKm <= 0 || radiusKm > MAX_CCTV_RADIUS_KM) {
    throw new CctvServiceError(
      `radiusKm는 0보다 크고 ${MAX_CCTV_RADIUS_KM} 이하여야 합니다.`,
      'invalid_request',
      400,
    )
  }
  if (
    limitValue === undefined ||
    !Number.isInteger(limitValue) ||
    limitValue < 1 ||
    limitValue > MAX_CCTV_LIMIT
  ) {
    throw new CctvServiceError(
      `limit은 1에서 ${MAX_CCTV_LIMIT} 사이의 정수여야 합니다.`,
      'invalid_request',
      400,
    )
  }
  return { latitude, longitude, radiusKm, limit: limitValue }
}

function normalizeCachedCctv(value: unknown): Cctv | undefined {
  if (!isRecord(value)) return undefined
  const latitude = finiteNumber(value.latitude)
  const longitude = finiteNumber(value.longitude)
  const streamUrl = safePublicHttpUrl(value.streamUrl)
  const format =
    value.format === 'hls' ||
    value.format === 'mp4' ||
    value.format === 'image' ||
    value.format === 'unknown'
      ? value.format
      : undefined
  const id = safeText(value.id, 400)
  const providerId = safeText(value.providerId, 180)
  const name = safeText(value.name, 200)
  if (
    value.provider !== 'ITS' ||
    !id ||
    !providerId ||
    !name ||
    !format ||
    latitude === undefined ||
    longitude === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    !streamUrl
  ) {
    return undefined
  }
  const roadType = value.roadType === 'ex' || value.roadType === 'its' ? value.roadType : undefined
  const roadSectionId = safeText(value.roadSectionId, 180)
  const roadName = safeText(value.roadName, 200)
  const direction = safeText(value.direction, 120)
  const updatedAt = safeText(value.updatedAt, 40)
  return {
    id,
    provider: 'ITS',
    providerId,
    name,
    latitude,
    longitude,
    streamUrl,
    format,
    ...(roadSectionId ? { roadSectionId } : {}),
    ...(roadType ? { roadType } : {}),
    ...(roadName ? { roadName } : {}),
    ...(direction ? { direction } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function normalizeCachedSnapshot(value: unknown): CctvSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value.cctvs)) return undefined
  const updatedAt = finiteNumber(value.updatedAt)
  const retryAfter = finiteNumber(value.retryAfter)
  const partial = value.partial === true
  if (updatedAt === undefined || updatedAt <= 0 || value.cctvs.length > MAX_CCTV_ITEMS) return undefined
  const cctvs = value.cctvs.map(normalizeCachedCctv).filter((cctv): cctv is Cctv => Boolean(cctv))
  if (!cctvs.length) return undefined
  return {
    cctvs,
    updatedAt,
    ...(partial ? { partial: true } : {}),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  }
}

type CloudflareCctvServiceOptions = {
  provider: CctvProvider
  cache: CctvCache
  now?: () => number
  freshMilliseconds?: number
  staleMilliseconds?: number
  retryMilliseconds?: number
}

export function createCloudflareCctvService({
  provider,
  cache,
  now = Date.now,
  freshMilliseconds = CCTV_CACHE_FRESH_MILLISECONDS,
  staleMilliseconds = CCTV_CACHE_STALE_MILLISECONDS,
  retryMilliseconds = CCTV_REFRESH_RETRY_MILLISECONDS,
}: CloudflareCctvServiceOptions) {
  let refreshInFlight: Promise<CctvSnapshot> | undefined
  let memorySnapshot: CctvSnapshot | undefined
  let lastRefreshFailureAt: number | undefined
  let lastRefreshError: CctvServiceError | undefined
  const cacheRequest = new Request(CCTV_CACHE_KEY)

  const readSnapshot = async () => {
    try {
      const response = await cache.match(cacheRequest)
      if (!response) return memorySnapshot
      const cached = normalizeCachedSnapshot(await response.json())
      if (!cached) return memorySnapshot
      if (
        !memorySnapshot ||
        cached.updatedAt > memorySnapshot.updatedAt ||
        (cached.updatedAt === memorySnapshot.updatedAt &&
          (cached.retryAfter ?? 0) > (memorySnapshot.retryAfter ?? 0))
      ) {
        memorySnapshot = cached
      }
      return memorySnapshot
    } catch {
      return memorySnapshot
    }
  }

  const writeSnapshot = async (snapshot: CctvSnapshot) => {
    memorySnapshot = snapshot
    const expiresAt = Math.max(
      snapshot.updatedAt + staleMilliseconds,
      snapshot.retryAfter ?? 0,
    )
    const remainingLifetime = Math.max(
      1,
      Math.floor((expiresAt - now()) / 1_000),
    )
    const response = Response.json(snapshot, {
      headers: { 'Cache-Control': `public, max-age=${remainingLifetime}` },
    })
    await cache.put(cacheRequest, response)
  }

  const refresh = (staleSnapshot?: CctvSnapshot) => {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = provider
      .fetchCctvs()
      .then(async (cctvs) => {
        const completedAt = now()
        const partial = cctvs.partial === true
        const snapshot: CctvSnapshot =
          partial &&
          staleSnapshot &&
          completedAt - staleSnapshot.updatedAt <= staleMilliseconds
            ? {
                ...staleSnapshot,
                cctvs: staleSnapshot.partial
                  ? [
                      ...new Map(
                        [...staleSnapshot.cctvs, ...cctvs].map((cctv) => [cctv.id, cctv]),
                      ).values(),
                    ]
                  : staleSnapshot.cctvs,
                retryAfter: completedAt + retryMilliseconds,
              }
            : {
                cctvs: [...cctvs],
                updatedAt: completedAt,
                ...(partial
                  ? { partial: true, retryAfter: completedAt + retryMilliseconds }
                  : {}),
              }
        try {
          await writeSnapshot(snapshot)
        } catch {
          // The current request can still use the fresh result if an edge cache write fails.
        }
        lastRefreshFailureAt = undefined
        lastRefreshError = undefined
        return snapshot
      })
      .catch(async (error: unknown) => {
        const normalized =
          error instanceof CctvServiceError
            ? error
            : new CctvServiceError(
                'CCTV 메타데이터를 준비할 수 없습니다.',
                'cctv_cache_unavailable',
                503,
              )
        const failedAt = now()
        lastRefreshFailureAt = failedAt
        lastRefreshError = normalized
        if (staleSnapshot && failedAt - staleSnapshot.updatedAt <= staleMilliseconds) {
          try {
            await writeSnapshot({ ...staleSnapshot, retryAfter: failedAt + retryMilliseconds })
          } catch {
            // Module state still prevents a retry storm in this isolate.
          }
        }
        throw normalized
      })
      .finally(() => {
        refreshInFlight = undefined
      })
    return refreshInFlight
  }

  const getSnapshot = async (scheduleBackground?: (promise: Promise<unknown>) => void) => {
    const cached = await readSnapshot()
    if (cached) {
      const age = Math.max(0, now() - cached.updatedAt)
      const moduleRetryAfter = lastRefreshFailureAt
        ? lastRefreshFailureAt + retryMilliseconds
        : 0
      const retryBlockedUntil = Math.max(cached.retryAfter ?? 0, moduleRetryAfter)
      if (age <= staleMilliseconds) {
        if (cached.partial) {
          if (now() >= retryBlockedUntil) {
            const backgroundRefresh = refresh(cached).catch(() => undefined)
            scheduleBackground?.(backgroundRefresh)
          }
          return { snapshot: cached, state: 'stale' as const }
        }
        if (age < freshMilliseconds) return { snapshot: cached, state: 'fresh' as const }
        if (now() >= retryBlockedUntil) {
          const backgroundRefresh = refresh(cached).catch(() => undefined)
          scheduleBackground?.(backgroundRefresh)
        }
        return { snapshot: cached, state: 'stale' as const }
      }
      if (now() < retryBlockedUntil) {
        throw (
          lastRefreshError ??
          new CctvServiceError(
            'CCTV 메타데이터를 새로 고칠 수 없습니다.',
            'cctv_cache_unavailable',
            503,
          )
        )
      }
    }

    if (
      lastRefreshFailureAt !== undefined &&
      now() - lastRefreshFailureAt < retryMilliseconds
    ) {
      throw (
        lastRefreshError ??
        new CctvServiceError(
          'CCTV 메타데이터를 준비할 수 없습니다.',
          'cctv_cache_unavailable',
          503,
        )
      )
    }

    try {
      const refreshed = await refresh()
      return {
        snapshot: refreshed,
        state: refreshed.partial ? ('stale' as const) : ('fresh' as const),
      }
    } catch (error) {
      if (error instanceof CctvServiceError) throw error
      throw new CctvServiceError(
        'CCTV 메타데이터를 준비할 수 없습니다.',
        'cctv_cache_unavailable',
        503,
      )
    }
  }

  return {
    async getNearby(
      input: NearbyCctvInput,
      scheduleBackground?: (promise: Promise<unknown>) => void,
    ): Promise<NearbyCctvResult> {
      const cached = await getSnapshot(scheduleBackground)
      return {
        cctvs: findNearbyCctvs(cached.snapshot.cctvs, input),
        cache: { state: cached.state, updatedAt: cached.snapshot.updatedAt },
      }
    },
  }
}

export type CctvEnv = { ITS_API_KEY?: string }
export type CctvPagesContext = {
  request: Request
  env: CctvEnv
  waitUntil?: (promise: Promise<unknown>) => void
}

let defaultService:
  | {
      apiKey: string
      service: ReturnType<typeof createCloudflareCctvService>
    }
  | undefined
let defaultServiceInitialization:
  | {
      apiKey: string
      promise: Promise<ReturnType<typeof createCloudflareCctvService>>
    }
  | undefined

function getItsApiKey(env: CctvEnv) {
  const apiKey = env.ITS_API_KEY?.trim()
  return apiKey && apiKey !== '여기에_내_ITS_API_Key' ? apiKey : undefined
}

async function getDefaultCache(): Promise<CctvCache> {
  const cacheStorage = caches as CacheStorage & { default?: Cache }
  return cacheStorage.default ?? cacheStorage.open('mira-cctv')
}

async function getDefaultService(apiKey: string) {
  if (defaultService?.apiKey === apiKey) return defaultService.service
  if (defaultServiceInitialization?.apiKey === apiKey) {
    return defaultServiceInitialization.promise
  }

  const promise = getDefaultCache().then((cache) =>
    createCloudflareCctvService({ provider: new ItsCctvProvider(apiKey), cache }),
  )
  defaultServiceInitialization = { apiKey, promise }
  try {
    const service = await promise
    defaultService = { apiKey, service }
    return service
  } finally {
    if (defaultServiceInitialization?.promise === promise) {
      defaultServiceInitialization = undefined
    }
  }
}

function json(body: unknown, status = 200, allow?: string) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(allow ? { Allow: allow } : {}),
    },
  })
}

async function readRequestBody(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REQUEST_BYTES) {
    throw new CctvServiceError('요청 크기가 너무 큽니다.', 'request_too_large', 413)
  }
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  if (reader) {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new CctvServiceError('요청 크기가 너무 큽니다.', 'request_too_large', 413)
      }
      chunks.push(chunk.value)
    }
  }

  const body = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(body)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new CctvServiceError('올바른 JSON 요청이 아닙니다.', 'invalid_request', 400)
  }
}

export async function handleNearbyCctvRequest(context: CctvPagesContext) {
  const { request, env } = context
  if (request.method !== 'POST') {
    return json(
      { error: { code: 'method_not_allowed', message: 'Method not allowed' } },
      405,
      'POST',
    )
  }

  try {
    const payload = await readRequestBody(request)
    const input = parseNearbyCctvInput(payload)
    const apiKey = getItsApiKey(env)
    if (!apiKey) {
      throw new CctvServiceError(
        'ITS_API_KEY가 Cloudflare Pages Secret에 설정되지 않았습니다.',
        'configuration_error',
        503,
      )
    }
    const service = await getDefaultService(apiKey)
    const scheduleBackground = context.waitUntil
      ? (promise: Promise<unknown>) => context.waitUntil?.(promise)
      : undefined
    const result = await service.getNearby(input, scheduleBackground)
    return json(result)
  } catch (error) {
    const normalized =
      error instanceof CctvServiceError
        ? error
        : new CctvServiceError(
            'CCTV 요청을 처리할 수 없습니다.',
            'cctv_service_error',
            503,
          )
    return json(
      { error: { code: normalized.type, message: normalized.message } },
      normalized.status,
    )
  }
}
