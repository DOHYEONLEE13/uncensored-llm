import type { IncomingMessage, ServerResponse } from 'node:http'

type OrcaMessage = {
  role: 'user' | 'assistant'
  content: string
}

const ORCAROUTER_CHAT_URL = 'https://api.orcarouter.ai/v1/chat/completions'
export const ORCAROUTER_MODELS = [
  'obsidian/Qwen3.8-27B',
  'qwen/qwen3.8-27b-free',
] as const
export const ORCAROUTER_MODEL = ORCAROUTER_MODELS[0]
const MAX_REQUEST_BYTES = 1_000_000

type OrcaRouterModel = (typeof ORCAROUTER_MODELS)[number]

function isOrcaRouterModel(value: string): value is OrcaRouterModel {
  return ORCAROUTER_MODELS.some((model) => model === value)
}

export function getOrcaRouterStatus() {
  const apiKey = process.env.ORCAROUTER_API_KEY?.trim()
  return {
    configured: Boolean(apiKey && apiKey !== '여기에_내_OrcaRouter_API_Key'),
    model: ORCAROUTER_MODEL,
    models: [...ORCAROUTER_MODELS],
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(buffer)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isValidMessages(value: unknown): value is OrcaMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        (message.role === 'user' || message.role === 'assistant') &&
        'content' in message &&
        typeof message.content === 'string',
    )
  )
}

export async function handleOrcaRouterChat(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }

  const apiKey = process.env.ORCAROUTER_API_KEY?.trim()
  if (!apiKey || apiKey === '여기에_내_OrcaRouter_API_Key') {
    sendJson(response, 500, { error: 'ORCAROUTER_API_KEY가 설정되지 않았습니다.' })
    return
  }

  let payload: unknown
  try {
    payload = await readJsonBody(request)
  } catch (error) {
    const status = error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 400
    sendJson(response, status, { error: '올바르지 않은 요청입니다.' })
    return
  }

  const messages =
    typeof payload === 'object' && payload !== null && 'messages' in payload
      ? payload.messages
      : undefined

  if (!isValidMessages(messages)) {
    sendJson(response, 400, { error: 'messages 형식이 올바르지 않습니다.' })
    return
  }

  const requestedModel =
    typeof payload === 'object' && payload !== null && 'model' in payload && typeof payload.model === 'string'
      ? payload.model
      : ORCAROUTER_MODEL

  if (!isOrcaRouterModel(requestedModel)) {
    sendJson(response, 400, { error: '허용되지 않은 모델입니다.' })
    return
  }

  const controller = new AbortController()
  const abortUpstream = () => controller.abort()
  request.once('aborted', abortUpstream)

  try {
    const upstream = await fetch(ORCAROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: requestedModel,
        messages,
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!upstream.ok || !upstream.body) {
      sendJson(response, upstream.status || 502, {
        error: 'OrcaRouter 응답을 가져오지 못했습니다.',
      })
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders()

    const reader = upstream.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(Buffer.from(value))
    }
    response.end()
  } catch (error) {
    if (controller.signal.aborted) {
      if (!response.writableEnded) response.end()
      return
    }

    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined)
    } else {
      sendJson(response, 502, { error: 'OrcaRouter 연결에 실패했습니다.' })
    }
  } finally {
    request.removeListener('aborted', abortUpstream)
  }
}
