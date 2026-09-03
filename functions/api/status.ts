type OrcaRouterEnv = {
  ORCAROUTER_API_KEY?: string
}

type PagesContext = {
  request: Request
  env: OrcaRouterEnv
}

const ORCAROUTER_MODELS = ['obsidian/Qwen3.8-27B', 'qwen/qwen3.8-27b-free'] as const

export function onRequest({ request, env }: PagesContext) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const apiKey = env.ORCAROUTER_API_KEY?.trim()
  const configured = Boolean(apiKey && apiKey !== '여기에_내_OrcaRouter_API_Key')

  return Response.json(
    {
      configured,
      model: ORCAROUTER_MODELS[0],
      models: [...ORCAROUTER_MODELS],
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}
