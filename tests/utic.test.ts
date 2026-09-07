import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { normalizeUticCamera, parseUticCctvResponse, UticCctvProvider } from '../server/utic.js'
import { CombinedCctvProvider } from '../server/cctvProviders.js'
import { CctvServiceError, type Cctv, type CctvProvider } from '../server/cctvTypes.js'
import { createProcessCctvService } from '../server/cctv.js'
import { createCloudflareCctvService, handleNearbyCctvRequest, type CctvCache } from '../functions/_cctv.js'
import { handleUticCatalog } from '../server/uticRelay.js'

// Synthetic contracts. The approved API's success schema still needs a live approved-IP check.
const row = { CCTVID: 'CITY-1', CCTVNAME: '강남대로 교차로', XCOORD: '127.01', YCOORD: '37.50', CCTVURL: 'https://stream.example.test/city.m3u8' }
const fixture = JSON.stringify([row])
const camera = () => parseUticCctvResponse(fixture)[0]
const input = { latitude: 37.5, longitude: 127.01, radiusKm: 2, limit: 20 }
class MemoryCache implements CctvCache {
  values = new Map<string, Response>()
  async match(request: Request) { return this.values.get(request.url)?.clone() }
  async put(request: Request, response: Response) { this.values.set(request.url, response.clone()) }
}

test('UTIC parses candidate JSON/XML contracts, including nested rows and duplicates', () => {
  const list = parseUticCctvResponse(JSON.stringify({ response: { data: [row, row] } }))
  assert.equal(list.length, 1)
  assert.deepEqual(list[0], { id: 'UTIC:CITY-1', provider: 'UTIC', providerId: 'CITY-1', name: row.CCTVNAME, latitude: 37.5, longitude: 127.01, streamUrl: row.CCTVURL, format: 'hls', roadType: 'urban' })
  const xml = `<response><data><item><cctvid>A</cctvid><cctvname>도로 &amp; 교차로</cctvname><xcoord>127</xcoord><ycoord>37</ycoord><cctvurl><![CDATA[https://media.example.test/a.mp4]]></cctvurl></item><item><cctvid>B</cctvid><cctvname>다른 도로</cctvname><xcoord>128</xcoord><ycoord>38</ycoord></item></data></response>`
  const parsed = parseUticCctvResponse(xml)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].name, '도로 & 교차로')
  assert.equal(parsed[0].format, 'mp4')
  assert.equal(parsed[1].format, 'unavailable')
})

test('UTIC recognizes the observed HTTP200/IP-denial response without echoing diagnostics', () => {
  assert.throws(() => parseUticCctvResponse('[{"resultCode":"04","resultMsg":"허용된 IP가 아닙니다. private-value"}]'), (error: unknown) => {
    assert.ok(error instanceof CctvServiceError)
    assert.equal(error.type, 'utic_ip_not_allowed')
    assert.equal(error.status, 503)
    assert.doesNotMatch(error.message, /private-value/)
    return true
  })
  for (const body of ['<html>error</html>', '{broken', '<!DOCTYPE x><data/>', '[]']) assert.throws(() => parseUticCctvResponse(body))
})

test('UTIC never sends keys, camera passwords, or unknown player URLs to the browser', () => {
  const secret = 'private-utic-key'
  for (const url of [
    `https://www.utic.go.kr/jsp/map/openDataCctvStream.jsp?cctvid=A&key=${secret}`,
    `https://media.example.test/a.m3u8?token=${encodeURIComponent(encodeURIComponent(secret))}`,
    'https://media.example.test/a.m3u8?cctvpasswd=private',
    'https://user:pass@media.example.test/a.m3u8',
    'javascript:alert(1)', 'https://media.example.test/legacy.jsp',
  ]) {
    const value = normalizeUticCamera({ ...row, CCTVURL: url }, [secret])!
    assert.equal(value.format, 'unavailable')
    assert.equal(value.streamUrl, '')
    assert.doesNotMatch(JSON.stringify(value), /private|passwd/)
  }
  assert.equal(normalizeUticCamera({ ...row, CCTVNAME: 'a'.repeat(198) + secret }, [secret]), undefined)
  const legacy = normalizeUticCamera({ ...row, CCTVURL: undefined, CCTVIP: '10.0.0.1', ID: 'admin', PASSWD: secret })!
  assert.equal(legacy.format, 'unavailable')
  assert.doesNotMatch(JSON.stringify(legacy), /admin|private|10\.0\.0\.1/)
})

