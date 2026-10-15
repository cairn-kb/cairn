import type { Claim } from "@cairn-kb/protocol/types"

/**
 * `compatible` is any OpenAI-shaped endpoint — Ollama by default, but equally
 * LM Studio, vLLM, OpenRouter or Together via `baseUrl`. It is deliberately not
 * called "ollama": the same code path serves all of them, and storing "ollama"
 * for an OpenRouter endpoint would be a lie in the config file.
 */
export type ProviderId = "anthropic" | "openai" | "compatible"

export interface ModelInfo {
  id: string
  label: string
  /** Context window, price tier — whatever the provider actually gives. */
  hint?: string
}

export interface ProviderConfig {
  model: string
  apiKey?: string
  /** OpenAI-shaped providers only; ignored by Anthropic. */
  baseUrl?: string
  maxTokens?: number
  /** The single injection point. Both SDKs accept a custom fetch. */
  fetchImpl?: typeof fetch
}

export interface Provider {
  readonly id: ProviderId
  readonly label: string
  /**
   * The variable this provider's own SDK documents — the one people actually
   * export. Null for `compatible`, which has no single vendor and no
   * conventional variable behind it.
   *
   * It exists so key resolution is not defined as "CAIRN_MODEL_KEY or
   * nothing": that reading made a stored key beat a deliberately exported
   * ANTHROPIC_API_KEY, which is the opposite of what the
   * environment → stored order promises.
   */
  readonly keyEnvVar: string | null
  /**
   * Whether a key is REQUIRED once the environment has been consulted.
   *
   * `compatible` returns false — Ollama needs none — but the picker still
   * offers to enter one, because the same provider pointed at OpenRouter does
   * need it. Required and accepted are different questions, and conflating
   * them would lock people out of paid OpenAI-compatible endpoints.
   */
  needsKey(env: Record<string, string | undefined>): boolean
  /** What this provider is serving right now. */
  list(cfg: ProviderConfig): Promise<ModelInfo[]>
  generate(claim: Claim, cfg: ProviderConfig): Promise<string>
}
