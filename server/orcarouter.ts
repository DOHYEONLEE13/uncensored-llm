import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AI_MODELS,
  DEFAULT_MODEL,
  MODEL_CATALOG,
  getConfiguredModelMetadata,
  getProviderIdForModel,
  isAiModel,
  type AiModel,
  type ProviderId,
} from './modelCatalog.js'
import {
  buildWebSearchContext,
  buildWebSearchQuery,
  createWebSearchMetaEvent,
  isRetryableIntegratedWebSearchFailure,
  parseWebSearchMode,
  resolveWebSearch,
  searchNanoGptWeb,
  type WebSearchMessage,
  type WebSearchStatus,
} from './webSearch.js'

export {
  AI_MODELS,
  DEFAULT_MODEL,
  NANOGPT_MODELS,
  OPENROUTER_MODELS,
  ORCAROUTER_MODELS,
} from './modelCatalog.js'

type ChatMessage = WebSearchMessage

type ProviderConfig = {
  id: ProviderId
  name: string
  chatUrl: string
  envKey: 'ORCAROUTER_API_KEY' | 'OPENROUTER_API_KEY' | 'NANOGPT_API_KEY'
  placeholder: string
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

const MAX_REQUEST_BYTES = 1_000_000
const MAX_MESSAGES = 100
const MAX_MESSAGE_CHARACTERS = 64_000
const MAX_TOTAL_MESSAGE_CHARACTERS = 240_000
const MAX_COMPLETION_TOKENS = 4_096

function getProviderForModel(model: AiModel) {
  return PROVIDERS[getProviderIdForModel(model)]
}

function getProviderApiKey(provider: ProviderConfig) {
  const apiKey = process.env[provider.envKey]?.trim()
  return apiKey && apiKey !== provider.placeholder ? apiKey : undefined
}

export function getOrcaRouterStatus() {
  const providerStatus = {
    orcarouter: Boolean(getProviderApiKey(PROVIDERS.orcarouter)),
    openrouter: Boolean(getProviderApiKey(PROVIDERS.openrouter)),
    nanogpt: Boolean(getProviderApiKey(PROVIDERS.nanogpt)),
  }
  const models = AI_MODELS.filter((model) => providerStatus[getProviderForModel(model).id])

  return {
    configured: models.length > 0,
    model: models[0] ?? DEFAULT_MODEL,
    models,
    modelMetadata: getConfiguredModelMetadata(models),
    providers: providerStatus,
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
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

function isValidMessages(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((message) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('role' in message) ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        !('content' in message) ||
        typeof message.content !== 'string'
      ) {
        return false
      }

      const metadata = message as {
        webSearchMode?: unknown
        webSearchStatus?: unknown
      }
      const validMode =
        metadata.webSearchMode === undefined ||
        metadata.webSearchMode === 'auto' ||
        metadata.webSearchMode === 'on' ||
        metadata.webSearchMode === 'off'
      const validStatus =
        metadata.webSearchStatus === undefined ||
        metadata.webSearchStatus === 'used' ||
        metadata.webSearchStatus === 'not-used' ||
        metadata.webSearchStatus === 'fallback' ||
        metadata.webSearchStatus === 'unused' ||
        metadata.webSearchStatus === 'failed'
      return validMode && validStatus
    })
  )
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

export async function handleOrcaRouterChat(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }

  let payload: unknown
  try {
    payload = await readJsonBody(request)
  } catch (error) {
    const status = error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 413 : 400
    sendJson(response, status, { error: '올바르지 않은 요청입니다.', type: 'invalid_request' })
    return
  }

  const messages =
    typeof payload === 'object' && payload !== null && 'messages' in payload
      ? payload.messages
      : undefined

  if (!isValidMessages(messages)) {
    sendJson(response, 400, { error: 'messages 형식이 올바르지 않습니다.', type: 'invalid_request' })
    return
  }
  const messageLimitError = getMessageLimitError(messages)
  if (messageLimitError) {
    sendJson(response, 413, { error: messageLimitError, type: 'request_too_large' })
    return
  }

  const requestedModel =
    typeof payload === 'object' && payload !== null && 'model' in payload && typeof payload.model === 'string'
      ? payload.model
      : DEFAULT_MODEL

  if (!isAiModel(requestedModel)) {
    sendJson(response, 400, { error: '허용되지 않은 모델입니다.', type: 'invalid_model' })
    return
  }

  const reasoningEnabled =
    typeof payload === 'object' && payload !== null && 'reasoningEnabled' in payload
      ? payload.reasoningEnabled
      : undefined
  if (reasoningEnabled !== undefined && typeof reasoningEnabled !== 'boolean') {
    sendJson(response, 400, {
      error: 'reasoningEnabled는 boolean이어야 합니다.',
      type: 'invalid_request',
    })
    return
  }

  const requestedWebSearchMode =
    typeof payload === 'object' && payload !== null && 'webSearchMode' in payload
      ? payload.webSearchMode
      : undefined
  const webSearchMode = parseWebSearchMode(requestedWebSearchMode)
  if (webSearchMode === undefined) {
    sendJson(response, 400, {
      error: 'webSearchMode는 auto, on, off 중 하나여야 합니다.',
      type: 'invalid_request',
    })
    return
  }

  const provider = getProviderForModel(requestedModel)
  const apiKey = getProviderApiKey(provider)
  if (!apiKey) {
    sendJson(response, 500, {
      error: `${provider.envKey}가 .env.local에 설정되지 않았습니다.`,
      type: 'configuration_error',
      provider: provider.id,
    })
    return
  }

  const controller = new AbortController()
  const abortUpstream = () => controller.abort()
  request.once('aborted', abortUpstream)
  response.once('close', abortUpstream)

  try {
    const nanoGptApiKey = getProviderApiKey(PROVIDERS.nanogpt)
    const resolution = await resolveWebSearch({
      mode: webSearchMode,
      messages,
      nanoGptApiKey,
      signal: controller.signal,
    })
    let upstreamMessages = messages.map(({ role, content }) => ({ role, content }))
    let webSearchStatus: WebSearchStatus = resolution.useWebSearch ? 'used' : 'not-used'
    let webSearchSources: Awaited<ReturnType<typeof searchNanoGptWeb>>['sources'] | undefined
    let webSearchWarning = resolution.warning

    if (resolution.useWebSearch && provider.id !== 'nanogpt') {
      if (!nanoGptApiKey) {
        webSearchStatus = 'fallback'
        webSearchWarning =
          '웹 검색을 사용할 수 없어 현재 모델의 기본 지식으로 답변합니다.'
      } else {
        try {
          const directSearch = await searchNanoGptWeb({
            query: buildWebSearchQuery(messages),
            nanoGptApiKey,
            signal: controller.signal,
          })
          upstreamMessages = buildWebSearchContext(messages, directSearch.results)
          webSearchSources = directSearch.sources
        } catch (error) {
          if (controller.signal.aborted) throw error
          webSearchStatus = 'fallback'
          webSearchSources = undefined
          webSearchWarning =
            '웹 검색에 연결하지 못해 현재 모델의 기본 지식으로 답변합니다.'
        }
      }
    }

    const integratedWebSearch = resolution.useWebSearch && provider.id === 'nanogpt'
    const createUpstreamBody = (webSearchEnabled: boolean) => {
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
        if (webSearchEnabled) {
          upstreamBody.webSearch = {
            enabled: true,
            provider: 'linkup',
            depth: 'standard',
          }
        }
      }
      return upstreamBody
    }
    const fetchUpstream = (webSearchEnabled: boolean) =>
      fetch(provider.chatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(createUpstreamBody(webSearchEnabled)),
        signal: controller.signal,
      })

    let upstream = await fetchUpstream(integratedWebSearch)
    let upstreamError = upstream.ok
      ? undefined
      : parseUpstreamError(await upstream.text(), provider)

    if (
      integratedWebSearch &&
      upstreamError &&
      isRetryableIntegratedWebSearchFailure(upstream.status, upstreamError)
    ) {
      webSearchStatus = 'fallback'
      webSearchWarning =
        '웹 검색에 연결하지 못해 현재 모델의 기본 지식으로 답변합니다.'
      upstream = await fetchUpstream(false)
      upstreamError = upstream.ok
        ? undefined
        : parseUpstreamError(await upstream.text(), provider)
    }

    if (!upstream.ok) {
      const error = upstreamError ?? { message: `${provider.name} 응답을 가져오지 못했습니다.` }
      const requestId = upstream.headers.get('x-request-id')
      sendJson(response, upstream.status || 502, {
        error: error.message,
        type: error.type,
        code: error.code,
        status: upstream.status,
        provider: provider.id,
      }, requestId ? { 'X-Request-ID': requestId } : undefined)
      return
    }

    if (!upstream.body) {
      sendJson(response, 502, {
        error: `${provider.name}가 빈 응답을 반환했습니다.`,
        type: 'empty_response',
        provider: provider.id,
      })
      return
    }

    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
    const generationId = upstream.headers.get('x-generation-id')
    if (generationId) headers['X-Generation-Id'] = generationId
    const requestId = upstream.headers.get('x-request-id')
    if (requestId) headers['X-Request-ID'] = requestId

    response.writeHead(200, headers)
    response.flushHeaders()
    response.write(
      createWebSearchMetaEvent({
        mode: webSearchMode,
        status: webSearchStatus,
        reason: resolution.reason,
        sources: webSearchSources,
        warning: webSearchWarning,
      }),
    )

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
      sendJson(response, 502, {
        error: error instanceof Error ? error.message : `${provider.name} 연결에 실패했습니다.`,
        type: 'upstream_connection_error',
        provider: provider.id,
      })
    }
  } finally {
    request.removeListener('aborted', abortUpstream)
    response.removeListener('close', abortUpstream)
  }
}
