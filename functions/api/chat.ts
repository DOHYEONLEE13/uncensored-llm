import {
  DEFAULT_MODEL,
  MODEL_CATALOG,
  getProviderIdForModel,
  isAiModel,
  type AiModel,
  type ProviderId,
} from '../_modelCatalog'
import {
  buildWebSearchContext,
  buildWebSearchQuery,
  createWebSearchMetaEvent,
  isRetryableIntegratedWebSearchFailure,
  isWebSearchStatus,
  parseWebSearchMode,
  resolveWebSearch,
  searchNanoGptWeb,
  type WebSearchMessage,
  type WebSearchMeta,
} from '../_webSearch'

type ChatMessage = WebSearchMessage

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

const MAX_REQUEST_BYTES = 1_000_000
const MAX_MESSAGES = 100
const MAX_MESSAGE_CHARACTERS = 64_000
const MAX_TOTAL_MESSAGE_CHARACTERS = 240_000
const MAX_COMPLETION_TOKENS = 4_096

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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

function getProviderForModel(model: AiModel) {
  return PROVIDERS[getProviderIdForModel(model)]
}

function getProviderApiKey(env: AiEnv, provider: ProviderConfig) {
  const apiKey = env[provider.envKey]?.trim()
  return apiKey && apiKey !== provider.placeholder ? apiKey : undefined
}

async function readJsonBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('INVALID_JSON')

  const chunks: Uint8Array[] = []
  let size = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    size += value.byteLength
    if (size > MAX_REQUEST_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // The size error below is the useful response even if cancellation fails.
      }
      throw new Error('REQUEST_TOO_LARGE')
    }
    chunks.push(value)
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return JSON.parse(new TextDecoder().decode(body)) as unknown
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
        typeof message.content === 'string' &&
        (!('webSearchMode' in message) ||
          message.webSearchMode === undefined ||
          parseWebSearchMode(message.webSearchMode) !== undefined) &&
        (!('webSearchStatus' in message) ||
          message.webSearchStatus === undefined ||
          isWebSearchStatus(message.webSearchStatus)),
    )
  )
}

function toUpstreamMessages(messages: ChatMessage[]) {
  return messages.map(({ role, content }) => ({ role, content }))
}

function getMessageLimitError(messages: ChatMessage[]) {
  if (messages.length > MAX_MESSAGES) {
    return `messages는 최대 ${MAX_MESSAGES}개까지 전송할 수 있습니다.`
  }

  let totalCharacters = 0
  for (const message of messages) {
    if (message.content.length > MAX_MESSAGE_CHARACTERS) {
      return `메시지 하나는 최대 ${MAX_MESSAGE_CHARACTERS.toLocaleString()}자까지 전송할 수 있습니다.`
    }
    totalCharacters += message.content.length
    if (totalCharacters > MAX_TOTAL_MESSAGE_CHARACTERS) {
      return `전체 대화는 최대 ${MAX_TOTAL_MESSAGE_CHARACTERS.toLocaleString()}자까지 전송할 수 있습니다.`
    }
  }

  return undefined
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

function getWebSearchFallbackWarning() {
  return '웹 검색에 연결하지 못해 현재 모델 지식 기준으로 답변합니다.'
}

function getMissingNanoGptSearchWarning() {
  return 'NanoGPT 웹 검색이 설정되지 않아 현재 모델 지식 기준으로 답변합니다.'
}

function prependSseEvent(
  upstreamBody: ReadableStream<Uint8Array>,
  event: string,
  signal: AbortSignal,
) {
  const reader = upstreamBody.getReader()
  const prefix = new TextEncoder().encode(event)
  let prefixSent = false
  let settled = false
  let abortHandler: (() => void) | undefined

  const cleanup = () => {
    if (settled) return
    settled = true
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abortHandler = () => {
        cleanup()
        void reader.cancel(signal.reason).finally(() => controller.error(signal.reason))
      }
      if (signal.aborted) {
        abortHandler()
      } else {
        signal.addEventListener('abort', abortHandler, { once: true })
      }
    },
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true
        controller.enqueue(prefix)
        return
      }

      try {
        const { done, value } = await reader.read()
        if (done) {
          cleanup()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        cleanup()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cleanup()
      await reader.cancel(reason)
    },
  })
}

async function fetchChatCompletion(
  provider: ProviderConfig,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  return fetch(provider.chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  })
}

