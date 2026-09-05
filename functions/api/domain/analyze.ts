import { createDomainHandler, readDomainKeys } from '../../../server/domainHttp'
import type { DomainKeys } from '../../../server/domainTypes'

let handler: ReturnType<typeof createDomainHandler> | undefined
let lastKeys = ''

export async function onRequest({ request, env }: { request: Request; env: DomainKeys }) {
  const keys = readDomainKeys(env)
  const keySet = JSON.stringify(keys)
  if (!handler || keySet !== lastKeys) { handler = createDomainHandler({ keys }); lastKeys = keySet }
  return handler(request, request.headers.get('CF-Connecting-IP') ?? 'anonymous')
}
