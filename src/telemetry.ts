import { newConfig, readConfig, writeConfig } from "./config"
import type { CairnConfig } from "./config"
import { firstAnswerBucket } from "./first-answer-metric"
import type { FirstAnswer } from "./first-answer-metric"
import { VERSION } from "./version"
import type { Stats } from "@cairn-kb/protocol/stats"

/**
 * Where a ping goes.
 *
 * Overridable through `CAIRN_TELEMETRY_URL`, which is how a test points at a
 * fixture rather than at the real endpoint.
 */
export const TELEMETRY_URL = "https://telemetry.cairn-kb.dev/v1/ping"

/**
 * Deters drive-by noise, and nothing more. It ships inside a public binary, so
 * anyone who wants it has it — that is a deliberate trade, not an oversight,
 * and it is acceptable because the endpoint accepts counts and returns nothing.
 * **Do not "fix" this into a secret**: it cannot be one, and treating it as one
 * would buy a false sense of security while breaking every installed binary on
 * rotation.
 */
export const WRITE_KEY = "cairn-3f9c1d7a5b2e4086" // gitleaks:allow — not a secret, see comment above

/** How long a ping may take before it is abandoned. */
export const TIMEOUT_MS = 2000

const DAY_MS = 86_400_000

/**
 * Exactly these fields — every one a count or a version string. No
 * claim text, no repo names, no paths, no username. Built from `Stats` by
 * naming each field rather than spreading it, so a field added to `Stats`
 * later cannot reach the wire by accident.
 */
export interface TelemetryPayload {
  install: string
  version: string
  platform: string
  proposed: number
  approved: number
  rejected: number
  reads: number
  sessions: number
  pendingAgeDays: number | null
  generatedAbstracts: number
  /**
   * How long it took this install from `init` finishing to an agent's first
   * useful search, as one bucket — never a raw duration, and never sent as
   * `null`. Absent whenever there is no bucket to report yet; the hosted
   * endpoint's schema accepts this field only as optional, so it must be
   * omitted rather than nulled.
   */
  firstAnswer?: FirstAnswer
}

export function buildPayload(
  config: CairnConfig,
  stats: Stats,
  version: string,
  platform: string,
  now: number = Date.now(),
): TelemetryPayload {
  const bucket = firstAnswerBucket(config, now)
  return {
    install: config.installId,
    version,
    platform,
    proposed: stats.proposed,
    approved: stats.approved,
    rejected: stats.rejected,
    reads: stats.reads,
    sessions: stats.sessions,
    pendingAgeDays: stats.pendingAgeDays,
    generatedAbstracts: stats.generatedAbstracts,
    ...(bucket !== null ? { firstAnswer: bucket } : {}),
  }
}

/**
 * Exactly what the consent screen shows — built with `buildPayload`, from a
 * sample config and zero stats, never hand-written: a field added to the
 * wire that is not named here cannot reach a user's eyes before it reaches
 * the endpoint, because this is the same function call that builds the real
 * payload. The sample's `firstAnswer` is `"5–10m"`, so the field appears on
 * the screen it is meant to demonstrate rather than only on the installs that
 * happen to hit it.
 */
export function consentPreview(): string {
  const sampleUuid = "a3f00000-0000-0000-0000-000000000000"
  const sample: CairnConfig = {
    ...newConfig(true, sampleUuid),
    installId: `${sampleUuid.slice(0, 3)}…`,
    initCompletedAt: new Date(0).toISOString(),
    firstAnswerAt: new Date(7 * 60_000).toISOString(),
  }
  const zeroStats: Stats = {
    proposed: 0, approved: 0, edited: 0, rejected: 0, approveRate: null,
    reads: 0, deniedReads: 0, searches: 0, sessions: 0,
    pendingAgeDays: null, generatedAbstracts: 0,
  }
  const payload = buildPayload(sample, zeroStats, VERSION, `${process.platform}-${process.arch}`)
  return `${JSON.stringify(payload)}\nNo claim text, no repo names, no paths.`
}

/**
 * Off until someone says yes, and at most once a day after that. An upgrade
 * never re-asks and never re-enables: consent lives in the config file, which
 * `cairn init` preserves across runs.
 */
export function dueToSend(config: CairnConfig, now: number): boolean {
  if (config.telemetry !== true) return false
  if (config.lastSentAt === null) return true
  const last = Date.parse(config.lastSentAt)
  // An unparseable timestamp is treated as "never sent" rather than as a
  // reason to stop for ever.
  return Number.isNaN(last) || now - last >= DAY_MS
}

export interface TelemetryDeps {
  root: string
  version: string
  platform: string
  /** Read lazily: an opted-out install must not pay for stats it will not send. */
  stats: () => Promise<Stats>
  /** Narrowed on purpose, matching `DoctorDeps`: a test double should not have
   *  to implement `fetch.preconnect` to stand in for one call. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  env?: Record<string, string | undefined>
  now?: number
  timeoutMs?: number
}

export type TelemetryOutcome = "sent" | "skipped" | "failed"

/**
 * The two ways to silence one run without touching consent: our own
 * CAIRN_TELEMETRY=0, and the cross-tool DO_NOT_TRACK convention
 * (consoledonottrack.com) — any value but "", "0" or "false".
 */
export function trackingDisabled(env: Record<string, string | undefined>): boolean {
  if (env.CAIRN_TELEMETRY === "0") return true
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase()
  return dnt !== undefined && dnt !== "" && dnt !== "0" && dnt !== "false"
}

/**
 * Best-effort, and that word is load-bearing: **this may never block, slow or
 * fail a command.** Same rule the codebase applies to abstract generation —
 * enrichment must not be able to damage the thing it enriches. Every failure
 * path here returns "failed" and nothing else: no throw, no log, no exit code.
 * A telemetry problem is visible only in `cairn doctor`.
 *
 * `lastSentAt` advances only on success, so a bad day is retried tomorrow
 * rather than turned into a silent 24-hour hole.
 */
export async function sendTelemetry(deps: TelemetryDeps): Promise<TelemetryOutcome> {
  try {
    // One run made silent, without touching what the operator consented to.
    // `cairn doctor` sets this on the `cairn mcp` it spawns: that child is an
    // ordinary CLI run with the AGENT's root, so without this a read-only
    // command caused a ping from a config the invocation never named.
    // It is also the documented way to script a guaranteed-silent run.
    // DO_NOT_TRACK is honoured the same way.
    if (trackingDisabled(deps.env ?? {})) return "skipped"
    const now = deps.now ?? Date.now()
    const config = await readConfig(deps.root)
    if (!config || !dueToSend(config, now)) return "skipped"

    const payload = buildPayload(config, await deps.stats(), deps.version, deps.platform, now)
    const url = deps.env?.CAIRN_TELEMETRY_URL ?? TELEMETRY_URL
    const doFetch = deps.fetchImpl ?? fetch
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cairn-key": WRITE_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    })
    if (!res.ok) return "failed"
    await writeConfig(deps.root, {
      ...config,
      lastSentAt: new Date(now).toISOString(),
      // Only when the sent payload actually carried the bucket — this is
      // what makes the report go out exactly once, rather than retried
      // forever or marked done before it was ever said.
      firstAnswerReported: config.firstAnswerReported || payload.firstAnswer !== undefined,
    })
    return "sent"
  } catch {
    // Deliberately total. Anything that reaches here — an unreadable event
    // log, DNS, a timeout, a full disk on the config write — is a telemetry
    // problem, and a telemetry problem must never become the user's problem.
    return "failed"
  }
}