function upstreamErrorResponse(
  upstream: Response,
  error: ReturnType<typeof parseUpstreamError>,
  provider: ProviderConfig,
) {
  const requestId = upstream.headers.get('x-request-id')
  return json(
    {
      error: error.message,
      type: error.type,
      code: error.code,
      status: upstream.status,
      provider: provider.id,
    },
    upstream.status || 502,
    requestId ? { 'X-Request-ID': requestId } : undefined,
  )
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
    payload = await readJsonBody(request)
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_TOO_LARGE') {
      return json({ error: '요청 크기가 너무 큽니다.', type: 'request_too_large' }, 413)
    }
    return json({ error: '올바르지 않은 JSON 요청입니다.', type: 'invalid_request' }, 400)
  }

  const messages =
    typeof payload === 'object' && payload !== null && 'messages' in payload
      ? payload.messages
      : undefined
  if (!isValidMessages(messages)) {
    return json({ error: 'messages 형식이 올바르지 않습니다.', type: 'invalid_request' }, 400)
  }
  const messageLimitError = getMessageLimitError(messages)
  if (messageLimitError) {
    return json({ error: messageLimitError, type: 'request_too_large' }, 413)
  }

  const webSearchMode = parseWebSearchMode(
    typeof payload === 'object' && payload !== null && 'webSearchMode' in payload
      ? payload.webSearchMode
      : undefined,
  )
  if (!webSearchMode) {
    return json(
      {
        error: 'webSearchMode는 auto, on, off 중 하나여야 합니다.',
        type: 'invalid_request',
      },
      400,
    )
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

  const reasoningEnabled =
    typeof payload === 'object' && payload !== null && 'reasoningEnabled' in payload
      ? payload.reasoningEnabled
      : undefined
  if (reasoningEnabled !== undefined && typeof reasoningEnabled !== 'boolean') {
    return json(
      { error: 'reasoningEnabled는 boolean이어야 합니다.', type: 'invalid_request' },
      400,
    )
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
    const nanoGptApiKey = getProviderApiKey(env, PROVIDERS.nanogpt)
    const resolution = await resolveWebSearch({
      mode: webSearchMode,
      messages,
      nanoGptApiKey,
      signal: request.signal,
    })

    let upstreamMessages = toUpstreamMessages(messages)
    let integratedNanoGptSearch = false
    const webSearchMeta: WebSearchMeta = {
      mode: webSearchMode,
      status: resolution.useWebSearch ? 'used' : 'not-used',
      reason: resolution.reason,
      ...(resolution.warning ? { warning: resolution.warning } : {}),
    }

    if (resolution.useWebSearch) {
      if (provider.id === 'nanogpt') {
        integratedNanoGptSearch = true
      } else if (!nanoGptApiKey) {
        webSearchMeta.status = 'fallback'
        webSearchMeta.warning = getMissingNanoGptSearchWarning()
      } else {
        try {
          const search = await searchNanoGptWeb({
            query: buildWebSearchQuery(messages),
            nanoGptApiKey,
            signal: request.signal,
          })
          if (search.results.length === 0) {
            webSearchMeta.status = 'fallback'
            webSearchMeta.warning =
              '웹 검색 결과를 찾지 못해 현재 모델 지식 기준으로 답변합니다.'
          } else {
            upstreamMessages = buildWebSearchContext(messages, search.results)
            webSearchMeta.sources = search.sources
          }
        } catch (error) {
          if (request.signal.aborted) throw error
          webSearchMeta.status = 'fallback'
          webSearchMeta.warning = getWebSearchFallbackWarning()
        }
      }
    }

    const upstreamBody: Record<string, unknown> = {
      model: requestedModel,
      messages: upstreamMessages,
      stream: true,
      max_tokens: Math.min(
        MODEL_CATALOG[requestedModel].maxOutputTokens ?? MAX_COMPLETION_TOKENS,
        MAX_COMPLETION_TOKENS,
      ),
    }
    if (provider.id === 'nanogpt') {
      upstreamBody.stream_options = { include_usage: true }
      if (MODEL_CATALOG[requestedModel].capabilities.reasoning && reasoningEnabled !== undefined) {
        upstreamBody.reasoning_effort = reasoningEnabled ? 'medium' : 'none'
      }
      if (integratedNanoGptSearch) {
        upstreamBody.webSearch = {
          enabled: true,
          provider: 'linkup',
          depth: 'standard',
        }
      }
    }

    let upstream = await fetchChatCompletion(provider, apiKey, upstreamBody, request.signal)

    if (!upstream.ok) {
      const error = parseUpstreamError(await upstream.text(), provider)
      if (
        !integratedNanoGptSearch ||
        !isRetryableIntegratedWebSearchFailure(upstream.status, error)
      ) {
        return upstreamErrorResponse(upstream, error, provider)
      }

      delete upstreamBody.webSearch
      webSearchMeta.status = 'fallback'
      webSearchMeta.warning = getWebSearchFallbackWarning()
      upstream = await fetchChatCompletion(provider, apiKey, upstreamBody, request.signal)
      if (!upstream.ok) {
        const fallbackError = parseUpstreamError(await upstream.text(), provider)
        return upstreamErrorResponse(upstream, fallbackError, provider)
      }
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

    const responseBody = prependSseEvent(
      upstream.body,
      createWebSearchMetaEvent(webSearchMeta),
      request.signal,
    )

    return new Response(responseBody, {
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
