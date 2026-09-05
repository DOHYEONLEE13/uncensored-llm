import assert from 'node:assert/strict'
import test from 'node:test'
import { createCctvMapScene, loadMapProvider, MapProviderError } from '../src/mapProvider.ts'
import { cctvDistanceMeters } from '../src/cctv.ts'

test('constructs a closed 2000m geodesic ring and a direct connection per in-range CCTV', () => {
  const coordinates = { latitude: 37.5, longitude: 127 }
  const scene = createCctvMapScene(coordinates, [{
    id: 'ITS:one', provider: 'ITS', providerId: 'one', name: '테스트 CCTV',
    latitude: 37.501, longitude: 127, distanceMeters: 111,
    streamUrl: 'https://example.test/live.m3u8', format: 'hls',
  }])
  assert.equal(scene.radiusMeters, 2_000)
  assert.deepEqual(scene.center, [127, 37.5])
  assert.equal(scene.boundary.coordinates.length, 129)
  assert.deepEqual(scene.boundary.coordinates[0], scene.boundary.coordinates.at(-1))
  for (const [longitude, latitude] of scene.boundary.coordinates) {
    assert.ok(Math.abs(cctvDistanceMeters(coordinates, { latitude, longitude }) - 2_000) < 0.001)
  }
  assert.deepEqual(scene.connections, [{ id: 'ITS:one', distanceMeters: 111, geometry: { type: 'LineString', coordinates: [[127, 37.5], [127, 37.501]] } }])
})

test('has no fabricated provider or map when configuration is absent', async () => {
  await assert.rejects(loadMapProvider(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof MapProviderError)
    assert.equal(error.code, 'not_configured')
    return true
  })
})
