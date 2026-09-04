import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { onRequest } from '../functions/api/chat.js'
import { handleOrcaRouterChat } from '../server/orcarouter.js'

type ProviderEnv = {
  ORCAROUTER_API_KEY: string
  OPENROUTER_API_KEY: string
  NANOGPT_API_KEY: string
}

type CapturedResponse = {
  status: number
  headers: Headers
  body: string
}

type FetchCall = {
  url: string
  init: RequestInit
  body: Record<string, unknown> | undefined
  headers: Headers
}

type FetchResponder = (call: FetchCall, index: number) => Response | Promise<Response>

const TEST_ENV: ProviderEnv = {
  ORCAROUTER_API_KEY: 'test-orcarouter-key',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  NANOGPT_API_KEY: 'test-nanogpt-key',
}

const NANOGPT_CHAT_URL = 'https://nano-gpt.com/api/v1/chat/completions'
const NANOGPT_WEB_URL = 'https://nano-gpt.com/api/web'
const ORCAROUTER_CHAT_URL = 'https://api.orcarouter.ai/v1/chat/completions'

const NANO_THINKING_MODEL = 'qwen/qwen3.8-27b-uncensored:thinking'
const ORCA_MODEL = 'obsidian/Qwen3.8-27B'

class CapturingServerResponse extends EventEmitter {
  readonly headers = new Headers()
  readonly chunks: Buffer[] = []
  statusCode = 200
  headersSent = false
  writableEnded = false
  destroyed = false
  destroyedWith?: Error

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
    return this
  }

  getHeader(name: string) {
    return this.headers.get(name) ?? undefined
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, string>,
    maybeHeaders?: Record<string, string>,
  ) {
    this.statusCode = statusCode
    const headers =
      typeof statusMessageOrHeaders === 'object' ? statusMessageOrHeaders : maybeHeaders
    for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
    this.headersSent = true
    return this
  }

  flushHeaders() {
    this.headersSent = true
  }

  write(chunk: string | Uint8Array) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return true
  }

  end(chunk?: string | Uint8Array) {
    if (chunk !== undefined) this.write(chunk)
    this.writableEnded = true
    return this
  }

  destroy(error?: Error) {
    this.destroyed = true
    this.destroyedWith = error
    this.writableEnded = true
    return this
  }
}

function parseBody(body: BodyInit | null | undefined) {
  if (typeof body !== 'string') return undefined
  return JSON.parse(body) as Record<string, unknown>
}

async function withMockFetch<T>(
  responder: FetchResponder,
  task: (calls: FetchCall[]) => Promise<T>,
) {
  const originalFetch = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const call: FetchCall = {
      url,
      init,
      body: parseBody(init.body),
      headers: new Headers(init.headers),
    }
    calls.push(call)
    return responder(call, calls.length - 1)
  }) as typeof fetch

  try {
    return await task(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function setTestProcessEnv() {
  const names = Object.keys(TEST_ENV) as Array<keyof ProviderEnv>
  const previous = new Map(names.map((name) => [name, process.env[name]]))
  for (const name of names) process.env[name] = TEST_ENV[name]

  return () => {
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function invokeNode(payload: unknown): Promise<CapturedResponse> {
  const restoreEnv = setTestProcessEnv()
  try {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]) as Readable & {
      method: string
    }
    request.method = 'POST'
    const response = new CapturingServerResponse()

    await handleOrcaRouterChat(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    )

    if (response.destroyedWith) throw response.destroyedWith
    return {
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(response.chunks).toString('utf8'),
    }
  } finally {
    restoreEnv()
  }
}

async function invokeCloudflare(payload: unknown): Promise<CapturedResponse> {
  const response = await onRequest({
    request: new Request('https://mira.test/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env: { ...TEST_ENV },
  })
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }
}

const routes = [
  { name: 'Node server route', invoke: invokeNode },
  { name: 'Cloudflare Pages route', invoke: invokeCloudflare },
] as const

function sseResponse(content: string) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    },
  )
}

function parseWebSearchMeta(body: string) {
  const event = body
    .split(/\r?\n\r?\n/u)
    .find((block) => block.startsWith('event: mira-meta'))
  assert.ok(event, 'the response must start with a mira-meta SSE event')
  const dataLine = event.split(/\r?\n/u).find((line) => line.startsWith('data: '))
  assert.ok(dataLine, 'the mira-meta event must contain JSON data')
  return JSON.parse(dataLine.slice('data: '.length)) as {
    webSearch: {
      mode: 'auto' | 'on' | 'off'
      status: 'used' | 'not-used' | 'fallback'
      reason: string
      warning?: string
      sources?: Array<{ title?: string; url: string }>
    }
  }
}

function assertOnlyRoleAndContent(messages: unknown) {
  assert.ok(Array.isArray(messages))
  for (const message of messages) {
    assert.equal(typeof message, 'object')
    assert.deepEqual(Object.keys(message as object).sort(), ['content', 'role'])
  }
}

