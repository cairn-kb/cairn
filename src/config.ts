import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
// Imported rather than re-listed: a hand-written copy beside the registry is
// how a fourth provider passes every provider test while readConfig silently
// drops its generation block.
import { PROVIDER_IDS } from "./providers"
import type { ProviderId } from "./providers"

/** How abstracts get generated. Null until `cairn model` has run. */
export interface GenerationConfig {
  provider: ProviderId
  model: string
  /** OpenAI-shaped providers only. */
  baseUrl: string | null
  /** Null when the key comes from the environment, which is the better path. */
  apiKey: string | null
  /**
   * Overrides the provider's own cap. Null means use it.
   *
   * Reasoning models bound thinking PLUS the answer with `max_tokens`, so a cap
   * sized for a 40-word abstract truncates them before they answer. The
   * Anthropic provider already carries a larger default for that reason; this
   * is the escape hatch for every OpenAI-shaped endpoint that turns out to sit
   * in front of a model that reasons — which, on OpenRouter's free tier, is all
   * of them.
   */
  maxTokens: number | null
}

/** The hosted store credential, minted by `cairn login`. Null until then. */
export interface AuthConfig {
  token: string
  orgId: string
  orgSlug: string
  apiUrl: string
  user: string | null
}

/**
 * Local, per-install settings. Deliberately separate from the store's claims
 * and events: this is machine state, not knowledge, and it must survive a
 * store rebuild.
 */
export type Mode = "local" | "team"

export interface CairnConfig {
  /** Random per install. Never derived from the machine — that would fingerprint it. */
  installId: string
  /** Opt-in. False until a human says otherwise, including across upgrades. */
  telemetry: boolean
  /** ISO timestamp of the last successful send, or null. */
  lastSentAt: string | null
  generation: GenerationConfig | null
  /**
   * The hosted store credential. Joins this file rather than a second one —
   * the file is already written 0600, and a token is not a different kind of
   * secret than an API key.
   */
  auth: AuthConfig | null
  /**
   * Which store this root talks to. Chosen out loud at `init`, never inferred
   * from the presence or absence of `auth` — a store selected by what happens
   * to be missing is a fallback removed on purpose, wearing a different hat.
   */
  mode: Mode
}

const file = (root: string) => join(root, "config.json")

export function newConfig(telemetry: boolean, uuid: string = crypto.randomUUID()): CairnConfig {
  // Team, not local: a fresh config defaults to the store every install had
  // before local mode existed. A caller choosing local says so — `{ ...newConfig(t),
  // mode: "local" }` — which is the same spread the auth and generation call
  // sites already use.
  return { installId: uuid, telemetry, lastSentAt: null, generation: null, auth: null, mode: "team" }
}

/** Null when absent or unparseable — a corrupt config is a thing to report, not to die on. */
export async function readConfig(root: string): Promise<CairnConfig | null> {
  try {
    const raw = JSON.parse(await readFile(file(root), "utf-8")) as Partial<CairnConfig>
    if (typeof raw.installId !== "string" || typeof raw.telemetry !== "boolean") return null

    const g = raw.generation as Partial<GenerationConfig> | undefined
    // Half a config is worse than none: it would send a request with an empty
    // model name and report a failure nobody can act on.
    const generation =
      g && typeof g.model === "string" && g.model.trim() !== "" &&
      PROVIDER_IDS.includes(g.provider as ProviderId)
        ? {
            provider: g.provider as ProviderId,
            model: g.model,
            baseUrl: typeof g.baseUrl === "string" ? g.baseUrl : null,
            apiKey: typeof g.apiKey === "string" ? g.apiKey : null,
            // A cap that is not a positive integer is dropped rather than
            // passed on: sending `max_tokens: 0` or `-1` fails every call in a
            // way the operator cannot act on, where falling back to the
            // provider's own default at least works.
            maxTokens:
              typeof g.maxTokens === "number" &&
              Number.isInteger(g.maxTokens) &&
              g.maxTokens > 0
                ? g.maxTokens
                : null,
          }
        : null

    const a = raw.auth as Partial<AuthConfig> | undefined
    // Same rule as generation: a half-written block is worse than none — it
    // would send requests with an empty token and report a failure the
    // operator cannot act on other than `cairn login` again anyway.
    const auth =
      a && typeof a.token === "string" && a.token.trim() !== "" &&
      typeof a.orgId === "string" && typeof a.orgSlug === "string" && typeof a.apiUrl === "string"
        ? {
            token: a.token,
            orgId: a.orgId,
            orgSlug: a.orgSlug,
            apiUrl: a.apiUrl,
            user: typeof a.user === "string" ? a.user : null,
          }
        : null

    return {
      installId: raw.installId,
      telemetry: raw.telemetry,
      lastSentAt: typeof raw.lastSentAt === "string" ? raw.lastSentAt : null,
      generation,
      auth,
      // Absent or unrecognised reads as team. Every install predating this
      // field is hosted-only, so the default has to be the status quo — a
      // missing field must not silently relocate anyone's knowledge.
      mode: raw.mode === "local" ? "local" : "team",
    }
  } catch {
    return null
  }
}

/**
 * Written atomically at 0600, because this file can hold an API key.
 *
 * The mode is applied when the temp file is CREATED, not after the rename —
 * `rename` preserves whatever mode the temp file had, so setting it afterwards
 * leaves a window where the key is world-readable on a shared machine.
 */
export async function writeConfig(root: string, cfg: CairnConfig): Promise<void> {
  const path = file(root)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.cairn-${process.pid}-${Date.now()}.tmp`
  try {
    const handle = await open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(cfg, null, 2) + "\n", "utf-8")
    } finally {
      await handle.close()
    }
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
