type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

type ProviderId = 'orcarouter' | 'openrouter' | 'nanogpt'

type AiEnv = {
  ORCAROUTER_API_KEY?: string
  OPENROUTER_API_KEY?: string
  NANOGPT_API_KEY?: string
}

type PagesContext = {
  request: Request
  env: AiEnv
}

type UpstreamErrorBody = {
  error?:
    | string
    | {
        code?: number | string
        message?: string
        type?: string
      }
  message?: string
}

type ProviderConfig = {
  id: ProviderId
  name: string
  chatUrl: string
  envKey: keyof AiEnv
  placeholder: string
}

const ORCAROUTER_MODELS = ['obsidian/Qwen3.8-27B', 'qwen/qwen3.8-27b-free'] as const
const OPENROUTER_MODELS = [
  'openrouter/free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
] as const
const NANOGPT_MODELS = [] as const
const AI_MODELS = [...ORCAROUTER_MODELS, ...OPENROUTER_MODELS, ...NANOGPT_MODELS] as const
const DEFAULT_MODEL = ORCAROUTER_MODELS[0]
const MAX_REQUEST_BYTES = 1_000_000

type AiModel = (typeof AI_MODELS)[number]

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  orcarouter: {
    id: 'orcarouter',
    name: 'OrcaRouter',
    chatUrl: 'https://api.orcarouter.ai/v1/chat/completions',
    envKey: 'ORCAROUTER_API_KEY',
    placeholder: '여기에_내_OrcaRouter_API_Key',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    envKey: 'OPENROUTER_API_KEY',
    placeholder: '여기에_내_OpenRouter_API_Key',
  },
  nanogpt: {
    id: 'nanogpt',
    name: 'NanoGPT',
    chatUrl: 'https://nano-gpt.com/api/v1/chat/completions',
    envKey: 'NANOGPT_API_KEY',
    placeholder: '여기에_내_NanoGPT_API_Key',
  },
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

function isAiModel(value: string): value is AiModel {
  return AI_MODELS.some((model) => model === value)
}

function getProviderForModel(model: AiModel) {
  if (OPENROUTER_MODELS.some((candidate) => candidate === model)) {
    return PROVIDERS.openrouter
  }
  if (NANOGPT_MODELS.some((candidate) => candidate === model)) {
    return PROVIDERS.nanogpt
  }
  return PROVIDERS.orcarouter
}

function getProviderApiKey(env: AiEnv, provider: ProviderConfig) {
  const apiKey = env[provider.envKey]?.trim()
  return apiKey && apiKey !== provider.placeholder ? apiKey : undefined
}

function isValidMessages(value: unknown): value is ChatMessage[] {
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

function parseUpstreamError(text: string, provider: ProviderConfig) {
  try {
    const parsed = JSON.parse(text) as UpstreamErrorBody
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
    return { message: text || `${provider.name} 응답을 가져오지 못했습니다.` }
  }
}

export async function onRequest({ request, env }: PagesContext) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
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
  if (!isAiModel(requestedModel)) {
    return json({ error: '허용되지 않은 모델입니다.', type: 'invalid_model' }, 400)
  }

  const provider = getProviderForModel(requestedModel)
  const apiKey = getProviderApiKey(env, provider)
  if (!apiKey) {
    return json(
      {
        error: `${provider.envKey}가 Cloudflare Pages Secret에 설정되지 않았습니다.`,
        type: 'configuration_error',
        provider: provider.id,
      },
      500,
    )
  }

  try {
    const upstream = await fetch(provider.chatUrl, {
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
      const error = parseUpstreamError(await upstream.text(), provider)
      return json(
        {
          error: error.message,
          type: error.type,
          code: error.code,
          status: upstream.status,
          provider: provider.id,
        },
        upstream.status,
      )
    }

    if (!upstream.body) {
      return json(
        {
          error: `${provider.name}가 빈 응답을 반환했습니다.`,
          type: 'empty_response',
          provider: provider.id,
        },
        502,
      )
    }

    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    }
    const generationId = upstream.headers.get('x-generation-id')
    if (generationId) headers['X-Generation-Id'] = generationId
    const requestId = upstream.headers.get('x-request-id')
    if (requestId) headers['X-Request-ID'] = requestId

    return new Response(upstream.body, {
      status: 200,
      headers,
    })
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 })
    }

    return json(
      {
        error: error instanceof Error ? error.message : `${provider.name} 연결에 실패했습니다.`,
        type: 'upstream_connection_error',
        provider: provider.id,
      },
      502,
    )
  }
}
