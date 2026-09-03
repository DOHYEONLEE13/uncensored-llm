type OrcaMessage = {
  role: 'user' | 'assistant'
  content: string
}

type OrcaRouterEnv = {
  ORCAROUTER_API_KEY?: string
}

type PagesContext = {
  request: Request
  env: OrcaRouterEnv
}

type OrcaRouterErrorBody = {
  error?:
    | string
    | {
        code?: string
        message?: string
        type?: string
      }
  message?: string
}

const ORCAROUTER_CHAT_URL = 'https://api.orcarouter.ai/v1/chat/completions'
const ORCAROUTER_MODELS = ['obsidian/Qwen3.8-27B', 'qwen/qwen3.8-27b-free'] as const
const DEFAULT_MODEL = ORCAROUTER_MODELS[0]
const MAX_REQUEST_BYTES = 1_000_000

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

function isConfigured(apiKey: string | undefined) {
  const normalized = apiKey?.trim()
  return Boolean(normalized && normalized !== '여기에_내_OrcaRouter_API_Key')
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

function isAllowedModel(value: string): value is (typeof ORCAROUTER_MODELS)[number] {
  return ORCAROUTER_MODELS.some((model) => model === value)
}

function parseUpstreamError(text: string) {
  try {
    const parsed = JSON.parse(text) as OrcaRouterErrorBody
    const error = parsed.error
    if (typeof error === 'string') return { message: error }
    if (error && typeof error === 'object') {
      return {
        code: error.code,
        message: error.message ?? parsed.message ?? text,
        type: error.type,
      }
    }
    return { message: parsed.message ?? text }
  } catch {
    return { message: text || 'OrcaRouter 응답을 가져오지 못했습니다.' }
  }
}

export async function onRequest({ request, env }: PagesContext) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const apiKey = env.ORCAROUTER_API_KEY?.trim()
  if (!isConfigured(apiKey)) {
    return json(
      {
        error: 'ORCAROUTER_API_KEY가 Cloudflare Pages Secret에 설정되지 않았습니다.',
        type: 'configuration_error',
      },
      500,
    )
  }

  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > MAX_REQUEST_BYTES) {
    return json({ error: '요청 크기가 너무 큽니다.', type: 'request_too_large' }, 413)
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json({ error: '올바르지 않은 JSON 요청입니다.', type: 'invalid_request' }, 400)
  }

  const messages =
    typeof payload === 'object' && payload !== null && 'messages' in payload
      ? payload.messages
      : undefined
  if (!isValidMessages(messages)) {
    return json({ error: 'messages 형식이 올바르지 않습니다.', type: 'invalid_request' }, 400)
  }

  const requestedModel =
    typeof payload === 'object' &&
    payload !== null &&
    'model' in payload &&
    typeof payload.model === 'string'
      ? payload.model
      : DEFAULT_MODEL
  if (!isAllowedModel(requestedModel)) {
    return json({ error: '허용되지 않은 모델입니다.', type: 'invalid_model' }, 400)
  }

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
      signal: request.signal,
    })

    if (!upstream.ok) {
      const error = parseUpstreamError(await upstream.text())
      return json(
        {
          error: error.message,
          type: error.type,
          code: error.code,
          status: upstream.status,
        },
        upstream.status,
      )
    }

    if (!upstream.body) {
      return json({ error: 'OrcaRouter가 빈 응답을 반환했습니다.', type: 'empty_response' }, 502)
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 })
    }

    return json(
      {
        error: error instanceof Error ? error.message : 'OrcaRouter 연결에 실패했습니다.',
        type: 'upstream_connection_error',
      },
      502,
    )
  }
}
