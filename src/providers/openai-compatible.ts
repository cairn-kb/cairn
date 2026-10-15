import OpenAI from "openai"
import { buildPrompt } from "../prompt"
import type { Claim } from "@cairn-kb/protocol/types"
import type { ModelInfo, Provider, ProviderConfig } from "./types"

/** Ollama's OpenAI-compatible endpoint — the common case, so it is the default. */
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"

/**
 * An abstract is capped at 40 words by the shared guidance — under 100 tokens.
 * Everything above that is headroom for models that reason before answering,
 * because `max_tokens` bounds the thinking as well as the answer.
 *
 * Raised from 512 after `openrouter/free` truncated on every call. The reason
 * 512 looked sufficient is that reasoning behind an OpenAI-shaped endpoint used
 * to be unusual; it is now the norm on hosted routers. Of the 21 free models
 * OpenRouter served when this was changed, every text model advertised
 * reasoning support — so cairn's own advice to "pick a model that does not
 * reason at length" had no answer available.
 *
 * A cap costs nothing when it is not reached: `max_tokens` is a ceiling, not a
 * reservation, so a model that answers in 90 tokens bills 90 whether this says
 * 512 or 2048. The only case a larger number changes is the one where the
 * alternative was a truncated answer and no abstract at all. The Anthropic
 * provider reached the same conclusion first, for the same reason.
 */
export const DEFAULT_MAX_TOKENS = 2048

const KEY_ENV_VAR = "OPENAI_API_KEY"

function client(cfg: ProviderConfig, fallbackBaseUrl?: string): OpenAI {
  return new OpenAI({
    // Ollama ignores the key but the SDK requires a non-empty one, so the
    // placeholder stands in for the `compatible` provider — the one with a
    // fallback endpoint — and ONLY for it. Handing it to real OpenAI would
    // send `Bearer unused` and turn a missing key into an unexplained 401,
    // replacing the SDK's own "the OPENAI_API_KEY variable is missing".
    apiKey: cfg.apiKey ?? (fallbackBaseUrl ? "unused" : undefined),
    baseURL: cfg.baseUrl ?? fallbackBaseUrl,
    fetch: cfg.fetchImpl,
  })
}

async function listFrom(cfg: ProviderConfig, fallbackBaseUrl?: string): Promise<ModelInfo[]> {
  const page = await client(cfg, fallbackBaseUrl).models.list()
  return page.data.map((m) => ({ id: m.id, label: m.id }))
}

async function generateFrom(
  claim: Claim,
  cfg: ProviderConfig,
  fallbackBaseUrl?: string,
): Promise<string> {
  const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS
  const res = await client(cfg, fallbackBaseUrl).chat.completions.create({
    model: cfg.model,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: buildPrompt(claim) }],
  })
  const choice = res.choices[0]
  // Checked before the text, so the reason names the cap. Raising it is a
  // different fix from restarting a model that is down.
  if (choice?.finish_reason === "length") {
    throw new Error(
      `cut off at the ${maxTokens}-token cap (raise maxTokens, or pick a model that does not reason at length)`,
    )
  }
  // Trim first, then check: a whitespace-only reply is truthy, and an empty
  // abstract is worse than none — it shows on the map as a blank entry.
  const text = choice?.message?.content?.trim()
  if (!text) throw new Error("empty response")
  return text
}

export const compatible: Provider = {
  id: "compatible",
  label: "Ollama or another OpenAI-compatible endpoint",
  // No vendor, so no conventional variable to read.
  keyEnvVar: null,
  // False means "not required" — Ollama needs none. The picker still offers to
  // enter one, because this same provider pointed at OpenRouter does need it.
  needsKey: () => false,
  list: (cfg) => listFrom(cfg, OLLAMA_BASE_URL),
  generate: (claim, cfg) => generateFrom(claim, cfg, OLLAMA_BASE_URL),
}

export const openai: Provider = {
  id: "openai",
  label: "OpenAI",
  keyEnvVar: KEY_ENV_VAR,
  needsKey: (env) => !env[KEY_ENV_VAR],
  list: (cfg) => listFrom(cfg),
  generate: (claim, cfg) => generateFrom(claim, cfg),
}
