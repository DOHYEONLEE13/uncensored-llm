import { CctvServiceError, type Cctv, type CctvBatch, type CctvFormat, type CctvProvider } from './cctvTypes.js'
import { isUticPlayerUrl } from './uticPlayback.js'

const ENDPOINT = 'https://www.utic.go.kr/guide/cctvOpenData.do'
const MAX_BYTES = 30_000_000
const MAX_ITEMS = 100_000
const TIMEOUT = 25_000
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const valueOf = (value: RecordValue, keys: string[]) => Object.entries(value).find(([key]) => keys.includes(key.toLowerCase()))?.[1]
const text = (value: unknown, max = 200) => typeof value === 'string' || typeof value === 'number'
  ? String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max) : ''
const number = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
const invalid = () => new CctvServiceError('UTIC CCTV 응답 형식을 확인할 수 없습니다.', 'utic_invalid_response', 502)

function hasSecret(value: string, secrets: string[]) {
  let decoded = value
  for (let i = 0; i < 6; i++) {
    if (secrets.some((secret) => secret && decoded.includes(secret))) return true
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return false
      decoded = next
    } catch { return true }
  }
  return true
}

function playback(value: unknown, rawFormat: unknown, secrets: string[]): { streamUrl: string; format: CctvFormat } {
  const unavailable = { streamUrl: '', format: 'unavailable' as const }
  if (typeof value !== 'string' || value.length > 4000 || hasSecret(value, secrets)) return unavailable
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return unavailable
    if ([...url.searchParams.keys()].some((key) => /^(?:key|api[-_]?key|password|passwd|cctvpasswd|cctvip|cctvch|cctvport)$/iu.test(key))) return unavailable
    const format = text(rawFormat, 30).toLowerCase()
    if (isUticPlayerUrl(url.href)) return { streamUrl: url.href, format: 'iframe' }
    // HTML/legacy players are not media files; never guess a camera address from CCTVIP.
    const detected: CctvFormat = /\.m3u8$/iu.test(url.pathname) || /^(hls|m3u8)$/u.test(format) ? 'hls'
      : /\.mp4$/iu.test(url.pathname) || format === 'mp4' ? 'mp4'
        : /\.(jpe?g|png|webp)$/iu.test(url.pathname) || format === 'image' ? 'image' : 'unavailable'
    return detected === 'unavailable' ? unavailable : { streamUrl: url.href, format: detected }
  } catch { return unavailable }
}

/** Accept API coordinates/URLs, never the camera login fields used by UTIC's legacy players. */
export function normalizeUticCamera(value: unknown, secrets: string[] = []): Cctv | undefined {
  if (!record(value)) return undefined
  for (const field of ['cctvname', 'name', 'cctvid', 'providerid', 'roadname']) {
    const raw = valueOf(value, [field])
    if (typeof raw === 'string' && hasSecret(raw, secrets)) return undefined
  }
  const latitude = number(valueOf(value, ['latitude', 'lat', 'coordy', 'ycoord']))
  const longitude = number(valueOf(value, ['longitude', 'lng', 'lon', 'coordx', 'xcoord']))
  const name = text(valueOf(value, ['cctvname', 'name']))
  const providerId = text(valueOf(value, ['cctvid', 'providerid']), 180)
  if (!providerId || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
    latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
    hasSecret(`${name} ${providerId}`, secrets)) return undefined
  const roadName = text(valueOf(value, ['roadname']))
  return {
    id: `UTIC:${providerId}`, provider: 'UTIC', providerId, name, latitude, longitude, roadType: 'urban',
    ...playback(valueOf(value, ['cctvurl', 'streamurl', 'url', 'movie']), valueOf(value, ['cctvformat', 'format']), secrets),
    ...(roadName && !hasSecret(roadName, secrets) ? { roadName } : {}),
  }
}

function decodeXml(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1').replace(/&#(x[0-9a-f]+|\d+);/giu, (_, entity: string) => {
    const code = Number.parseInt(entity[0].toLowerCase() === 'x' ? entity.slice(1) : entity, entity[0].toLowerCase() === 'x' ? 16 : 10)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }).replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/&quot;/giu, '"').replace(/&apos;/giu, "'").replace(/&amp;/giu, '&')
}

function checkResult(code: unknown) {
  if (code === undefined || ['0', '00', '000', '0000', '200', 'success', 'ok'].includes(String(code).toLowerCase())) return
  if (String(code) === '04') throw new CctvServiceError('UTIC에 등록된 IP에서만 CCTV를 조회할 수 있습니다.', 'utic_ip_not_allowed', 503)
  throw new CctvServiceError('UTIC CCTV 인증 또는 요청 처리에 문제가 있습니다.', 'utic_api_error', 502)
}

