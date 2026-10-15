import { anthropic } from "./anthropic"
import { compatible, openai } from "./openai-compatible"
import type { Provider, ProviderId } from "./types"

export type { ModelInfo, Provider, ProviderConfig, ProviderId } from "./types"

/** The one place the providers are enumerated. */
const REGISTRY: Provider[] = [compatible, anthropic, openai]

export function allProviders(): Provider[] {
  return REGISTRY
}

/** Null rather than a throw: the id comes from a file a human can edit. */
export function providerById(id: ProviderId): Provider | null {
  return REGISTRY.find((p) => p.id === id) ?? null
}

/**
 * Derived, never hand-listed. A fourth provider added to the registry has to
 * reach `readConfig`'s validation and the `--provider` flag on its own — a
 * literal copy in either place would silently drop that provider's config
 * block while every provider test passed.
 */
export const PROVIDER_IDS: ProviderId[] = REGISTRY.map((p) => p.id)

/**
 * Where a key came from, named the way somebody would go looking for it:
 * `CAIRN_MODEL_KEY`, the provider's own variable (`ANTHROPIC_API_KEY`),
 * `stored`, or `none`.
 */
export type KeySource = "CAIRN_MODEL_KEY" | "stored" | "none" | (string & {})

export interface KeyResolution {
  key: string | undefined
  source: KeySource
}

/**
 * The one place the environment → stored order is implemented.
 *
 * "The environment" is CAIRN_MODEL_KEY *and* the provider's own variable, in
 * that order. Defining it as CAIRN_MODEL_KEY alone is what let a key cairn
 * stored months ago shadow an ANTHROPIC_API_KEY deliberately exported to
 * replace a revoked one — and it left the picker deciding no key was needed
 * while the client sent none.
 *
 * Returns the provenance as well as the key so `doctor` can report which
 * source won without a second copy of the ordering.
 */
export function keyProvenance(
  provider: Provider,
  env: Record<string, string | undefined>,
  storedKey?: string | null,
): KeyResolution {
  const shared = env.CAIRN_MODEL_KEY?.trim()
  if (shared) return { key: shared, source: "CAIRN_MODEL_KEY" }
  if (provider.keyEnvVar) {
    const own = env[provider.keyEnvVar]?.trim()
    if (own) return { key: own, source: provider.keyEnvVar }
  }
  const stored = storedKey?.trim()
  if (stored) return { key: stored, source: "stored" }
  return { key: undefined, source: "none" }
}

/**
 * The endpoint, on the same flag → environment → stored order as the key.
 *
 * One function because the three call sites drifted: `--list` read the flag
 * alone and so listed Ollama on localhost while a custom endpoint was
 * configured, and the picker read CAIRN_MODEL_URL alone and so accepted
 * `--base-url` and silently dropped it.
 */
export function resolveBaseUrl(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  storedBaseUrl?: string | null,
): string | undefined {
  return flag?.trim() || env.CAIRN_MODEL_URL?.trim() || storedBaseUrl?.trim() || undefined
}

/** The key alone, for the callers that do not report where it came from. */
export function resolveKey(
  provider: Provider,
  env: Record<string, string | undefined>,
  storedKey?: string | null,
): string | undefined {
  return keyProvenance(provider, env, storedKey).key
}
