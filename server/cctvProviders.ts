import { CctvServiceError, type CctvBatch, type CctvProvider, normalizeCctvIssues } from './cctvTypes.js'

/** A failed source must not hide the other source or force it to reload every retry. */
export class CombinedCctvProvider implements CctvProvider {
  readonly id = 'combined' as const
  private readonly sources
  constructor(providers: CctvProvider[], private readonly now = Date.now) {
    this.sources = providers.map((provider) => ({ provider, cached: undefined as CctvBatch | undefined, expiresAt: 0, failure: undefined as unknown }))
  }
  async fetchCctvs(): Promise<CctvBatch> {
    const groups = await Promise.allSettled(this.sources.map(async (source) => {
      if (this.now() < source.expiresAt) {
        if (source.failure) throw source.failure
        if (source.cached) return source.cached
      }
      try {
        source.cached = await source.provider.fetchCctvs()
        source.cached.updatedAt ??= this.now()
        source.failure = undefined
        source.expiresAt = source.cached.partial ? this.now() + 15 * 60_000 : source.cached.updatedAt + 20 * 60 * 60_000
        return source.cached
      } catch (error) {
        source.failure = error
        source.expiresAt = this.now() + 15 * 60_000
        throw error
      }
    }))
    const cameras = new Map<string, CctvBatch[number]>()
    const issues = groups.flatMap((group, index) => {
      if (group.status === 'fulfilled') {
        for (const camera of group.value) cameras.set(camera.id, camera)
        return group.value.issues ?? []
      }
      return normalizeCctvIssues([{ provider: this.sources[index].provider.id, code: group.reason instanceof CctvServiceError ? group.reason.type : 'cctv_service_error' }])
    })
    if (!cameras.size) {
      const failed = groups.find((group) => group.status === 'rejected')
      if (failed?.status === 'rejected' && failed.reason instanceof CctvServiceError) throw failed.reason
      throw new CctvServiceError('CCTV 정보를 준비할 수 없습니다.', 'cctv_service_error', 503)
    }
    const result = [...cameras.values()] as CctvBatch
    result.updatedAt = Math.min(...groups.flatMap((group) => group.status === 'fulfilled' ? [group.value.updatedAt ?? this.now()] : []))
    if (issues.length) result.issues = issues
    if (groups.some((group) => group.status === 'rejected' || group.value.partial)) result.partial = true
    return result
  }
}
