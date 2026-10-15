import { plausibleAbstract } from "./abstract"
import { providerById, resolveBaseUrl, resolveKey } from "./providers"
import type { Provider, ProviderConfig } from "./providers"
import type { GenerationConfig } from "./config"
import type { Claim } from "@cairn-kb/protocol/types"

export { buildPrompt } from "./prompt"

/**
 * Abstract generation for claims that arrived without one — imports, mostly.
 *
 * Deliberately offline: this is never called from the approval path. A model
 * outage there would leave a claim pending with nothing logged, which in the
 * event log is indistinguishable from a human abandoning the queue — faking the
 * signal the product exists to measure.
 */

export interface ResolvedGeneration extends ProviderConfig {
  provider: Provider
}

/**
 * Undefined for anything that is not a positive integer, so a typo in the
 * environment falls back to the stored value rather than reaching the API as
 * NaN and failing every call with an error naming neither.
 */
function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw)
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * Flag → environment → stored.
 *
 * The environment wins over the stored value so a key you deliberately
 * exported is never shadowed by one cairn wrote months ago — and "the
 * environment" includes the provider's own variable, not just CAIRN_MODEL_KEY
 * (see resolveKey). CAIRN_MODEL and CAIRN_MODEL_URL keep working because
 * people have them in muscle memory.
 */
export function resolveGeneration(
  stored: GenerationConfig | null,
  env: Record<string, string | undefined>,
): ResolvedGeneration | null {
  if (!stored) return null
  const provider = providerById(stored.provider)
  if (!provider) return null
  return {
    provider,
    model: env.CAIRN_MODEL?.trim() || stored.model,
    baseUrl: resolveBaseUrl(undefined, env, stored.baseUrl),
    apiKey: resolveKey(provider, env, stored.apiKey),
    // Carried through, or the stored cap would be written by `cairn model` and
    // then silently ignored by the backfill that needs it. Same
    // environment-over-stored order as the model and the endpoint, and the same
    // reason: a value deliberately exported now should not be shadowed by one
    // cairn wrote months ago.
    maxTokens: positiveInt(env.CAIRN_MODEL_MAX_TOKENS) ?? stored.maxTokens ?? undefined,
  }
}

export async function generateAbstract(claim: Claim, resolved: ResolvedGeneration): Promise<string> {
  // Same gate as `cairn model --verify`. A rejected reply throws, so the
  // backfill records it as this claim's failure and leaves the abstract null.
  return plausibleAbstract(await resolved.provider.generate(claim, resolved))
}