describe('web-search API route contract', { concurrency: false }, () => {
  test('invalid webSearchMode returns 400 before any upstream fetch', async () => {
    for (const route of routes) {
      await withMockFetch(
        () => {
          throw new Error(`${route.name} unexpectedly called fetch`)
        },
        async (calls) => {
          const response = await route.invoke({
            model: NANO_THINKING_MODEL,
            messages: [{ role: 'user', content: 'hello' }],
            webSearchMode: 'sometimes',
          })

          assert.equal(response.status, 400, route.name)
          assert.equal(calls.length, 0, route.name)
          const error = JSON.parse(response.body) as { type?: string }
          assert.equal(error.type, 'invalid_request', route.name)
        },
      )
    }
  })

  test('NanoGPT ON preserves the thinking model and prepends used metadata to the SSE', async () => {
    for (const route of routes) {
      await withMockFetch(
        (call) => {
          assert.equal(call.url, NANOGPT_CHAT_URL, route.name)
          return sseResponse('searched answer')
        },
        async (calls) => {
          const response = await route.invoke({
            model: NANO_THINKING_MODEL,
            messages: [
              {
                role: 'user',
                content: 'Find this on the web',
                webSearchMode: 'on',
                webSearchStatus: 'used',
              },
            ],
            reasoningEnabled: true,
            webSearchMode: 'on',
          })

          assert.equal(response.status, 200, route.name)
          assert.equal(calls.length, 1, route.name)
          const body = calls[0].body
          assert.ok(body)
          assert.equal(body.model, NANO_THINKING_MODEL, route.name)
          assert.equal(body.stream, true, route.name)
          assert.deepEqual(body.webSearch, {
            enabled: true,
            provider: 'linkup',
            depth: 'standard',
          })
          assertOnlyRoleAndContent(body.messages)
          assert.equal(response.body.startsWith('event: mira-meta\n'), true, route.name)
          assert.equal(parseWebSearchMeta(response.body).webSearch.status, 'used', route.name)
          assert.match(response.body, /searched answer/u, route.name)
        },
      )
    }
  })

  test('NanoGPT OFF omits webSearch while keeping normal streaming', async () => {
    for (const route of routes) {
      await withMockFetch(
        () => sseResponse('offline answer'),
        async (calls) => {
          const response = await route.invoke({
            model: NANO_THINKING_MODEL,
            messages: [
              {
                role: 'user',
                content: '오늘 뉴스 알려줘',
                webSearchMode: 'off',
              },
            ],
            webSearchMode: 'off',
          })

          assert.equal(response.status, 200, route.name)
          assert.equal(calls.length, 1, route.name)
          assert.equal(Object.hasOwn(calls[0].body ?? {}, 'webSearch'), false, route.name)
          assert.equal(parseWebSearchMeta(response.body).webSearch.status, 'not-used', route.name)
        },
      )
    }
  })

  test('non-Nano ON searches through NanoGPT, injects context server-side, and emits safe sources', async () => {
    for (const route of routes) {
      const clientMessages = [
        {
          role: 'assistant',
          content: 'Earlier answer',
          webSearchMode: 'auto',
          webSearchStatus: 'used',
          id: 'client-only-id',
        },
        {
          role: 'user',
          content: '오늘 핵심 뉴스 검색해줘',
          webSearchMode: 'on',
          id: 'client-only-id-2',
        },
      ]

      await withMockFetch(
        (call, index) => {
          if (index === 0) {
            assert.equal(call.url, NANOGPT_WEB_URL, route.name)
            assert.equal(call.body?.query, '오늘 핵심 뉴스 검색해줘', route.name)
            return Response.json({
              data: [
                {
                  title: 'Trusted result',
                  url: 'https://news.example.com/story',
                  content: 'A current factual excerpt.',
                },
                {
                  title: 'Unsafe result',
                  url: 'javascript:alert(1)',
                  content: 'Must never reach the model or UI.',
                },
                {
                  title: 'Credential URL',
                  url: 'https://user:password@example.com/private',
                  content: 'Must also be rejected.',
                },
              ],
            })
          }

          assert.equal(call.url, ORCAROUTER_CHAT_URL, route.name)
          return sseResponse('provider answer')
        },
        async (calls) => {
          const response = await route.invoke({
            model: ORCA_MODEL,
            messages: clientMessages,
            webSearchMode: 'on',
          })

          assert.equal(response.status, 200, route.name)
          assert.equal(calls.length, 2, route.name)

          const upstreamBody = calls[1].body
          assert.ok(upstreamBody)
          assert.equal(upstreamBody.model, ORCA_MODEL, route.name)
          assert.equal(upstreamBody.stream, true, route.name)
          assertOnlyRoleAndContent(upstreamBody.messages)

          const upstreamMessages = upstreamBody.messages as Array<{
            role: string
            content: string
          }>
          assert.equal(upstreamMessages[0].content, 'Earlier answer', route.name)
          assert.match(upstreamMessages[1].content, /MIRA_WEB_SEARCH_CONTEXT_BEGIN/u, route.name)
          assert.match(upstreamMessages[1].content, /https:\/\/news\.example\.com\/story/u, route.name)
          assert.doesNotMatch(upstreamMessages[1].content, /javascript:/u, route.name)
          assert.doesNotMatch(upstreamMessages[1].content, /user:password/u, route.name)

          assert.equal(clientMessages[1].content, '오늘 핵심 뉴스 검색해줘', route.name)
          assert.doesNotMatch(clientMessages[1].content, /MIRA_WEB_SEARCH_CONTEXT/u, route.name)

          const meta = parseWebSearchMeta(response.body).webSearch
          assert.equal(meta.status, 'used', route.name)
          assert.deepEqual(meta.sources, [
            { title: 'Trusted result', url: 'https://news.example.com/story' },
          ])
        },
      )
    }
  })

  test('direct web failure falls back to the original provider exactly once', async () => {
    for (const route of routes) {
      await withMockFetch(
        (call, index) => {
          if (index === 0) {
            assert.equal(call.url, NANOGPT_WEB_URL, route.name)
            return Response.json(
              { error: { type: 'web_search_unavailable', message: 'temporary search outage' } },
              { status: 503 },
            )
          }
          assert.equal(call.url, ORCAROUTER_CHAT_URL, route.name)
          return sseResponse('fallback-answer-once')
        },
        async (calls) => {
          const response = await route.invoke({
            model: ORCA_MODEL,
            messages: [
              {
                role: 'user',
                content: 'search this',
                webSearchMode: 'on',
              },
            ],
            webSearchMode: 'on',
          })

          assert.equal(response.status, 200, route.name)
          assert.equal(calls.length, 2, route.name)
          assert.equal(
            calls.filter((call) => call.url === ORCAROUTER_CHAT_URL).length,
            1,
            route.name,
          )
          const messages = calls[1].body?.messages as Array<{ content: string }>
          assert.equal(messages[0].content, 'search this', route.name)
          assert.equal(parseWebSearchMeta(response.body).webSearch.status, 'fallback', route.name)
          assert.equal(
            response.body.match(/fallback-answer-once/gu)?.length,
            1,
            `${route.name} duplicated the assistant stream`,
          )
        },
      )
    }
  })

  test('retryable integrated search errors retry once without webSearch', async () => {
    for (const route of routes) {
      await withMockFetch(
        (_call, index) => {
          if (index === 0) {
            return Response.json(
              {
                error: {
                  code: 'webSearch_balance_required',
                  type: 'web_search_error',
                  message: 'search balance required',
                },
              },
              { status: 402 },
            )
          }
          return sseResponse('retry answer')
        },
        async (calls) => {
          const response = await route.invoke({
            model: NANO_THINKING_MODEL,
            messages: [{ role: 'user', content: '검색해줘' }],
            webSearchMode: 'on',
          })

          assert.equal(response.status, 200, route.name)
          assert.equal(calls.length, 2, route.name)
          assert.equal(calls[0].url, NANOGPT_CHAT_URL, route.name)
          assert.equal(calls[1].url, NANOGPT_CHAT_URL, route.name)
          assert.equal(calls[0].body?.model, NANO_THINKING_MODEL, route.name)
          assert.equal(calls[1].body?.model, NANO_THINKING_MODEL, route.name)
          assert.equal(
            (calls[0].body?.webSearch as { enabled?: boolean } | undefined)?.enabled,
            true,
            route.name,
          )
          assert.equal(Object.hasOwn(calls[1].body ?? {}, 'webSearch'), false, route.name)
          assert.equal(parseWebSearchMeta(response.body).webSearch.status, 'fallback', route.name)
          assert.match(response.body, /retry answer/u, route.name)
        },
      )
    }
  })

  test('integrated authentication and model errors are returned without retrying', async () => {
    const failures = [
      { status: 401, type: 'authentication_error', message: 'invalid API key' },
      { status: 404, type: 'model_not_found', message: 'unknown model' },
    ] as const

    for (const route of routes) {
      for (const failure of failures) {
        await withMockFetch(
          () =>
            Response.json(
              {
                error: {
                  type: failure.type,
                  message: failure.message,
                },
              },
              { status: failure.status },
            ),
          async (calls) => {
            const response = await route.invoke({
              model: NANO_THINKING_MODEL,
              messages: [{ role: 'user', content: '검색해줘' }],
              webSearchMode: 'on',
            })

            assert.equal(response.status, failure.status, route.name)
            assert.equal(calls.length, 1, `${route.name} retried a ${failure.status} error`)
            const error = JSON.parse(response.body) as {
              type?: string
              status?: number
              error?: string
            }
            assert.equal(error.type, failure.type, route.name)
            assert.equal(error.status, failure.status, route.name)
            assert.equal(error.error, failure.message, route.name)
          },
        )
      }
    }
  })
})
