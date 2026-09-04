import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  parseWebSearchMode as parseServerWebSearchMode,
  resolveWebSearch as resolveServerWebSearch,
  shouldUseWebSearch as shouldUseServerWebSearch,
  type WebSearchMessage as ServerWebSearchMessage,
  type WebSearchMode as ServerWebSearchMode,
} from '../server/webSearch.js'
import {
  parseWebSearchMode as parseFunctionsWebSearchMode,
  resolveWebSearch as resolveFunctionsWebSearch,
  type WebSearchMessage as FunctionsWebSearchMessage,
  type WebSearchMode as FunctionsWebSearchMode,
} from '../functions/_webSearch.js'

type TestMessage = {
  role: 'user' | 'assistant'
  content: string
  webSearchMode?: 'auto' | 'on' | 'off'
  webSearchStatus?: 'used' | 'fallback' | 'unused' | 'failed' | 'not-used'
}

const implementations = [
  {
    name: 'Node server',
    parseMode: parseServerWebSearchMode,
    resolve: async (mode: ServerWebSearchMode, messages: TestMessage[], signal: AbortSignal) =>
      resolveServerWebSearch({
        mode,
        messages: messages as ServerWebSearchMessage[],
        nanoGptApiKey: 'test-key-that-must-never-be-used',
        signal,
      }),
  },
  {
    name: 'Cloudflare Functions',
    parseMode: parseFunctionsWebSearchMode,
    resolve: async (mode: FunctionsWebSearchMode, messages: TestMessage[], signal: AbortSignal) =>
      resolveFunctionsWebSearch({
        mode,
        messages: messages as FunctionsWebSearchMessage[],
        nanoGptApiKey: 'test-key-that-must-never-be-used',
        signal,
      }),
  },
] as const

const autoSearchExamples = [
  '오늘 미국 증시 어때?',
  'OpenAI 최신 뉴스 알려줘',
  '현재 비트코인 가격 알려줘',
  '지금 서울 날씨 어때?',
  '최근 React 버전이 뭐야?',
  'NanoGPT 최신 요금 찾아줘',
  '웹에서 Qwen 최근 평가 찾아봐',
  '현재 NVIDIA CEO가 누구야?',
] as const

const autoNoSearchExamples = [
  '안녕',
  'React useState가 뭐야?',
  '1+1은?',
  '이 문장 영어로 번역해줘',
  '이 이메일 좀 공손하게 써줘',
  '파이썬으로 버블 정렬 구현해줘',
  '내가 방금 말한 내용 요약해줘',
] as const

const keywordConflictNoSearchExamples = [
  '현재완료 문법 설명해줘',
  '가격이라는 단어를 영어로 번역해줘',
  '오늘 회의 취소 이메일 써줘',
  '날씨가 왜 생겨?',
] as const

function userMessage(content: string): TestMessage[] {
  return [{ role: 'user', content }]
}

function alreadyAbortedSignal() {
  const controller = new AbortController()
  controller.abort('A clear rule must not invoke the classifier or network.')
  return controller.signal
}

async function resolveAcrossImplementations(
  mode: 'auto' | 'on' | 'off',
  messages: TestMessage[],
  signalFactory: () => AbortSignal = alreadyAbortedSignal,
) {
  return Promise.all(
    implementations.map(async (implementation) => ({
      name: implementation.name,
      resolution: await implementation.resolve(mode, messages, signalFactory()),
    })),
  )
}

function assertSameSearchDecision(
  resolutions: Awaited<ReturnType<typeof resolveAcrossImplementations>>,
  expected: boolean,
) {
  for (const { name, resolution } of resolutions) {
    assert.equal(
      resolution.useWebSearch,
      expected,
      `${name} returned the wrong web-search decision (${resolution.reason})`,
    )
  }
  assert.equal(
    resolutions[0].resolution.useWebSearch,
    resolutions[1].resolution.useWebSearch,
    'Node and Cloudflare decisions must stay in parity',
  )
}

