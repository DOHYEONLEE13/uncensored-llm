import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { CctvServiceError, createProcessCctvService } from './cctv.js'
import { UticCctvProvider } from './utic.js'

let catalog: ReturnType<typeof createProcessCctvService> | undefined
let configuredKey: string | undefined

/** Run on an approved-IP host behind HTTPS. This only serves a cached, sanitized catalog. */
export async function handleUticCatalog(request: IncomingMessage, response: ServerResponse) {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'GET' } : {}) })
    response.end(JSON.stringify(body))
  }
  const token = process.env.UTIC_RELAY_TOKEN?.trim()
  const key = process.env.UTIC_API_KEY?.trim()
  if (!token || token.length < 32 || !key) { send(404, { error: { code: 'not_found' } }); return }
  if (request.method !== 'GET') { send(405, { error: { code: 'method_not_allowed' } }); return }
  const supplied = Buffer.from(request.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    send(401, { error: { code: 'unauthorized' } }); return
  }
  try {
    if (!catalog || configuredKey !== key) {
      catalog = createProcessCctvService({ provider: new UticCctvProvider({ apiKey: key }) })
      configuredKey = key
    }
    const snapshot = await catalog.getCatalog({ fresh: true })
    send(200, { cctvs: snapshot.cctvs, updatedAt: snapshot.updatedAt })
  } catch (error) {
    send(error instanceof CctvServiceError ? error.status : 503, {
      error: { code: error instanceof CctvServiceError ? error.type : 'cctv_service_error' },
    })
  }
}
