import { plausibleAbstract } from "./abstract"
import { rootMessage } from "./errors"
import { providerById, resolveBaseUrl, resolveKey } from "./providers"
import type { GenerationConfig } from "./config"
import type { ModelInfo, ProviderId } from "./providers"
import type { Claim, Store } from "@cairn-kb/protocol/types"

/**
 * Used when the store has nothing to verify against — a fresh install. Real
 * enough to exercise the prompt and show a representative abstract.
 */
export const SAMPLE_CLAIM: Claim = {
  id: "sample",
  status: "approved",
  claim: "Deploys go out on Tuesdays, never on Fridays",
  body:
    "Friday deploys leave nobody around to roll back over the weekend. " +
    "Tuesday gives two clear days to notice a regression before the week ends.",
  source: { author: "cairn", agent: "sample", repo: null, session: null },
  created: "2026-01-01T00:00:00.000Z",
  reviewed: null, reviewer: null, retracted: null, overlaps: [], cites: [], abstract: null, abstractBy: null, tags: [],
}

/**
 * The smallest approved claim with no abstract.
 *
 * Smallest matters: a cold run against a 15k-token import took 149 seconds, and
 * a verification step that feels hung is one people learn to skip.
 */
export async function smallestUnabstracted(store: Store): Promise<Claim | null> {
  const missing = (await store.list("approved")).filter((c) => !c.abstract?.trim())
  if (missing.length === 0) return null
  return missing.reduce((a, b) => ((a.body?.length ?? 0) <= (b.body?.length ?? 0) ? a : b))
}

/**
 * The claim `cairn model` generates against while proving out a provider.
 *
 * A space this machine cannot read degrades to the built-in sample rather than
 * failing the command: what is being verified here is the PROVIDER, and an
 * unrelated service being down must not block choosing a model. Announced
 * through `out`, never silently — an operator who thinks they verified against
 * their own claim deserves to know they did not.
 */
export async function verificationSubject(
  store: Store,
  out: (line: string) => void,
): Promise<Claim> {
  try {
    return (await smallestUnabstracted(store)) ?? SAMPLE_CLAIM
  } catch (err) {
    out(`could not read your space for a sample claim (${rootMessage(err)}) — using the built-in one`)
    return SAMPLE_CLAIM
  }
}

export interface ModelCommandDeps {
  store: Store
  env: Record<string, string | undefined>
  /** `--base-url`. Takes the flag position ahead of CAIRN_MODEL_URL. */
  baseUrl?: string
  /**
   * `--max-tokens`. Undefined leaves the provider's own cap in place, which is
   * right for anything that answers directly; raising it is what makes a model
   * that reasons before answering usable, since `max_tokens` bounds the
   * thinking as well as the answer.
   */
  maxTokens?: number
  /** Null means the operator cancelled. */
  resolveProvider: () => Promise<ProviderId | null>
  resolveModel: (models: ModelInfo[]) => Promise<string | null>
  /** Null means "no key entered" — not a cancellation. */
  resolveKey: () => Promise<string | null>
  confirmKeep: (abstract: string, ms: number) => Promise<boolean | null>
  out: (line: string) => void
  fetchImpl?: typeof fetch
}

/**
 * Deliberately NOT a discriminated union: callers check `outcome` and then read
 * `generation`, and a union would make that a type error at every call site for
 * no safety gained — `generation` is present exactly when `outcome` is "saved".
 */
export interface ModelOutcome {
  outcome: "saved" | "cancelled" | "rejected"
  generation?: GenerationConfig
}

export async function runModelCommand(d: ModelCommandDeps): Promise<ModelOutcome> {
  const id = await d.resolveProvider()
  if (id === null) return { outcome: "cancelled" }

  const provider = providerById(id)
  if (!provider) return { outcome: "cancelled" }

  // Asked only when the environment has nothing. `compatible` reports no key
  // required, but the prompt still offers one — the same provider pointed at
  // OpenRouter needs it.
  const typed = provider.needsKey(d.env) || id === "compatible" ? await d.resolveKey() : null
  // A typed key is the flag position in flag → environment → stored; nothing is
  // stored yet at this point, so the environment is the only other source.
  const apiKey = typed ?? resolveKey(provider, d.env, null)
  // Resolved once and threaded into every call this command makes, including
  // the saved config: verifying against the provider's default (Ollama on
  // localhost, for `compatible`) while saving a custom endpoint would prove
  // nothing about the endpoint that actually gets used.
  const baseUrl = resolveBaseUrl(d.baseUrl, d.env, null)

  let models: ModelInfo[]
  try {
    models = await provider.list({ model: "", apiKey, baseUrl, fetchImpl: d.fetchImpl })
  } catch (err) {
    // Fails here, before anything is chosen — the earliest honest point.
    d.out(`could not read models from ${provider.label}: ${rootMessage(err)}`)
    return { outcome: "rejected" }
  }
  if (models.length === 0) {
    // Said plainly rather than left to become an empty
    // picker — resolveModel has no way to distinguish "nothing to choose from"
    // from "still loading".
    d.out(`${provider.label} is serving no models`)
    return { outcome: "rejected" }
  }

  const model = await d.resolveModel(models)
  if (model === null) return { outcome: "cancelled" }

  const subject = await verificationSubject(d.store, d.out)
  const started = Date.now()
  let abstract: string
  try {
    // Checked here, not just reported: a reply that is only non-empty proves
    // the endpoint answered, not that the model can write an abstract. The
    // same gate runs in backfill, so verifying and filling agree.
    abstract = plausibleAbstract(await provider.generate(subject, {
      model,
      apiKey,
      baseUrl,
      // The SAME cap that will be saved: verifying at the provider default and
      // then storing a different one would prove nothing about the config the
      // operator ends up with.
      maxTokens: d.maxTokens,
      fetchImpl: d.fetchImpl,
    }))
  } catch (err) {
    d.out(`${model} could not write an abstract: ${rootMessage(err)}`)
    return { outcome: "rejected" }
  }

  // Shown and discarded. cairn model never writes to the store or the event
  // log — that keeps it safe to run repeatedly while comparing models, and
  // keeps `generate` events meaning what they mean today.
  const keep = await d.confirmKeep(abstract, Date.now() - started)
  if (keep === null) return { outcome: "cancelled" }
  if (!keep) return { outcome: "rejected" }

  return {
    outcome: "saved",
    generation: {
      provider: id,
      model,
      baseUrl: baseUrl ?? null,
      // Only a key typed at the prompt is stored. One that came from the
      // environment stays there.
      apiKey: typed,
      maxTokens: d.maxTokens ?? null,
    },
  }
}
