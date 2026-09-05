import type { DomainKeys, DomainReport, DomainSource, DomainSourceId } from './domainTypes.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown, limit = 300): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : ''
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const date = (value: unknown): string | undefined => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.isFinite(Date.parse(value)) ? value : undefined
  // CT timestamps without an offset are UTC, including in the local Node server.
  const candidate = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value) : ''
  const time = candidate === '' ? NaN : new Date(candidate).getTime()
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined
}

export class DomainError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function normalizeDomain(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new DomainError('분석할 도메인을 입력해 주세요.')
  const raw = input.trim()
  if (/[\s\\\u0000-\u001f]/u.test(raw)) throw new DomainError('공백 없이 올바른 도메인을 입력해 주세요.')
  let url: URL
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`) }
  catch { throw new DomainError('도메인 형식을 확인해 주세요. 예: example.com') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const labels = host.split('.')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
    || host.length > 253 || labels.length < 2
    || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)!)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|arpa)$/.test(host)) {
    throw new DomainError('포트나 로그인 정보가 없는 공개 도메인을 입력해 주세요.')
  }
  return host
}

function domainName(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[/:@?#\s]/.test(value)) return undefined
  try { return normalizeDomain(value.replace(/^\*\./, '')) } catch { return undefined }
}

const FIXED_ORIGINS = new Set([
  'https://dns.google', 'https://data.iana.org', 'https://crt.sh', 'https://archive.org',
  'https://urlscan.io', 'https://api.securitytrails.com', 'https://api.builtwith.com', 'https://www.virustotal.com',
])

class ProviderError extends Error {
  constructor(readonly reason: 'limited' | 'timeout' | 'missing' | 'failed' | 'too_large') { super(reason) }
}

// Requests can only reach fixed providers or HTTPS registries listed by IANA.
// Target domains and URLs returned by scanned pages are never fetched.
export function createDomainService(options: { keys?: DomainKeys; fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis)
  const keys = options.keys ?? {}
  const now = options.now ?? Date.now
  const cache = new Map<string, { report: DomainReport; expires: number }>()
  const inFlight = new Map<string, Promise<DomainReport>>()
  let bootstrap: { services: unknown[]; expires: number } | undefined
  let bootstrapPromise: Promise<unknown[]> | undefined
  let connections = 0
  const queue: (() => void)[] = []

  async function json(url: string, signal: AbortSignal, headers: Record<string, string> = {}, registryOrigin?: string, maxBytes = 2_000_000): Promise<unknown> {
    const parsed = new URL(url)
    if ((!FIXED_ORIGINS.has(parsed.origin) && parsed.origin !== registryOrigin) || parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new ProviderError('failed')
    if (connections >= 4) await new Promise<void>((resolve) => queue.push(resolve))
    connections++
    const timer = new AbortController()
    const abort = () => timer.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) timer.abort()
    const timeout = setTimeout(abort, options.timeoutMs ?? 7000)
    try {
      const response = await fetcher(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'manual', signal: timer.signal })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new ProviderError(response.status === 404 ? 'missing' : [401, 403, 429].includes(response.status) ? 'limited' : 'failed')
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw new ProviderError('too_large')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new ProviderError('failed')
      let bytes = 0
      let body = ''
      const decoder = new TextDecoder()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.byteLength
          if (bytes > maxBytes) throw new ProviderError('too_large')
          body += decoder.decode(next.value, { stream: true })
        }
        body += decoder.decode()
        return JSON.parse(body) as unknown
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    } catch (error) {
      if (timer.signal.aborted) throw new ProviderError('timeout')
      if (error instanceof ProviderError) throw error
      throw new ProviderError('failed')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      connections--
      queue.shift()?.()
    }
  }

  async function getBootstrap(signal: AbortSignal) {
    if (bootstrap && bootstrap.expires > now()) return bootstrap.services
    if (bootstrapPromise) return bootstrapPromise
    bootstrapPromise = json('https://data.iana.org/rdap/dns.json', signal).then((payload) => {
      const services = array(object(payload).services)
      if (!services.length) throw new ProviderError('failed')
      bootstrap = { services, expires: now() + 86_400_000 }
      return services
    }).finally(() => { bootstrapPromise = undefined })
    return bootstrapPromise
  }

  async function collect(domain: string): Promise<DomainReport> {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 25_000)
    const signal = controller.signal
    const report: DomainReport = { version: 1, domain, queriedAt: new Date(now()).toISOString(), cacheHit: false, sources: [], facts: [], dns: [], findings: [], connections: [], timeline: [] }
    const source = async (id: DomainSourceId, label: string, url: string, task: (entry: DomainSource) => Promise<void>, key?: { value?: string; name: string }) => {
      const entry: DomainSource = { id, label, url, status: 'ok', message: '조회 완료' }
      report.sources.push(entry)
      if (key && !key.value) { entry.status = 'not_configured'; entry.message = `${key.name} 연결 후 조회할 수 있습니다.`; return }
      try { await task(entry) }
      catch (error) {
        entry.status = error instanceof ProviderError && error.reason === 'missing' ? 'empty' : 'unavailable'
        entry.message = error instanceof ProviderError ? {
          limited: '제공자가 접근 또는 조회 횟수를 제한했습니다.', timeout: '조회 시간이 초과되었습니다.', missing: '제공자에서 기록을 찾지 못했습니다.',
          too_large: '기록이 너무 커서 이번 조회에 포함하지 못했습니다.', failed: '제공자에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        }[error.reason] : '이 기록을 해석하지 못했습니다.'
      }
    }
    const fact = (label: string, value: unknown, sourceId: DomainSourceId, inferred = false) => {
      const safeValue = text(value, 500)
      if (safeValue) report.facts.push({ label, value: safeValue, sourceId, ...(inferred ? { inferred } : {}) })
    }
    const event = (value: unknown, label: string, detail: string, sourceId: DomainSourceId, url?: string) => {
      const timestamp = date(value)
      if (timestamp) report.timeline.push({ date: timestamp, label, detail: text(detail), sourceId, ...(url ? { url } : {}) })
    }
    try {
      await Promise.all([
        source('dns', 'Google Public DNS', `https://dns.google/query?name=${domain}`, async (entry) => {
          const requests = [['A', domain], ['AAAA', domain], ['MX', domain], ['NS', domain], ['TXT', domain], ['CAA', domain], ['TXT', `_dmarc.${domain}`]]
          const answers = await Promise.allSettled(requests.map(async ([type, name]) => {
            const payload = object(await json(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}&do=1`, signal))
            if (![0, 3].includes(Number(payload.Status))) throw new ProviderError('failed')
            return { type, name, payload }
          }))
          const typeNames: Record<number, string> = { 1: 'A', 5: 'CNAME', 16: 'TXT', 28: 'AAAA', 15: 'MX', 2: 'NS', 257: 'CAA' }
          let failed = 0
          for (const result of answers) {
            if (result.status !== 'fulfilled') { failed++; continue }
            const { type, name, payload } = result.value
            for (const item of array(payload.Answer).slice(0, 40)) {
              const answer = object(item)
              const record = { type: typeNames[Number(answer.type)] ?? type, name: text(answer.name), value: text(answer.data, 1000), ttl: Math.max(0, number(answer.TTL) ?? 0) }
              if (!report.dns.some((row) => row.name === record.name && row.type === record.type && row.value === record.value)) report.dns.push(record)
            }
            if (type === 'A') {
              if (payload.Status === 3) fact('DNS 응답', '존재하지 않는 이름(NXDOMAIN)', 'dns')
              fact('DNSSEC 검증', payload.AD === true ? '리졸버가 인증된 응답(AD)을 반환함' : '인증된 응답(AD) 확인 안 됨', 'dns')
            }
            if (type === 'TXT' && name.startsWith('_dmarc.') && payload.Status === 0) {
              const policy = array(payload.Answer).map((item) => text(object(item).data)).find((value) => /v=DMARC1/i.test(value))
              report.findings.push({ id: 'dmarc', title: policy ? 'DMARC 게시 기록 확인' : 'DMARC 게시 기록 확인 안 됨', detail: '이 호스트에서 조회한 공개 이메일 정책입니다. 상위 도메인의 정책 적용 여부와 실제 메일 발송 설정은 별도 확인이 필요합니다.', evidence: policy ?? `${name} TXT 응답에 DMARC 정책 없음`, level: 'notice', sourceId: 'dns', measurements: { published: Boolean(policy) } })
            }
          }
          if (failed === requests.length) throw new ProviderError('failed')
          if (failed) { entry.status = 'unavailable'; entry.message = `일부 DNS 조회 실패 (${failed}/${requests.length}). 수집된 응답만 표시합니다.` }
          else if (!report.dns.length) { entry.status = 'empty'; entry.message = '공개 DNS 레코드가 확인되지 않았습니다.' }
          const txt = report.dns.filter((item) => item.type === 'TXT' && !item.name.startsWith('_dmarc.'))
          if (txt.some((item) => /google-site-verification=/i.test(item.value))) fact('서비스 연결 단서', 'Google 도메인 인증 레코드 — 현재 사용 여부는 확인 불가', 'dns', true)
          if (txt.some((item) => /MS=ms\d+/i.test(item.value))) fact('서비스 연결 단서', 'Microsoft 도메인 인증 레코드 — 현재 사용 여부는 확인 불가', 'dns', true)
          const spf = txt.find((item) => /v=spf1/i.test(item.value))
          if (spf) fact('SPF 이메일 정책', spf.value, 'dns')
        }),
        source('rdap', 'IANA · RDAP', `https://lookup.icann.org/en/lookup?name=${domain}`, async (entry) => {
          const services = await getBootstrap(signal)
          const service = services.find((item) => array(array(item)[0]).includes(domain.split('.').at(-1)))
          const bases = array(array(service)[1])
          const base = bases.find((value) => {
            if (typeof value !== 'string') return false
            try { const url = new URL(value); return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && Boolean(domainName(url.hostname)) } catch { return false }
          }) as string | undefined
          if (!base) { entry.status = 'unavailable'; entry.message = '이 최상위 도메인의 HTTPS RDAP 제공자가 IANA 목록에 없습니다.'; return }
          const labels = domain.split('.')
          let payload: Json = {}
          let registered = domain
          // Registries, not a guessed suffix rule, decide whether a name is registered.
          for (let attempt = 0; attempt < Math.min(labels.length - 1, 4); attempt++) {
            registered = labels.slice(attempt).join('.')
            const url = new URL(`domain/${registered}`, base.endsWith('/') ? base : `${base}/`)
            try { payload = object(await json(url.href, signal, {}, new URL(base).origin)); break }
            catch (error) { if (!(error instanceof ProviderError) || error.reason !== 'missing' || attempt === Math.min(labels.length - 1, 4) - 1) throw error }
          }
          if (domainName(text(payload.ldhName).toLowerCase()) !== registered) throw new ProviderError('failed')
          fact('등록 도메인', registered, 'rdap')
          fact('등록 상태', array(payload.status).map((item) => text(item)).join(' · '), 'rdap')
          for (const item of array(payload.entities)) {
            const entity = object(item)
            if (!array(entity.roles).includes('registrar')) continue
            const name = array(array(entity.vcardArray)[1]).find((row) => array(row)[0] === 'fn')
            fact('등록 대행사', array(name)[3], 'rdap')
          }
          const labelsByAction: Record<string, string> = { registration: '도메인 등록', expiration: '등록 만료 예정', 'last changed': '등록정보 변경' }
          for (const item of array(payload.events)) {
            const data = object(item)
            const label = Object.hasOwn(labelsByAction, text(data.eventAction)) ? labelsByAction[text(data.eventAction)] : undefined
            if (label) event(data.eventDate, label, registered, 'rdap', entry.url)
          }
          entry.message = registered === domain ? '등록정보 조회 완료 · 비공개 소유자 정보는 수집하지 않습니다.' : `${registered} 등록정보입니다. 입력한 하위 도메인의 생성일과 다릅니다.`
        }),
        source('certificates', 'Certificate Transparency · crt.sh', `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}`, async (entry) => {
          const payload = await json(`https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, signal)
          if (!Array.isArray(payload)) throw new ProviderError('failed')
          const seen = new Set<string>()
          for (const item of payload.slice(0, 2500)) {
            const cert = object(item)
            for (const name of text(cert.name_value, 4000).split(/\s+/)) {
              const host = domainName(name)
              const wildcard = name.startsWith('*.')
              const certificateName = wildcard ? `*.${host}` : host
              if (!host || (host === domain && !wildcard) || (host !== domain && !host.endsWith(`.${domain}`)) || seen.has(certificateName!) || seen.size >= 60) continue
              seen.add(certificateName!)
              report.connections.push({ domain: certificateName!, kind: 'certificate', evidence: wildcard ? '인증서의 와일드카드 패턴 · 개별 호스트의 존재나 운영을 뜻하지 않습니다.' : '공개 인증서에 포함된 이름 · 현재 운영 여부 미확인', sourceId: 'certificates', observedAt: date(cert.entry_timestamp) })
            }
          }
          if (!payload.length) { entry.status = 'empty'; entry.message = '조회된 공개 인증서 기록이 없습니다.' }
          else entry.message = `공개 인증서에서 이름 ${seen.size}개 확인 (와일드카드 포함, 최대 60개). 실제 TLS 연결을 검사한 결과는 아닙니다.`
          const newest = payload.map((item) => object(item)).sort((a, b) => (date(b.entry_timestamp ?? b.not_before) ?? '').localeCompare(date(a.entry_timestamp ?? a.not_before) ?? '')).slice(0, 8)
          for (const cert of newest) event(cert.entry_timestamp ?? cert.not_before, cert.entry_timestamp ? '인증서 공개 기록' : '인증서 유효 시작', text(cert.issuer_name), 'certificates', entry.url)
        }),
        source('archive', 'Internet Archive', `https://web.archive.org/web/*/https://${domain}/`, async (entry) => {
          const payload = object(await json(`https://archive.org/wayback/available?url=${encodeURIComponent(`https://${domain}/`)}`, signal))
          const snapshot = object(object(payload.archived_snapshots).closest)
          const stamp = text(snapshot.timestamp)
          if (!snapshot.available || !/^\d{14}$/.test(stamp)) { entry.status = 'empty'; entry.message = '루트 페이지의 보관 기록이 확인되지 않았습니다. 사이트 전체의 기록 부재를 뜻하지 않습니다.'; return }
          const timestamp = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`
          let snapshotUrl: string | undefined
          try {
            const url = new URL(text(snapshot.url, 3000))
            if (url.hostname === 'web.archive.org' && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && url.pathname.startsWith(`/web/${stamp}/`)) { url.protocol = 'https:'; snapshotUrl = url.href }
          } catch { /* Keep the archive index link when the provider omits a usable snapshot URL. */ }
          event(timestamp, '과거 웹페이지 보관', '저장된 화면은 원본 기록에서 볼 수 있습니다.', 'archive', snapshotUrl)
          entry.observedAt = date(timestamp)
          entry.message = '가장 가까운 보관 기록 확인 · 전체 변경 이력이 아닙니다.'
        }),
        source('urlscan', 'urlscan 공개 관측', `https://urlscan.io/search/#${encodeURIComponent(`task.domain.keyword:"${domain}"`)}`, async (entry) => {
          const headers: Record<string, string> = keys.URLSCAN_API_KEY ? { 'api-key': keys.URLSCAN_API_KEY } : {}
          const query = `task.domain.keyword:"${domain}" AND page.domain.keyword:"${domain}"`
          const payload = object(await json(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=5`, signal, headers))
          const records = array(payload.results).map(object).filter((row) => {
            try { return new URL(text(object(row.task).url, 2000)).hostname === domain && new URL(text(object(row.page).url, 2000)).hostname === domain } catch { return false }
          })
          const recent = records[0]
          if (!recent) { entry.status = 'empty'; entry.message = '이 도메인에 정확히 일치하는 공개 관측 기록이 없습니다. 새 스캔은 제출하지 않습니다.'; return }
          const page = object(recent.page)
          const task = object(recent.task)
          const observedAt = date(task.time)
          entry.observedAt = observedAt
          fact('관측된 IP', page.ip, 'urlscan')
          fact('관측된 네트워크', [text(page.asn), text(page.asnname)].filter(Boolean).join(' · '), 'urlscan')
          fact('관측된 IP 국가', page.country, 'urlscan')
          fact('관측된 웹 서버', page.server, 'urlscan')
          fact('관측된 인증서 발급기관', page.tlsIssuer, 'urlscan')
          if (/^[1-5]\d{2}$/.test(String(page.status))) fact('관측된 HTTP 상태', String(page.status), 'urlscan')
          for (const record of records) {
            const id = text(object(record.task).uuid)
            if (/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) event(object(record.task).time, '웹페이지 공개 관측', '해당 시점의 기록이며 현재 상태와 다를 수 있습니다.', 'urlscan', `https://urlscan.io/result/${id}/`)
          }
          const uuid = text(task.uuid)
          if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(uuid)) throw new ProviderError('failed')
          entry.url = `https://urlscan.io/result/${uuid}/`
          try {
            const details = object(await json(`https://urlscan.io/api/v1/result/${uuid}/`, signal, headers, undefined, 4_000_000))
            if (domainName(object(details.page).domain) !== domain) throw new ProviderError('failed')
            const headersAvailable = parseObservedPage(details, domain, report, observedAt)
            entry.message = headersAvailable ? '기존 공개 관측 기록 분석 완료 · 현재 설정과 다를 수 있습니다.' : '공개 관측의 연결 기록을 확인했습니다. 최종 HTTPS 문서의 헤더는 제공되지 않아 보안 헤더를 판정하지 않습니다.'
          } catch (error) {
            entry.status = 'unavailable'
            entry.message = error instanceof ProviderError && error.reason === 'limited'
              ? '기본 관측 기록은 확인했습니다. 응답 헤더·외부 연결 상세는 접근이 제한됩니다. URLSCAN_API_KEY 연결 후 다시 시도할 수 있습니다.'
              : '기본 관측 기록은 확인했으나 응답 헤더·외부 연결 상세를 가져오지 못했습니다.'
          }
        }),
        source('history', 'SecurityTrails · 과거 DNS', `https://securitytrails.com/domain/${domain}/history/a`, async (entry) => {
          const payload = object(await json(`https://api.securitytrails.com/v1/history/${domain}/dns/a`, signal, { APIKEY: keys.SECURITYTRAILS_API_KEY! }))
          for (const item of array(payload.records).slice(0, 20)) {
            const record = object(item)
            const values = array(record.values).map((value) => text(object(value).ip)).filter(Boolean).join(', ')
            event(record.first_seen, '과거 DNS 관측 시작', values, 'history', entry.url)
            event(record.last_seen, '과거 DNS 마지막 관측', values, 'history', entry.url)
          }
          if (!array(payload.records).length) { entry.status = 'empty'; entry.message = '과거 A 레코드가 없습니다.' }
          else entry.message = '과거 A 레코드 최대 20건 · 제공자가 관측한 기간입니다.'
        }, { value: keys.SECURITYTRAILS_API_KEY, name: 'SECURITYTRAILS_API_KEY' }),
        source('relationships', 'BuiltWith · 연관 사이트', `https://builtwith.com/relationships/${domain}`, async (entry) => {
          const payload = object(await json(`https://api.builtwith.com/rv4/api.json?LOOKUP=${domain}`, signal, { Authorization: `API ${keys.BUILTWITH_API_KEY!}` }))
          if (array(payload.Errors).length) throw new ProviderError('failed')
          if (!Array.isArray(payload.Relationships)) throw new ProviderError('failed')
          for (const result of array(payload.Relationships)) {
            for (const item of array(object(result).Identifiers).slice(0, 30)) {
              const relationship = object(item)
              for (const candidate of array(relationship.Matches).slice(0, 30)) {
                const match = object(candidate)
                const host = domainName(match.Domain)
                if (host && host !== domain && !report.connections.some((item) => item.kind === 'shared_identifier' && item.domain === host) && report.connections.filter((item) => item.kind === 'shared_identifier').length < 40) {
                  report.connections.push({ domain: host, kind: 'shared_identifier', evidence: `공통 식별자 유형: ${text(relationship.Type) || '제공자 관계 기록'} · ${match.Overlap === true ? '사용 기간 겹침' : '동시 사용 여부 미확인'} · 같은 운영자라는 뜻은 아닙니다.`, sourceId: 'relationships', observedAt: date(typeof match.Last === 'number' ? match.Last / 1000 : undefined) })
                }
              }
            }
          }
          if (!report.connections.some((item) => item.kind === 'shared_identifier')) { entry.status = 'empty'; entry.message = '제공자가 반환한 연관 사이트가 없습니다.' }
        }, { value: keys.BUILTWITH_API_KEY, name: 'BUILTWITH_API_KEY' }),
        source('reputation', 'VirusTotal · 분류 기록', `https://www.virustotal.com/gui/domain/${domain}`, async (entry) => {
          const payload = object(await json(`https://www.virustotal.com/api/v3/domains/${domain}`, signal, { 'x-apikey': keys.VIRUSTOTAL_API_KEY! }))
          const attributes = object(object(payload.data).attributes)
          const stats = object(attributes.last_analysis_stats)
          const malicious = number(stats.malicious)
          if (malicious === undefined) { entry.status = 'empty'; entry.message = '분류 기록이 없습니다.'; return }
          entry.observedAt = date(attributes.last_analysis_date)
          report.findings.push({ id: 'reputation', title: '보안 업체 분류 기록', detail: '탐지는 오탐일 수 있으며 탐지가 없다는 사실도 안전을 보장하지 않습니다.', evidence: `악성 ${malicious} · 의심 ${number(stats.suspicious) ?? 0} · 미탐지 ${number(stats.undetected) ?? 0}`, level: malicious > 0 ? 'warning' : 'notice', sourceId: 'reputation', observedAt: entry.observedAt, measurements: { malicious, suspicious: number(stats.suspicious) ?? 0, undetected: number(stats.undetected) ?? 0 } })
        }, { value: keys.VIRUSTOTAL_API_KEY, name: 'VIRUSTOTAL_API_KEY' }),
      ])
    } finally { clearTimeout(deadline) }
    report.timeline.sort((a, b) => b.date.localeCompare(a.date))
    report.timeline = report.timeline.slice(0, 70)
    report.connections = report.connections.filter((item, index, all) => all.findIndex((candidate) => candidate.domain === item.domain && candidate.kind === item.kind) === index)
    return report
  }

  return { async analyze(input: unknown): Promise<DomainReport> {
    const domain = normalizeDomain(input)
    const cached = cache.get(domain)
    if (cached && cached.expires > now()) return { ...cached.report, cacheHit: true }
    const pending = inFlight.get(domain)
    if (pending) return pending
    if (inFlight.size >= 3) throw new DomainError('분석 요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429)
    const promise = collect(domain).then((report) => {
      if (cache.size >= 32) cache.delete(cache.keys().next().value!)
      cache.set(domain, { report, expires: now() + (report.sources.some((source) => source.status === 'unavailable') ? 60_000 : 300_000) })
      return report
    }).finally(() => { inFlight.delete(domain) })
    inFlight.set(domain, promise)
    return promise
  } }
}

export function parseObservedPage(details: Json, domain: string, report: DomainReport, observedAt?: string) {
  const requests = array(object(details.data).requests).slice(0, 500).map(object)
  for (const item of requests) {
    const request = object(object(item.request).request)
    try {
      const host = domainName(new URL(text(request.url, 2000)).hostname)
      if (host && host !== domain && !report.connections.some((row) => row.kind === 'request' && row.domain === host) && report.connections.filter((row) => row.kind === 'request').length < 50) report.connections.push({ domain: host, kind: 'request', evidence: '공개 관측 당시 페이지가 요청한 호스트 · 운영 관계 미확인', sourceId: 'urlscan', observedAt })
    } catch { /* Invalid provider URLs are not evidence. */ }
  }
  const documents = requests.filter((item) => {
    const response = object(object(item.response).response)
    try {
      const url = new URL(text(response.url, 2000))
      const finalUrl = new URL(text(object(details.page).url, 2000))
      return url.hostname === domain && url.href === finalUrl.href && url.protocol === 'https:' && (object(item.response).type === 'Document' || object(item.request).primaryRequest === true)
    } catch { return false }
  })
  const main = documents.find((item) => object(item.request).primaryRequest === true) ?? documents.at(-1)
  if (!main) return false
  const response = object(object(main.response).response)
  if (!response.headers || typeof response.headers !== 'object' || Array.isArray(response.headers)) return false
  const headers = Object.fromEntries(Object.entries(object(response.headers)).map(([key, value]) => [key.toLowerCase(), text(value, 1500)]))
  const checks = [
    ['strict-transport-security', 'HSTS', '브라우저의 HTTPS 사용을 강제하는 정책입니다. 상위 도메인 정책이나 preload 적용 여부는 검사하지 않았습니다.'],
    ['content-security-policy', 'CSP', '브라우저의 콘텐츠 실행·로딩 범위를 제한하는 정책입니다. HTML 메타 태그의 정책은 검사하지 않았습니다.'],
    ['x-content-type-options', '콘텐츠 유형 보호', 'nosniff 설정은 브라우저의 콘텐츠 유형 추측을 제한합니다.'],
  ]
  for (const [header, label, detail] of checks) report.findings.push({ id: header, title: `${label} 헤더 ${Object.hasOwn(headers, header) ? '관측됨' : '관측 안 됨'}`, detail: `${detail} 과거 응답에서 확인한 설정 단서이며 취약점 확정 결과가 아닙니다.`, evidence: Object.hasOwn(headers, header) ? `${header}: ${headers[header] || '(빈 값)'}` : `관측된 HTTPS 문서 응답에 ${header} 없음`, level: 'notice', sourceId: 'urlscan', observedAt, measurements: { present: Object.hasOwn(headers, header) } })
  const cors = headers['access-control-allow-origin']
  if (cors) report.findings.push({ id: 'cors', title: 'CORS 공개 설정', detail: '응답의 민감도·인증 방식·요청 Origin에 따라 의미가 달라지므로 이 헤더만으로 취약성을 판단하지 않습니다.', evidence: `access-control-allow-origin: ${cors}`, level: 'notice', sourceId: 'urlscan', observedAt })
  const cookies = array(object(details.data).cookies).map(object).filter((cookie) => {
    const cookieDomain = domainName(text(cookie.domain).replace(/^\./, ''))
    return cookieDomain && (domain === cookieDomain || domain.endsWith(`.${cookieDomain}`))
  })
  if (cookies.length) report.findings.push({ id: 'cookies', title: '쿠키 보호 속성 관측', detail: '쿠키 이름·값은 수집하지 않습니다. 로그인·세션 쿠키인지 확인하지 않았으므로 속성 부재만으로 취약점이라 판정하지 않습니다.', evidence: `${cookies.length}개 중 Secure ${cookies.filter((item) => item.secure === true).length} · HttpOnly ${cookies.filter((item) => item.httpOnly === true).length} · 명시적 SameSite ${cookies.filter((item) => ['Strict', 'Lax', 'None'].includes(text(item.sameSite))).length}`, level: 'notice', sourceId: 'urlscan', observedAt,
    measurements: { total: cookies.length, secure: cookies.filter((item) => item.secure === true).length, httpOnly: cookies.filter((item) => item.httpOnly === true).length, explicitSameSite: cookies.filter((item) => ['Strict', 'Lax', 'None'].includes(text(item.sameSite))).length },
  })
  return true
}
