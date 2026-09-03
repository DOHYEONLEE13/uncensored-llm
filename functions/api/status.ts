type AiEnv = {
  ORCAROUTER_API_KEY?: string
  OPENROUTER_API_KEY?: string
  NANOGPT_API_KEY?: string
}

type PagesContext = {
  request: Request
  env: AiEnv
}

const ORCAROUTER_MODELS = ['obsidian/Qwen3.8-27B', 'qwen/qwen3.8-27b-free'] as const
const OPENROUTER_MODELS = [
  'openrouter/free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
] as const
const NANOGPT_MODELS = [] as const
const DEFAULT_MODEL = ORCAROUTER_MODELS[0]

function isConfigured(apiKey: string | undefined, placeholder: string) {
  const normalized = apiKey?.trim()
  return Boolean(normalized && normalized !== placeholder)
}

export function onRequest({ request, env }: PagesContext) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const providers = {
    orcarouter: isConfigured(env.ORCAROUTER_API_KEY, '여기에_내_OrcaRouter_API_Key'),
    openrouter: isConfigured(env.OPENROUTER_API_KEY, '여기에_내_OpenRouter_API_Key'),
    nanogpt: isConfigured(env.NANOGPT_API_KEY, '여기에_내_NanoGPT_API_Key'),
  }
  const models = [
    ...(providers.orcarouter ? ORCAROUTER_MODELS : []),
    ...(providers.openrouter ? OPENROUTER_MODELS : []),
    ...(providers.nanogpt ? NANOGPT_MODELS : []),
  ]

  return Response.json(
    {
      configured: models.length > 0,
      model: models[0] ?? DEFAULT_MODEL,
      models,
      providers,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
