import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  CctvServiceError as NodeCctvServiceError,
  ItsCctvProvider as NodeItsCctvProvider,
  createProcessCctvService,
  findNearbyCctvs as findNearbyNodeCctvs,
  haversineDistanceMeters as nodeHaversineDistanceMeters,
  parseItsCctvResponse as parseNodeItsCctvResponse,
  parseNearbyCctvInput as parseNodeNearbyCctvInput,
  type Cctv as NodeCctv,
  type CctvProvider as NodeCctvProvider,
} from '../server/cctv.js'
import {
  CctvServiceError as WorkerCctvServiceError,
  ItsCctvProvider as WorkerItsCctvProvider,
  createCloudflareCctvService,
  findNearbyCctvs as findNearbyWorkerCctvs,
  handleNearbyCctvRequest as handleWorkerNearbyCctvRequest,
  haversineDistanceMeters as workerHaversineDistanceMeters,
  parseItsCctvResponse as parseWorkerItsCctvResponse,
  parseNearbyCctvInput as parseWorkerNearbyCctvInput,
  type Cctv as WorkerCctv,
  type CctvCache,
  type CctvProvider as WorkerCctvProvider,
} from '../functions/_cctv.js'

const JSON_FIXTURE = JSON.stringify({
  response: {
    coordtype: '1',
    datacount: 1,
    data: [
      {
        roadsectionid: 'road-001',
        filecreatetime: '20260905123000',
        cctvtype: '4',
        cctvurl: 'https://stream.example.test/live/token',
        cctvformat: 'HLS',
        cctvname: '테스트 교차로',
        coordx: '127.0000',
        coordy: '37.0000',
      },
    ],
  },
})