export function parseUticCctvResponse(body: string, secrets: string[] = []): CctvBatch {
  if (!body || body.length > MAX_BYTES) throw invalid()
  const rows: unknown[] = []
  const trimmed = body.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { throw invalid() }
    const stack: unknown[] = [parsed]
    let visited = 0
    while (stack.length) {
      if (++visited > 250_000) throw invalid()
      const value = stack.pop()
      if (Array.isArray(value)) { for (const item of value) stack.push(item); continue }
      if (!record(value)) continue
      checkResult(valueOf(value, ['resultcode']))
      if (valueOf(value, ['cctvid', 'providerid']) !== undefined) rows.push(value)
      for (const child of Object.values(value)) if (Array.isArray(child) || record(child)) stack.push(child)
    }
  } else if (trimmed.startsWith('<') && !/<!DOCTYPE|<!ENTITY|<html\b|<script\b/iu.test(trimmed)) {
    checkResult(/<resultcode\b[^>]*>([^<]*)<\/resultcode>/iu.exec(trimmed)?.[1]?.trim())
    const itemTag = /<item\b/iu.test(trimmed) ? 'item' : /<row\b/iu.test(trimmed) ? 'row' : 'data'
    for (const match of trimmed.matchAll(new RegExp(`<${itemTag}\\b[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'giu'))) {
      const row: RecordValue = {}
      for (const field of match[1].matchAll(/<([a-z][\w]*)\b[^>]*>([\s\S]*?)<\/\1>/giu)) row[field[1]] = decodeXml(field[2]).trim()
      rows.push(row)
      if (rows.length > MAX_ITEMS) throw invalid()
    }
  } else throw invalid()
  if (rows.length > MAX_ITEMS) throw invalid()
  const cameras = new Map<string, Cctv>()
  for (const row of rows) {
    const camera = normalizeUticCamera(row, secrets)
    if (camera) cameras.set(camera.id, camera)
  }
  if (!cameras.size) throw new CctvServiceError('UTIC에서 사용 가능한 CCTV 정보를 받지 못했습니다.', rows.length ? 'utic_invalid_response' : 'utic_empty_response', 502)
  return [...cameras.values()]
}

async function readBody(response: Response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw invalid() }
  const reader = response.body?.getReader()
  if (!reader) throw invalid()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > MAX_BYTES) { await reader.cancel(); throw invalid() }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const encoding = /(?:euc-kr|ks_c_5601)/iu.test(response.headers.get('content-type') ?? '') ? 'euc-kr' : 'utf-8'
  return new TextDecoder(encoding).decode(bytes)
}

export type UticOptions = { apiKey?: string; relayUrl?: string; relayToken?: string }
export class UticCctvProvider implements CctvProvider {
  readonly id = 'UTIC' as const
  private readonly fetchImplementation: typeof fetch
  constructor(private readonly options: UticOptions, fetchImplementation: typeof fetch = fetch) {
    this.fetchImplementation = fetchImplementation.bind(globalThis)
  }
  async fetchCctvs(): Promise<CctvBatch> {
    const { apiKey, relayUrl, relayToken } = this.options
    let url: URL
    const headers: Record<string, string> = { Accept: 'application/json, application/xml;q=0.9' }
    if (relayUrl) {
      try { url = new URL(relayUrl) } catch { throw new CctvServiceError('UTIC 연결 서버 설정을 확인해 주세요.', 'utic_relay_error', 503) }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !relayToken || relayToken.length < 32) {
        throw new CctvServiceError('UTIC 연결 서버 설정을 확인해 주세요.', 'utic_relay_error', 503)
      }
      headers.Authorization = `Bearer ${relayToken}`
    } else {
      if (!apiKey) throw new CctvServiceError('UTIC 인증 설정이 필요합니다.', 'configuration_error', 503)
      url = new URL(ENDPOINT)
      url.searchParams.set('key', apiKey)
    }
    try {
      const response = await this.fetchImplementation(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) })
      if (!response.ok) {
        if (relayUrl) {
          const body = await readBody(response)
          let code: unknown
          try { code = JSON.parse(body)?.error?.code } catch { /* No upstream diagnostics. */ }
          if (code === 'utic_ip_not_allowed') checkResult('04')
        } else await response.body?.cancel()
        throw new CctvServiceError('UTIC CCTV 서버 요청에 실패했습니다.', relayUrl ? 'utic_relay_error' : 'utic_connection_error', 503)
      }
      const body = await readBody(response)
      const cameras = parseUticCctvResponse(body, [apiKey ?? '', relayToken ?? ''])
      if (relayUrl) {
        let timestamp: unknown
        try { timestamp = JSON.parse(body)?.updatedAt } catch { throw invalid() }
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp > Date.now() + 5000 || Date.now() - timestamp >= 20 * 60 * 60_000) {
          throw new CctvServiceError('UTIC 연결 서버의 CCTV 정보를 갱신해야 합니다.', 'utic_relay_error', 503)
        }
        cameras.updatedAt = Math.min(timestamp, Date.now())
      }
      return cameras
    } catch (error) {
      if (error instanceof CctvServiceError) throw error
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
      throw new CctvServiceError(timeout ? 'UTIC CCTV 연결 시간이 초과되었습니다.' : 'UTIC CCTV 서버에 연결할 수 없습니다.', timeout ? 'utic_timeout' : 'utic_connection_error', timeout ? 504 : 503)
    }
  }
}
