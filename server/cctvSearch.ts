// Shared by Node and Pages; only text matching, with no runtime or API dependencies.
export type CctvSearchInput = { query: string; limit: number }

export function parseCctvSearchInput(value: unknown): CctvSearchInput {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const query = typeof input.query === 'string' ? input.query.normalize('NFKC').trim().replace(/\s+/gu, ' ') : ''
  const limit = input.limit ?? 20
  if (query.length < 2 || query.length > 80 || !/[\p{L}\p{N}]/u.test(query) ||
    /[\u0000-\u001f\u007f]/u.test(query) || typeof limit !== 'number' ||
    !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('invalid_cctv_search')
  }
  return { query, limit }
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]/gu, '')

export function searchCctvs<T extends { id: string; name: string; roadName?: string }>(
  cctvs: readonly T[], { query, limit }: CctvSearchInput,
) {
  const terms = [normalize(query)]
  // ITS often labels expressways as e.g. 경부선 rather than 경부고속도로.
  if (/고속도로/u.test(query)) terms.push(normalize(query.replace(/고속도로/gu, '선')))
  const score = (camera: T) => {
    const names = [normalize(camera.name), normalize(camera.roadName ?? '')]
    if (names.some((name) => terms.includes(name))) return 0
    return names.some((name) => terms.some((term) => name.includes(term))) ? 1 : 2
  }
  const matches = cctvs.map((camera) => ({ camera, score: score(camera) }))
    .filter(({ score }) => score < 2)
    .sort((a, b) => a.score - b.score || a.camera.name.localeCompare(b.camera.name, 'ko') || a.camera.id.localeCompare(b.camera.id))
  return { cctvs: matches.slice(0, limit).map(({ camera }) => camera), total: matches.length, query }
}
