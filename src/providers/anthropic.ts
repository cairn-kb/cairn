import Anthropic from "@anthropic-ai/sdk"
import { buildPrompt } from "../prompt"
import type { Claim } from "@cairn-kb/protocol/types"
import type { ModelInfo, Provider, ProviderConfig } from "./types"

/**
 * Larger than the OpenAI-shaped default on purpose.
 *
 * An abstract needs under 100 tokens, but current Claude models run thinking by
 * default and `max_tokens` bounds thinking PLUS answer. A 512 cap here would
 * return empty content and trip the truncation error on almost every call.
 *
 * Thinking is deliberately not disabled to reclaim the budget: disabling it is
 * documented to sometimes leak `<thinking>` tags into the visible response, and
 * for cairn a leaked tag lands in a stored abstract and shows on the map.
 * Raising a number is the cheaper defence.
 */
export const ANTHROPIC_MAX_TOKENS = 2048

function client(cfg: ProviderConfig): Anthropic {
  return new Anthropic({ apiKey: cfg.apiKey, fetch: cfg.fetchImpl })
}

const KEY_ENV_VAR = "ANTHROPIC_API_KEY"

export const anthropic: Provider = {
  id: "anthropic",
  label: "Anthropic",
  keyEnvVar: KEY_ENV_VAR,

  // Asked in terms of the same variable resolution uses, so the picker cannot
  // decide a key is present while resolution decides it is absent.
  //
  // The SDK also resolves an `ant auth login` profile, but that is not visible
  // from the environment alone — so a profile user simply sees the key prompt
  // and can skip it. Over-asking is safer here than a failed run.
  needsKey: (env) => !env[KEY_ENV_VAR],

  async list(cfg): Promise<ModelInfo[]> {
    const out: ModelInfo[] = []
    for await (const m of client(cfg).models.list()) {
      const window = m.max_input_tokens ? `${Math.round(m.max_input_tokens / 1000)}K context` : undefined
      out.push({ id: m.id, label: m.display_name ?? m.id, hint: window })
    }
    return out
  },

  async generate(claim: Claim, cfg): Promise<string> {
    const maxTokens = cfg.maxTokens ?? ANTHROPIC_MAX_TOKENS
    // NO `temperature`. It was removed on every current Claude model and
    // sending it is a 400 — this is the difference the seam exists to hold.
    const res = await client(cfg).messages.create({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: buildPrompt(claim) }],
    })
    if (res.stop_reason === "max_tokens") {
      throw new Error(
        `cut off at the ${maxTokens}-token cap (raise maxTokens, or pick a model that does not reason at length)`,
      )
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
    if (!text) throw new Error("empty response")
    return text
  },
}