test('UTIC uses the HTTPS approved endpoint with bound fetch, and never follows key-bearing redirects', async () => {
  const provider = new UticCctvProvider({ apiKey: 'test-key' }, async function (url, options) {
    assert.equal(this, globalThis)
    assert.equal(new URL(String(url)).origin, 'https://www.utic.go.kr')
    assert.equal(new URL(String(url)).searchParams.get('key'), 'test-key')
    assert.equal(options?.redirect, 'manual')
    return new Response(fixture)
  } as typeof fetch)
  assert.equal((await provider.fetchCctvs()).length, 1)
  let calls = 0
  const redirect = new UticCctvProvider({ apiKey: 'test-key' }, (async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://other.example.test/' } }) }) as typeof fetch)
  await assert.rejects(redirect.fetchCctvs(), /UTIC/)
  assert.equal(calls, 1)
})

test('UTIC bounds response size and distinguishes safe timeout errors', async () => {
  const oversized = new UticCctvProvider({ apiKey: 'test-key' }, (async () => new Response('large', { headers: { 'content-length': '30000001' } })) as typeof fetch)
  await assert.rejects(oversized.fetchCctvs(), (error: unknown) => error instanceof CctvServiceError && error.type === 'utic_invalid_response')
  const timeout = new UticCctvProvider({ apiKey: 'test-key' }, (async () => { throw new DOMException('key=private', 'TimeoutError') }) as typeof fetch)
  await assert.rejects(timeout.fetchCctvs(), (error: unknown) => error instanceof CctvServiceError && error.status === 504 && !error.message.includes('private'))
})

test('combined source failure keeps ITS results, announces UTIC failure, and backs off', async () => {
  let calls = 0
  const its: CctvProvider = { id: 'ITS', async fetchCctvs() { return [{ ...camera(), id: 'ITS:A', provider: 'ITS' }] } }
  const utic: CctvProvider = { id: 'UTIC', async fetchCctvs() { calls++; throw new CctvServiceError('safe', 'utic_ip_not_allowed', 503) } }
  const provider = new CombinedCctvProvider([its, utic])
  const result = await provider.fetchCctvs()
  assert.equal(result.length, 1)
  assert.equal(result.partial, true)
  assert.deepEqual(result.issues, [{ provider: 'UTIC', code: 'utic_ip_not_allowed' }])
  await provider.fetchCctvs()
  assert.equal(calls, 1)
})

test('source recovery cannot reset the age of another provider in Node or edge cache', async () => {
  for (const edge of [false, true]) {
    let now = Date.now()
    const started = now
    let itsCalls = 0
    let recovered = false
    const provider = new CombinedCctvProvider([
      { id: 'ITS', async fetchCctvs() { itsCalls++; return [{ ...camera(), id: 'ITS:A', provider: 'ITS' }] } },
      { id: 'UTIC', async fetchCctvs() { if (!recovered) throw new CctvServiceError('safe', 'utic_ip_not_allowed', 503); return [camera()] } },
    ], () => now)
    const service = edge ? createCloudflareCctvService({ provider, cache: new MemoryCache(), now: () => now }) : createProcessCctvService({ provider, now: () => now })
    await service.getNearby(input)
    recovered = true
    now = started + 19 * 60 * 60_000
    await service.getNearby(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const recoveredResult = await service.getNearby(input)
    assert.equal(recoveredResult.cctvs.length, 2)
    assert.equal(recoveredResult.cache.updatedAt, started)
    now = started + 21 * 60 * 60_000
    await service.getNearby(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(itsCalls, 2)
  }
})

test('UTIC survives persisted edge cache and matches road names without requiring ITS', async () => {
  const cache = new MemoryCache()
  let calls = 0
  const provider: CctvProvider = { id: 'UTIC', async fetchCctvs() { calls++; return [camera(), { ...camera(), id: 'UTIC:B', providerId: 'B', format: 'unavailable', streamUrl: '' }] } }
  const first = createCloudflareCctvService({ provider, cache })
  assert.equal((await first.search({ query: '강남대로', limit: 20 })).total, 2)
  const second = createCloudflareCctvService({ provider, cache })
  const result = await second.getNearby(input)
  assert.equal(result.cctvs.length, 2)
  assert.equal(result.cctvs.find((value) => value.id === 'UTIC:B')?.format, 'unavailable')
  assert.equal(calls, 1)
})

test('relay uses only its Bearer token and preserves the original metadata timestamp', async () => {
  const timestamp = Date.now() - 3600_000
  const token = 'relay-test-token-'.repeat(3)
  const provider = new UticCctvProvider({ relayUrl: 'https://relay.example.test/api/cctv/utic-catalog', relayToken: token }, (async (url, options) => {
    assert.equal(new URL(String(url)).search, '')
    assert.equal(new Headers(options?.headers).get('authorization'), `Bearer ${token}`)
    return Response.json({ cctvs: [camera()], updatedAt: timestamp })
  }) as typeof fetch)
  const result = await provider.fetchCctvs()
  assert.equal(result.updatedAt, timestamp)
  assert.equal(result[0].id, 'UTIC:CITY-1')
  const stale = new UticCctvProvider({ relayUrl: 'https://relay.example.test/catalog', relayToken: token }, (async () => Response.json({ cctvs: [camera()], updatedAt: Date.now() - 21 * 3600_000 })) as typeof fetch)
  await assert.rejects(stale.fetchCctvs(), (error: unknown) => error instanceof CctvServiceError && error.type === 'utic_relay_error')
})

test('fresh relay catalog requests still respect upstream failure backoff', async () => {
  let now = 1000
  let calls = 0
  const service = createProcessCctvService({ now: () => now, freshMilliseconds: 100, staleMilliseconds: 1000, retryMilliseconds: 200,
    provider: { id: 'UTIC', async fetchCctvs() { calls++; if (calls > 1) throw new CctvServiceError('safe', 'utic_ip_not_allowed', 503); return [camera()] } } })
  await service.getCatalog({ fresh: true })
  now += 101
  await assert.rejects(service.getCatalog({ fresh: true }))
  await assert.rejects(service.getCatalog({ fresh: true }))
  assert.equal(calls, 2)
})

test('edge configuration enables UTIC alone and isolates catalogs after key changes', async () => {
  const originalFetch = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: new MemoryCache() } })
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(fixture) }) as typeof fetch
  try {
    const request = (key: string) => handleNearbyCctvRequest({ env: { UTIC_API_KEY: key }, request: new Request('https://mira.test/api/cctv/search', { method: 'POST', body: JSON.stringify({ query: '강남대로' }) }) }, 'search')
    for (const key of ['utic-test-1', 'utic-test-1', 'utic-test-2']) {
      const response = await request(key)
      assert.equal(response.status, 200)
      const payload = await response.json() as { cctvs: Cctv[] }
      assert.equal(payload.cctvs[0].provider, 'UTIC')
    }
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    if (descriptor) Object.defineProperty(globalThis, 'caches', descriptor)
    else Reflect.deleteProperty(globalThis, 'caches')
  }
})

test('approved-IP relay requires authentication before fetching and returns no credentials', async () => {
  const originalFetch = globalThis.fetch
  const previousKey = process.env.UTIC_API_KEY
  const previousToken = process.env.UTIC_RELAY_TOKEN
  process.env.UTIC_API_KEY = 'relay-fixture-key'
  process.env.UTIC_RELAY_TOKEN = 'relay-fixture-token-'.repeat(3)
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response(fixture) }) as typeof fetch
  const server = createServer((request, response) => { void handleUticCatalog(request, response) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/api/cctv/utic-catalog`
  try {
    assert.equal((await originalFetch(url)).status, 401)
    assert.equal(calls, 0)
    const response = await originalFetch(url, { headers: { Authorization: `Bearer ${process.env.UTIC_RELAY_TOKEN}` } })
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.doesNotMatch(body, /relay-fixture/)
    assert.equal(calls, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.UTIC_API_KEY; else process.env.UTIC_API_KEY = previousKey
    if (previousToken === undefined) delete process.env.UTIC_RELAY_TOKEN; else process.env.UTIC_RELAY_TOKEN = previousToken
  }
})
