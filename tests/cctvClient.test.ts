import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CctvClientError,
  fetchNearbyCctvs,
  getCurrentCoordinates,
  isExplicitCctvIntent,
  selectNearbyCctvs,
  formatCctvDistance,
  type NearbyCctv,
} from '../src/cctv.ts'

test('only explicit camera requests route to the CCTV feature', () => {
  assert.equal(isExplicitCctvIntent('주변 CCTV 보여줘'), true)
  assert.equal(isExplicitCctvIntent('고속도로 교통 카메라를 찾아줘'), true)
  assert.equal(isExplicitCctvIntent('실시간 도로 영상 볼 수 있어?'), true)
  assert.equal(isExplicitCctvIntent('서울 교통 상황이 어때?'), false)
  assert.equal(isExplicitCctvIntent('이번 주말 여행 일정 만들어줘'), false)
})

test('posts coordinates in the request body and normalizes a nearby CCTV response', async () => {
  const originalFetch = globalThis.fetch
  let request: Request | undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(new URL(String(input), 'http://localhost'), init)
    return new Response(JSON.stringify({
      cctvs: [{
        id: 'ITS:1',
        provider: 'ITS',
        name: '테스트 CCTV',
        latitude: 37.5,
        longitude: 127.0,
        distanceMeters: 1_200,
        streamUrl: 'https://example.com/live.m3u8',
        format: 'hls',
      }],
      cache: { status: 'cached' },
    }), { status: 200 })
  }

  try {
    const result = await fetchNearbyCctvs({ latitude: 37.5, longitude: 127.0 })
    assert.equal(request?.url.endsWith('/api/cctv/nearby'), true)
    assert.equal(request?.method, 'POST')
    assert.equal(request?.url.includes('latitude'), false)
    assert.deepEqual(await request?.json(), { latitude: 37.5, longitude: 127.0, radiusKm: 2, limit: 20 })
    assert.equal(result.cctvs[0]?.name, '테스트 CCTV')
    assert.equal(result.cache?.status, 'cached')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('keeps server distances, sorts ITS results and excludes the exact outside boundary', () => {
  const camera: NearbyCctv = {
    id: 'ITS:near', provider: 'ITS', providerId: 'near', name: '테스트 CCTV',
    latitude: 37.001, longitude: 127, distanceMeters: 110,
    streamUrl: 'https://example.test/live.m3u8', format: 'hls',
  }
  const boundaryLatitude = 37 + (2_000.1 / 6_371_000) * 180 / Math.PI
  const results = selectNearbyCctvs([
    { ...camera, id: 'far', latitude: 37.01, distanceMeters: 1_120 },
    { ...camera, id: 'outside', distanceMeters: 2_001 },
    { ...camera, id: 'rounded-outside', latitude: boundaryLatitude, distanceMeters: 2_000 },
    { ...camera, id: 'utic', provider: 'UTIC' },
    camera,
  ], { latitude: 37, longitude: 127 })
  assert.deepEqual(results.map(({ id, distanceMeters }) => [id, distanceMeters]), [['ITS:near', 110], ['far', 1_120]])
  assert.equal(selectNearbyCctvs(Array.from({ length: 25 }, (_, i) => ({ ...camera, id: `ITS:${i}` }))).length, 20)
  assert.equal(formatCctvDistance(320), '320m')
  assert.equal(formatCctvDistance(1_400), '1.4km')
  assert.equal(formatCctvDistance(1_000), '1.0km')
  assert.equal(formatCctvDistance(0), '0m')
})

test('never exposes upstream error diagnostics in persisted chat text', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ error: { code: 'request_failed', message: '37.123456 127.123456 key=private-value' } }, { status: 500 })
  try {
    await assert.rejects(fetchNearbyCctvs({ latitude: 37, longitude: 127 }), (error: unknown) => {
      assert.ok(error instanceof CctvClientError)
      assert.equal(error.message, '주변 CCTV를 불러오지 못했습니다.')
      return true
    })
  } finally { globalThis.fetch = originalFetch }
})

test('surfaces a structured CCTV API failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'service_unavailable', message: 'ITS API key is unavailable.' },
  }), { status: 503 })

  try {
    await assert.rejects(
      fetchNearbyCctvs({ latitude: 37.5, longitude: 127.0 }),
      (error: unknown) => {
        assert.ok(error instanceof CctvClientError)
        assert.equal(error.code, 'service_unavailable')
        assert.equal(error.status, 503)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('turns denied browser geolocation into a recoverable UI error', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      geolocation: {
        getCurrentPosition(
          _success: PositionCallback,
          failure: PositionErrorCallback,
        ) {
          failure({
            code: 1,
            message: 'denied',
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError)
        },
      },
    },
  })

  try {
    await assert.rejects(getCurrentCoordinates(), (error: unknown) => {
      assert.ok(error instanceof CctvClientError)
      assert.equal(error.code, 'location_denied')
      assert.match(error.message, /위치 권한/)
      return true
    })
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else delete (globalThis as { navigator?: Navigator }).navigator
  }
})
