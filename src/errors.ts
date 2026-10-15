/**
 * Error reporting shared by every path that talks to a provider.
 *
 * Deliberately dependency-free: it is imported by the CLI's command paths and
 * by `cairn model`, and anything it pulled in would be pulled into both.
 */

/**
 * SDKs (the OpenAI client in particular) wrap a transport failure in their own
 * error — "Connection error." — and put the actual reason on `.cause`. Reporting
 * the wrapper alone would tell someone "connection refused" was "Connection
 * error.", which is not something they can act on.
 */
export function rootMessage(err: unknown): string {
  let cur = err
  while (cur instanceof Error && cur.cause instanceof Error) cur = cur.cause
  return cur instanceof Error ? cur.message : String(cur)
}

/**
 * A rate limit is a fact about the endpoint, not about the request that hit it:
 * it says the next call fails too. Every other provider failure is about the
 * one request, which is why this is the single case a caller may treat as a
 * reason to stop rather than to record and move on.
 *
 * Walks the cause chain for the same reason `rootMessage` does — the OpenAI
 * client wraps the response it got, and the status can sit on either.
 */
export function isRateLimit(err: unknown): boolean {
  let cur: unknown = err
  while (cur instanceof Error) {
    if ((cur as { status?: unknown }).status === 429) return true
    cur = cur.cause
  }
  return false
}