const XML_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <coordtype>1</coordtype>
  <datacount>1</datacount>
  <data>
    <roadsectionid>road-002</roadsectionid>
    <filecreatetime>20260905123100</filecreatetime>
    <cctvtype>4</cctvtype>
    <cctvurl><![CDATA[http://stream.example.test/live/two]]></cctvurl>
    <cctvformat>HLS</cctvformat>
    <cctvname>테스트 &amp; 도로</cctvname>
    <coordx>127.0100</coordx>
    <coordy>37.0100</coordy>
  </data>
</response>`

function nodeCctv(overrides: Partial<NodeCctv> = {}): NodeCctv {
  return {
    id: 'ITS:its:near',
    provider: 'ITS',
    providerId: 'near',
    name: '가까운 CCTV',
    latitude: 37,
    longitude: 127,
    streamUrl: 'https://stream.example.test/near',
    format: 'hls',
    roadType: 'its',
    ...overrides,
  }
}

function workerCctv(overrides: Partial<WorkerCctv> = {}): WorkerCctv {
  return {
    id: 'ITS:its:near',
    provider: 'ITS',
    providerId: 'near',
    name: '가까운 CCTV',
    latitude: 37,
    longitude: 127,
    streamUrl: 'https://stream.example.test/near',
    format: 'hls',
    roadType: 'its',
    ...overrides,
  }
}

class MemoryCache implements CctvCache {
  private readonly entries = new Map<string, Response>()

  async match(request: Request) {
    return this.entries.get(request.url)?.clone()
  }

  async put(request: Request, response: Response) {
    this.entries.set(request.url, response.clone())
  }
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('ITS response normalization', () => {
  test('normalizes defensive JSON and XML shapes identically in Node and Functions', () => {
    for (const [parse, ErrorType] of [
      [parseNodeItsCctvResponse, NodeCctvServiceError],
      [parseWorkerItsCctvResponse, WorkerCctvServiceError],
    ] as const) {
      const json = parse(JSON_FIXTURE, 'its')
      assert.equal(json.length, 1)
      assert.equal(json[0].provider, 'ITS')
      assert.equal(json[0].providerId, 'road-001:37.000000:127.000000')
      assert.equal(json[0].roadSectionId, 'road-001')
      assert.equal(json[0].format, 'hls')
      assert.equal(json[0].latitude, 37)
      assert.equal(json[0].longitude, 127)

      const xml = parse(XML_FIXTURE, 'ex')
      assert.equal(xml.length, 1)
      assert.equal(xml[0].name, '테스트 & 도로')
      assert.equal(xml[0].roadType, 'ex')
      assert.equal(xml[0].format, 'hls')
      assert.equal(xml[0].streamUrl, 'http://stream.example.test/live/two')

      const successXml = XML_FIXTURE.replace(
        '<coordtype>1</coordtype>',
        '<resultCode>SUCCESS</resultCode><coordtype>1</coordtype>',
      )
      assert.equal(parse(successXml, 'its').length, 1)

      assert.throws(
        () => parse('<response><resultCode>4005</resultCode></response>', 'its'),
        (error: unknown) => error instanceof ErrorType && error.type === 'its_api_error',
      )
    }
  })

  test('rejects a declared non-empty payload when no safe CCTV survives normalization', () => {
    const unsafe = JSON.stringify({
      datacount: 1,
      data: {
        coordx: '127',
        coordy: '37',
        cctvurl: 'javascript:alert(1)',
      },
    })
    assert.throws(() => parseNodeItsCctvResponse(unsafe, 'its'), /유효한 항목/u)
    assert.throws(() => parseWorkerItsCctvResponse(unsafe, 'its'), /유효한 항목/u)
  })

  test('rejects encoded API-key leaks and implausibly collapsed declared payloads', () => {
    const encodedSecret = JSON_FIXTURE.replace(
      'https://stream.example.test/live/token',
      'https://stream.example.test/live?token=test%252Dsecret&junk=%ZZ',
    )
    const collapsed = JSON.stringify({
      response: {
        datacount: 10_000,
        data: JSON.parse(JSON_FIXTURE).response.data,
      },
    })
    for (const parse of [parseNodeItsCctvResponse, parseWorkerItsCctvResponse]) {
      assert.throws(() => parse(encodedSecret, 'its', 'test-secret'), /유효한 항목/u)
      assert.throws(() => parse(collapsed, 'its'), /유효한 항목/u)
    }
  })
})

describe('ITS provider requests', () => {
  test('preserves the global receiver required by native Cloudflare fetch', async () => {
    const originalFetch = globalThis.fetch
    try {
      let calls = 0
      globalThis.fetch = async function (this: unknown) {
        if (this !== globalThis) throw new TypeError('Illegal invocation')
        calls++
        return new Response(JSON_FIXTURE)
      }
      for (const Provider of [NodeItsCctvProvider, WorkerItsCctvProvider] as const) {
        const cctvs = await new Provider('test-secret').fetchCctvs()
        assert.equal(cctvs.length, 2)
        assert.equal(cctvs.partial, undefined)
      }
      assert.equal(calls, 4)
    } finally { globalThis.fetch = originalFetch }
  })

  test('distinguishes timeout from connection failure without returning native diagnostics', async () => {
    for (const Provider of [NodeItsCctvProvider, WorkerItsCctvProvider] as const) {
      for (const [failure, type, status] of [
        [new DOMException('private-key or coordinates', 'TimeoutError'), 'its_timeout', 504],
        [new TypeError('private-key or coordinates'), 'its_connection_error', 503],
      ] as const) {
        const provider = new Provider('test-secret', async () => { throw failure })
        await assert.rejects(provider.fetchCctvs(), (error: unknown) => {
          assert.ok(error instanceof NodeCctvServiceError || error instanceof WorkerCctvServiceError)
          assert.equal(error.type, type)
          assert.equal(error.status, status)
          assert.doesNotMatch(error.message, /private-key|coordinates/)
          return true
        })
      }
    }
  })

  test('uses the official HTTPS HLS contract and keeps a partial road-type success', async () => {
    for (const Provider of [NodeItsCctvProvider, WorkerItsCctvProvider] as const) {
      const urls: URL[] = []
      const provider = new Provider('test-secret', (async (input) => {
        const url = new URL(String(input))
        urls.push(url)
        if (url.searchParams.get('type') === 'ex') {
          return new Response('temporary failure', { status: 503 })
        }
        return new Response(JSON_FIXTURE, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch)

      const cctvs = await provider.fetchCctvs()
      assert.equal(cctvs.length, 1)
      assert.equal(cctvs.partial, true)
      assert.equal(urls.length, 2)
      for (const url of urls) {
        assert.equal(url.origin, 'https://openapi.its.go.kr:9443')
        assert.equal(url.pathname, '/cctvInfo')
        assert.equal(url.searchParams.get('apiKey'), 'test-secret')
        assert.equal(url.searchParams.get('cctvType'), '4')
        assert.equal(url.searchParams.get('getType'), 'json')
        assert.ok(url.searchParams.has('minX'))
        assert.ok(url.searchParams.has('maxX'))
        assert.ok(url.searchParams.has('minY'))
        assert.ok(url.searchParams.has('maxY'))
      }
    }
  })

  test('treats an empty nationwide road-type response as partial coverage', async () => {
    const empty = JSON.stringify({ response: { datacount: 0, data: [] } })
    for (const Provider of [NodeItsCctvProvider, WorkerItsCctvProvider] as const) {
      const provider = new Provider('test-secret', (async (input) => {
        const url = new URL(String(input))
        return new Response(url.searchParams.get('type') === 'ex' ? empty : JSON_FIXTURE)
      }) as typeof fetch)
      const cctvs = await provider.fetchCctvs()
      assert.equal(cctvs.length, 1)
      assert.equal(cctvs.partial, true)
    }
  })
})

describe('nearby input and distance', () => {
  test('uses five results and five kilometres by default and validates bounds', () => {
    for (const parse of [parseNodeNearbyCctvInput, parseWorkerNearbyCctvInput]) {
      assert.deepEqual(parse({ lat: '37.5', lng: '127.1' }), {
        latitude: 37.5,
        longitude: 127.1,
        radiusKm: 5,
        limit: 5,
      })
      assert.throws(() => parse({ lat: 91, lng: 127 }), /latitude/u)
      assert.throws(() => parse({ lat: 37, lng: 127, limit: 1.5 }), /limit/u)
      assert.throws(() => parse({ lat: 37, lng: 127, radiusKm: 'wide' }), /radiusKm/u)
    }
  })

  test('sorts by Haversine distance and applies radius and limit', () => {
    const far = nodeCctv({ id: 'ITS:its:far', providerId: 'far', latitude: 37.02 })
    const near = nodeCctv({ id: 'ITS:its:near', providerId: 'near', latitude: 37.001 })
    const input = { latitude: 37, longitude: 127, radiusKm: 5, limit: 1 }
    assert.deepEqual(findNearbyNodeCctvs([far, near], input).map((item) => item.id), [near.id])
    assert.deepEqual(
      findNearbyWorkerCctvs([far as WorkerCctv, near as WorkerCctv], input).map((item) => item.id),
      [near.id],
    )
    assert.ok(Math.abs(nodeHaversineDistanceMeters(37, 127, 37.001, 127) - 111.2) < 1)
    assert.ok(Math.abs(workerHaversineDistanceMeters(37, 127, 37.001, 127) - 111.2) < 1)
  })
})

describe('process cache', () => {
  test('deduplicates in-flight refreshes and reuses a fresh snapshot', async () => {
    let calls = 0
    let resolveFetch!: (value: NodeCctv[]) => void
    const provider: NodeCctvProvider = {
      id: 'ITS',
      fetchCctvs: () => {
        calls += 1
        return new Promise<NodeCctv[]>((resolve) => {
          resolveFetch = resolve
        })
      },
    }
    const service = createProcessCctvService({ provider })
    const input = parseNodeNearbyCctvInput({ lat: 37, lng: 127 })
    const first = service.getNearby(input)
    const second = service.getNearby(input)
    assert.equal(calls, 1)
    resolveFetch([nodeCctv()])
    await Promise.all([first, second])
    await service.getNearby(input)
    assert.equal(calls, 1)
  })

  test('serves stale data, backs off failed refreshes, and never serves beyond the hard limit', async () => {
    let clock = 1
    let calls = 0
    let fail = false
    const provider: NodeCctvProvider = {
      id: 'ITS',
      async fetchCctvs() {
        calls += 1
        if (fail) throw new NodeCctvServiceError('safe failure', 'its_connection_error', 503)
        return [nodeCctv()]
      },
    }
    const service = createProcessCctvService({
      provider,
      now: () => clock,
      freshMilliseconds: 100,
      staleMilliseconds: 200,
      retryMilliseconds: 50,
    })
    const input = parseNodeNearbyCctvInput({ lat: 37, lng: 127 })
    await service.getNearby(input)
    fail = true
    clock = 121
    assert.equal((await service.getNearby(input)).cache.state, 'stale')
    await flushPromises()
    assert.equal(calls, 2)
    clock = 140
    assert.equal((await service.getNearby(input)).cache.state, 'stale')
    assert.equal(calls, 2)
    clock = 202
    await assert.rejects(() => service.getNearby(input), /safe failure/u)
    assert.equal(calls, 3)
  })

  test('does not treat a partial catalog as fresh for the full cache lifetime', async () => {
    let clock = 1
    let calls = 0
    const provider: NodeCctvProvider = {
      id: 'ITS',
      async fetchCctvs() {
        calls += 1
        const cctvs = [nodeCctv()] as NodeCctv[] & { partial?: boolean }
        if (calls === 1) Object.defineProperty(cctvs, 'partial', { value: true })
        return cctvs
      },
    }
    const service = createProcessCctvService({
      provider,
      now: () => clock,
      freshMilliseconds: 100,
      staleMilliseconds: 200,
      retryMilliseconds: 50,
    })
    const input = parseNodeNearbyCctvInput({ lat: 37, lng: 127 })
    assert.equal((await service.getNearby(input)).cache.state, 'stale')
    clock = 40
    assert.equal((await service.getNearby(input)).cache.state, 'stale')
    assert.equal(calls, 1)
    clock = 52
    assert.equal((await service.getNearby(input)).cache.state, 'stale')
    await flushPromises()
    assert.equal(calls, 2)
    assert.equal((await service.getNearby(input)).cache.state, 'fresh')
  })
})

describe('Cloudflare cache', () => {
  test('persists stale-refresh backoff in Cache API across service instances', async () => {
    const cache = new MemoryCache()
    let clock = 1
    let calls = 0
    let fail = false
    const provider: WorkerCctvProvider = {
      id: 'ITS',
      async fetchCctvs() {
        calls += 1
        if (fail) throw new WorkerCctvServiceError('safe failure', 'its_connection_error', 503)
        return [workerCctv()]
      },
    }
    const options = {
      provider,
      cache,
      now: () => clock,
      freshMilliseconds: 100,
      staleMilliseconds: 200,
      retryMilliseconds: 50,
    }
    const input = parseWorkerNearbyCctvInput({ lat: 37, lng: 127 })
    const firstService = createCloudflareCctvService(options)
    await firstService.getNearby(input)

    fail = true
    clock = 121
    const background: Promise<unknown>[] = []
    assert.equal(
      (await firstService.getNearby(input, (promise) => background.push(promise))).cache.state,
      'stale',
    )
    await Promise.all(background)
    assert.equal(calls, 2)

    clock = 140
    const nextIsolate = createCloudflareCctvService(options)
    assert.equal((await nextIsolate.getNearby(input)).cache.state, 'stale')
    await flushPromises()
    assert.equal(calls, 2)

    clock = 202
    await assert.rejects(() => nextIsolate.getNearby(input), /safe failure/u)
    assert.equal(calls, 3)
  })

  test('honours persisted retry backoff just beyond the hard-stale boundary', async () => {
    const cache = new MemoryCache()
    let clock = 1
    let calls = 0
    let fail = false
    const provider: WorkerCctvProvider = {
      id: 'ITS',
      async fetchCctvs() {
        calls += 1
        if (fail) throw new WorkerCctvServiceError('safe failure', 'its_connection_error', 503)
        return [workerCctv()]
      },
    }
    const options = {
      provider,
      cache,
      now: () => clock,
      freshMilliseconds: 100,
      staleMilliseconds: 200,
      retryMilliseconds: 50,
    }
    const input = parseWorkerNearbyCctvInput({ lat: 37, lng: 127 })
    const firstService = createCloudflareCctvService(options)
    await firstService.getNearby(input)

    fail = true
    clock = 190
    const background: Promise<unknown>[] = []
    await firstService.getNearby(input, (promise) => background.push(promise))
    await Promise.all(background)
    assert.equal(calls, 2)

    clock = 202
    const nextIsolate = createCloudflareCctvService(options)
    await assert.rejects(() => nextIsolate.getNearby(input), /새로 고칠 수 없습니다/u)
    assert.equal(calls, 2)

    clock = 241
    await assert.rejects(() => nextIsolate.getNearby(input), /safe failure/u)
    assert.equal(calls, 3)
  })

  test('returns a safe nested error contract without requiring Cache API when config is missing', async () => {
    const response = await handleWorkerNearbyCctvRequest({
      request: new Request('https://mira.test/api/cctv/nearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: 37, longitude: 127 }),
      }),
      env: {},
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: {
        code: 'configuration_error',
        message: 'ITS_API_KEY가 Cloudflare Pages Secret에 설정되지 않았습니다.',
      },
    })
  })

  test('keeps a same-isolate memory snapshot when Cache API writes fail', async () => {
    let calls = 0
    const provider: WorkerCctvProvider = {
      id: 'ITS',
      async fetchCctvs() {
        calls += 1
        return [workerCctv()]
      },
    }
    const cache: CctvCache = {
      async match() {
        return undefined
      },
      async put() {
        throw new Error('cache unavailable')
      },
    }
    const service = createCloudflareCctvService({ provider, cache })
    const input = parseWorkerNearbyCctvInput({ lat: 37, lng: 127 })
    await service.getNearby(input)
    await service.getNearby(input)
    assert.equal(calls, 1)
  })

  test('does not replace a newer memory snapshot with an older edge-cache entry', async () => {
    let clock = 121
    let calls = 0
    const oldSnapshot = {
      cctvs: [workerCctv({ id: 'ITS:its:old', providerId: 'old' })],
      updatedAt: 1,
    }
    const cache: CctvCache = {
      async match() {
        return Response.json(oldSnapshot)
      },
      async put() {
        throw new Error('cache unavailable')
      },
    }
    const provider: WorkerCctvProvider = {
      id: 'ITS',
      async fetchCctvs() {
        calls += 1
        return [workerCctv({ id: 'ITS:its:new', providerId: 'new' })]
      },
    }
    const service = createCloudflareCctvService({
      provider,
      cache,
      now: () => clock,
      freshMilliseconds: 100,
      staleMilliseconds: 200,
      retryMilliseconds: 50,
    })
    const input = parseWorkerNearbyCctvInput({ lat: 37, lng: 127 })
    const background: Promise<unknown>[] = []
    assert.equal(
      (await service.getNearby(input, (promise) => background.push(promise))).cache.state,
      'stale',
    )
    await Promise.all(background)
    clock = 122
    assert.equal((await service.getNearby(input)).cache.state, 'fresh')
    assert.equal(calls, 1)
  })

  test('deduplicates concurrent default-service initialization', async () => {
    const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
    const originalFetch = globalThis.fetch
    const cache = new MemoryCache()
    let calls = 0
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: { default: cache },
    })
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON_FIXTURE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const request = () =>
      handleWorkerNearbyCctvRequest({
        request: new Request('https://mira.test/api/cctv/nearby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latitude: 37, longitude: 127 }),
        }),
        env: { ITS_API_KEY: 'concurrent-initialization-test' },
      })

    try {
      const responses = await Promise.all([request(), request()])
      assert.deepEqual(responses.map((response) => response.status), [200, 200])
      assert.equal(calls, 2)
    } finally {
      globalThis.fetch = originalFetch
      if (cachesDescriptor) Object.defineProperty(globalThis, 'caches', cachesDescriptor)
      else Reflect.deleteProperty(globalThis, 'caches')
    }
  })
})
