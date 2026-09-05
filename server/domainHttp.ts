import { createDomainService, DomainError } from './domainAnalysis.js'
import type { DomainKeys } from './domainTypes.js'

export function createDomainHandler(options: Parameters<typeof createDomainService>[0] = {}) {
  const service = createDomainService(options)
  const recent = new Map<string, { count: number; until: number }>()
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 405 ? { Allow: 'POST' } : {}), ...(status === 429 ? { 'Retry-After': '60' } : {}),
  } })
  return async (request: Request, client = 'anonymous') => {
    if (request.method !== 'POST') return respond({ error: 'POST 요청만 지원합니다.' }, 405)
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return respond({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' }, 403)
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return respond({ error: 'JSON 요청이 필요합니다.' }, 415)
    try {
      if (Number(request.headers.get('content-length')) > 4096) throw new DomainError('요청 크기가 너무 큽니다.', 413)
      const reader = request.body?.getReader()
      let body = ''
      let size = 0
      const decoder = new TextDecoder()
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > 4096) throw new DomainError('요청 크기가 너무 큽니다.', 413)
            body += decoder.decode(chunk.value, { stream: true })
          }
          body += decoder.decode()
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      }
      let payload: unknown
      try { payload = JSON.parse(body) } catch { throw new DomainError('올바른 JSON 요청이 아닙니다.') }
      if (!payload || typeof payload !== 'object' || !('domain' in payload)) throw new DomainError('도메인을 입력해 주세요.')
      const now = Date.now()
      const previous = recent.get(client)
      if (previous && previous.until > now && previous.count >= 12) throw new DomainError('잠시 후 다시 분석해 주세요. 분당 최대 12회 조회할 수 있습니다.', 429)
      if (recent.size >= 1000) recent.delete(recent.keys().next().value!)
      recent.set(client, previous && previous.until > now ? { ...previous, count: previous.count + 1 } : { count: 1, until: now + 60_000 })
      return respond(await service.analyze(payload.domain))
    } catch (error) {
      return respond({ error: error instanceof DomainError ? error.message : '도메인 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.' }, error instanceof DomainError ? error.status : 503)
    }
  }
}

export function readDomainKeys(env: DomainKeys): DomainKeys {
  return Object.fromEntries(['URLSCAN_API_KEY', 'SECURITYTRAILS_API_KEY', 'BUILTWITH_API_KEY', 'VIRUSTOTAL_API_KEY'].map((key) => [key, env[key as keyof DomainKeys]?.trim() || undefined]))
}
