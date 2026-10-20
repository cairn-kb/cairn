import { updateConfig } from "./config"
import type { CairnConfig } from "./config"

const MIN_MS = 60_000
const DAY_MS = 86_400_000

/** The exact wire strings. An en dash — U+2013 — sits in the two middle
 *  buckets, not a hyphen, because that is what the hosted schema expects. */
export type FirstAnswer = "<5m" | "5–10m" | "10–30m" | ">30m" | "never"

/**
 * The bucket to report, or null when there is nothing to say yet — not the
 * same as `"never"`, which is itself a bucket reported exactly once.
 *
 * Measured from `initCompletedAt` to `firstAnswerAt`, both set elsewhere:
 * `init` sets the first when it finishes (`runInitCommand`), and the MCP
 * server's search handler sets the second on the first hit from a real agent
 * session — never from `init`'s own demonstration search, which never
 * reaches that handler. `"never"` fires only once at least 24 hours have
 * passed with no hit recorded, and `firstAnswerReported` stops this from
 * returning anything at all once a bucket has already gone out on a ping.
 */
export function firstAnswerBucket(cfg: CairnConfig, now: number): FirstAnswer | null {
  if (cfg.firstAnswerReported) return null
  if (cfg.initCompletedAt === null) return null
  const init = Date.parse(cfg.initCompletedAt)
  if (Number.isNaN(init)) return null

  if (cfg.firstAnswerAt !== null) {
    const hit = Date.parse(cfg.firstAnswerAt)
    if (Number.isNaN(hit)) return null
    const elapsed = hit - init
    if (elapsed < 5 * MIN_MS) return "<5m"
    if (elapsed < 10 * MIN_MS) return "5–10m"
    if (elapsed < 30 * MIN_MS) return "10–30m"
    return ">30m"
  }

  return now - init >= DAY_MS ? "never" : null
}

/**
 * Best-effort, and that word is load-bearing: this is instrumentation called
 * from the MCP server's search handler, which must never let a telemetry
 * write turn a successful search into a broken one. Every failure path here
 * is silently swallowed.
 *
 * Records only the FIRST qualifying hit — a later call with `initCompletedAt`
 * already answered leaves `firstAnswerAt` alone — and only with consent:
 * nothing is stored for a telemetry-off install.
 *
 * Owns exactly one field, `firstAnswerAt`, through `updateConfig` — never a
 * hand-written `writeConfig` of a snapshot read earlier — so this cannot
 * land between `sendTelemetry`'s own read and write and have its answer
 * overwritten by that stale copy, nor restore a `lastSentAt`/
 * `firstAnswerReported` that a concurrent ping already advanced.
 */
export async function recordSearchHit(root: string, hits: number, now: number = Date.now()): Promise<void> {
  if (hits < 1) return
  try {
    await updateConfig(root, (latest) => {
      if (latest.telemetry !== true) return null
      if (latest.initCompletedAt === null) return null
      if (latest.firstAnswerAt !== null) return null
      return { firstAnswerAt: new Date(now).toISOString() }
    })
  } catch {
    // Deliberately total — see above.
  }
}