describe('web-search mode parsing', () => {
  for (const implementation of implementations) {
    test(`${implementation.name}: defaults to AUTO and accepts only supported modes`, () => {
      assert.equal(implementation.parseMode(undefined), 'auto')
      assert.equal(implementation.parseMode('auto'), 'auto')
      assert.equal(implementation.parseMode('on'), 'on')
      assert.equal(implementation.parseMode('off'), 'off')

      for (const invalid of [null, '', 'AUTO', 'enabled', true, 0, {}, []]) {
        assert.equal(
          implementation.parseMode(invalid),
          undefined,
          `${implementation.name} accepted invalid mode ${JSON.stringify(invalid)}`,
        )
      }
    })
  }
})

describe('AUTO deterministic decisions', () => {
  for (const query of autoSearchExamples) {
    test(`searches for: ${query}`, async () => {
      const resolutions = await resolveAcrossImplementations('auto', userMessage(query))
      assertSameSearchDecision(resolutions, true)
      assert.equal(shouldUseServerWebSearch(userMessage(query)), true)
    })
  }

  for (const query of autoNoSearchExamples) {
    test(`does not search for: ${query}`, async () => {
      const resolutions = await resolveAcrossImplementations('auto', userMessage(query))
      assertSameSearchDecision(resolutions, false)
      assert.equal(shouldUseServerWebSearch(userMessage(query)), false)
    })
  }

  for (const query of keywordConflictNoSearchExamples) {
    test(`task intent wins over a misleading keyword: ${query}`, async () => {
      const resolutions = await resolveAcrossImplementations('auto', userMessage(query))
      assertSameSearchDecision(resolutions, false)
      assert.equal(shouldUseServerWebSearch(userMessage(query)), false)
    })
  }

  test('searches for a current official announcement', async () => {
    const messages = userMessage('최신 OpenAI 공지를 요약해줘')
    const resolutions = await resolveAcrossImplementations('auto', messages)
    assertSameSearchDecision(resolutions, true)
    assert.equal(shouldUseServerWebSearch(messages), true)
  })

  test('searches when checking the current contents of a URL', async () => {
    const messages = userMessage('https://openai.com 홈페이지에 지금 뭐라고 나오는지 확인해줘')
    const resolutions = await resolveAcrossImplementations('auto', messages)
    assertSameSearchDecision(resolutions, true)
    assert.equal(shouldUseServerWebSearch(messages), true)
  })
})

describe('forced modes', () => {
  test('ON always searches, even for an obvious no-search question', async () => {
    const resolutions = await resolveAcrossImplementations(
      'on',
      userMessage('안녕'),
      () => new AbortController().signal,
    )
    assertSameSearchDecision(resolutions, true)
    for (const { resolution } of resolutions) assert.equal(resolution.mode, 'on')
  })

  test('OFF never searches, even for live news', async () => {
    const resolutions = await resolveAcrossImplementations(
      'off',
      userMessage('오늘 뉴스 알려줘'),
      () => new AbortController().signal,
    )
    assertSameSearchDecision(resolutions, false)
    for (const { resolution } of resolutions) assert.equal(resolution.mode, 'off')
  })
})

describe('follow-up context', () => {
  const priorSearchConversation: TestMessage[] = [
    { role: 'user', content: '오늘 OpenAI에서 발표한 게 뭐야?', webSearchMode: 'auto' },
    {
      role: 'assistant',
      content: '첫 번째 발표와 두 번째 발표를 정리한 답변입니다.',
      webSearchStatus: 'used',
    },
  ]

  test('reuses a prior searched answer instead of repeating the search', async () => {
    const messages = [
      ...priorSearchConversation,
      { role: 'user' as const, content: '그중 두 번째 거 자세히 설명해줘' },
    ]
    const resolutions = await resolveAcrossImplementations('auto', messages)
    assertSameSearchDecision(resolutions, false)
    assert.equal(shouldUseServerWebSearch(messages), false)
  })

  test('searches again when the user explicitly asks to verify freshness', async () => {
    const messages = [
      ...priorSearchConversation,
      { role: 'user' as const, content: '그게 지금도 맞는지 다시 확인해줘' },
    ]
    const resolutions = await resolveAcrossImplementations('auto', messages)
    assertSameSearchDecision(resolutions, true)
    assert.equal(shouldUseServerWebSearch(messages), true)
  })
})
