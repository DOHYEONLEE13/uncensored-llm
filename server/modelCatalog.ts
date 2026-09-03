export type ProviderId = 'orcarouter' | 'openrouter' | 'nanogpt'

export type ModelMetadata = {
  id: string
  displayName: string
  provider: ProviderId
  contextWindow: number
  maxOutputTokens: number | null
  pricing: {
    promptPerMillion: number
    completionPerMillion: number
    currency: 'USD'
    unit: 'per_million_tokens'
    asOf: '2026-09-04'
  }
  capabilities: {
    reasoning: boolean
    reasoningControl: boolean
  }
}

export const ORCAROUTER_MODELS = [
  'obsidian/Qwen3.8-27B',
  'qwen/qwen3.8-27b-free',
] as const

export const OPENROUTER_MODELS = [
  'openrouter/free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
] as const

export const NANOGPT_MODELS = [
  'z-ai/glm-5.3-flash-uncensored',
  'qwen/qwen3.6-35b-a3b-uncensored',
  'qwen/qwen3.6-35b-a3b-uncensored:thinking',
  'qwen/qwen3.8-27b-uncensored',
  'qwen/qwen3.8-27b-uncensored:thinking',
  'TEE/gemma-4-26b-a4b-uncensored',
  'TEE/qwen3.6-35b-a3b-uncensored',
  'Gemma-4-31B-Gembrain-uncensored-heretic',
] as const

export const AI_MODELS = [
  ...ORCAROUTER_MODELS,
  ...OPENROUTER_MODELS,
  ...NANOGPT_MODELS,
] as const

export type AiModel = (typeof AI_MODELS)[number]

export const DEFAULT_MODEL: AiModel = ORCAROUTER_MODELS[0]

const pricing = (promptPerMillion: number, completionPerMillion: number) => ({
  promptPerMillion,
  completionPerMillion,
  currency: 'USD' as const,
  unit: 'per_million_tokens' as const,
  asOf: '2026-09-04' as const,
})

const metadata = (
  id: AiModel,
  displayName: string,
  provider: ProviderId,
  contextWindow: number,
  maxOutputTokens: number | null,
  promptPerMillion: number,
  completionPerMillion: number,
  reasoning: boolean,
): ModelMetadata => ({
  id,
  displayName,
  provider,
  contextWindow,
  maxOutputTokens,
  pricing: pricing(promptPerMillion, completionPerMillion),
  capabilities: { reasoning, reasoningControl: provider === 'nanogpt' && reasoning },
})

export const MODEL_CATALOG: Record<AiModel, ModelMetadata> = {
  'obsidian/Qwen3.8-27B': metadata(
    'obsidian/Qwen3.8-27B', 'Obsidian Qwen3.8-27B', 'orcarouter', 262_144, null, 0.4, 4.21, true,
  ),
  'qwen/qwen3.8-27b-free': metadata(
    'qwen/qwen3.8-27b-free', 'Qwen3.8-27B Free', 'orcarouter', 65_536, null, 0, 0, true,
  ),
  'openrouter/free': metadata(
    'openrouter/free', 'OpenRouter Free', 'openrouter', 200_000, null, 0, 0, true,
  ),
  'cognitivecomputations/dolphin-mistral-24b-venice-edition': metadata(
    'cognitivecomputations/dolphin-mistral-24b-venice-edition',
    'Dolphin Mistral 24B Venice Edition',
    'openrouter',
    128_000,
    8_192,
    0.2,
    0.9,
    false,
  ),
  'z-ai/glm-5.3-flash-uncensored': metadata(
    'z-ai/glm-5.3-flash-uncensored', 'GLM 5.3 Flash Uncensored', 'nanogpt', 1_048_576, 32_768, 0.35, 1.4, true,
  ),
  'qwen/qwen3.6-35b-a3b-uncensored': metadata(
    'qwen/qwen3.6-35b-a3b-uncensored', 'Qwen3.6 35B A3B Uncensored', 'nanogpt', 262_144, 32_768, 0.15, 0.95, true,
  ),
  'qwen/qwen3.6-35b-a3b-uncensored:thinking': metadata(
    'qwen/qwen3.6-35b-a3b-uncensored:thinking', 'Qwen3.6 35B A3B Uncensored (Thinking)', 'nanogpt', 262_144, 32_768, 0.15, 0.95, true,
  ),
  'qwen/qwen3.8-27b-uncensored': metadata(
    'qwen/qwen3.8-27b-uncensored', 'Qwen3.8 27B Uncensored', 'nanogpt', 262_144, 32_768, 0.25, 1.5, true,
  ),
  'qwen/qwen3.8-27b-uncensored:thinking': metadata(
    'qwen/qwen3.8-27b-uncensored:thinking', 'Qwen3.8 27B Uncensored (Thinking)', 'nanogpt', 262_144, 32_768, 0.25, 1.5, true,
  ),
  'TEE/gemma-4-26b-a4b-uncensored': metadata(
    'TEE/gemma-4-26b-a4b-uncensored', 'Gemma 4 26B A4B Uncensored (TEE)', 'nanogpt', 65_536, 65_536, 0.15, 0.7, false,
  ),
  'TEE/qwen3.6-35b-a3b-uncensored': metadata(
    'TEE/qwen3.6-35b-a3b-uncensored', 'Qwen3.6 35B A3B Uncensored (TEE)', 'nanogpt', 131_072, 131_072, 0.3, 1.5, true,
  ),
  'Gemma-4-31B-Gembrain-uncensored-heretic': metadata(
    'Gemma-4-31B-Gembrain-uncensored-heretic', 'Gemma 4 31B Gembrain Uncensored Heretic', 'nanogpt', 262_144, null, 0.306, 0.306, true,
  ),
}

export function isAiModel(value: string): value is AiModel {
  return Object.prototype.hasOwnProperty.call(MODEL_CATALOG, value)
}

export function getProviderIdForModel(model: AiModel): ProviderId {
  return MODEL_CATALOG[model].provider
}

export function getConfiguredModelMetadata(models: readonly AiModel[]) {
  return Object.fromEntries(models.map((model) => [model, MODEL_CATALOG[model]])) as Partial<
    Record<AiModel, ModelMetadata>
  >
}
