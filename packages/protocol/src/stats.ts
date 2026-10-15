import { APPROVE_KINDS, RESOLVE_KINDS } from "./event-kinds"

export type EventKind =
  | "propose"
  | "approve"
  | "reject"
  | "edit"
  /**
   * A document entering the space without ever having been reviewed.
   *
   * It is deliberately neither a proposal nor a review. Spelling an import as
   * `propose` + `approve` — the only two kinds that existed before — moved the
   * approve rate by the size of the import, and spelling it as `propose` alone
   * left every imported claim permanently unresolved in `pendingAgeDays`. It
   * appears in NEITHER APPROVE_KINDS nor RESOLVE_KINDS, and test/events.test.ts
   * pins that: it is the whole reason the kind exists.
   */
  | "import"
  | "curate"
  | "generate"
  | "map"
  | "read"
  | "search"
  /**
   * A claim leaving the space by becoming a document, not by being judged.
   *
   * Adoption REMOVES a claim — the only operation in this system that deletes
   * an approved claim — and a ledger that records arrivals but not removals
   * cannot explain why the claim count fell. It appears in neither
   * APPROVE_KINDS nor RESOLVE_KINDS: adoption is not a review, and counting it
   * as one would credit a human decision that never happened.
   */
  | "adopt"
  /**
   * A human withdrawing an approval they made.
   *
   * Its own kind for the same reason `import` and `adopt` have theirs: the
   * approve/reject guard in `FileStore.review` (src/store.ts) is correct and stays, so a
   * withdrawal cannot be spelled as a second review without moving
   * `approved`, `rejected` and `approveRate` for a claim nobody reviewed
   * twice. It appears in NEITHER APPROVE_KINDS nor RESOLVE_KINDS — the
   * original `approve` event remains, so the claim stays resolved and does
   * not reappear in `pendingAgeDays`.
   */
  | "retract"
  /**
   * A document attached to a claim as evidence, after the fact.
   *
   * Its own kind for the reason `import`, `adopt` and `retract` have theirs: a
   * grounding pass is not a review, and counting it as one would credit a
   * human decision nobody made. It appears in NEITHER `APPROVE_KINDS` nor
   * `RESOLVE_KINDS`. An agent may write one; that is the whole point, and it
   * is why `cite` is absent from `UNADOPTABLE_KINDS`.
   */
  | "cite"
  /**
   * A citation detached by a human. Human-only by construction — there is no
   * `team_knowledge_uncite`, so an agent cannot strip evidence that makes a
   * claim look weak. Unlike `cite`, its presence means a person curated this
   * claim's evidence, which is why it IS in `UNADOPTABLE_KINDS`.
   */
  | "uncite"

export interface KbEvent {
  kind: EventKind
  at: string
  id?: string
  meta?: Record<string, unknown>
}

export interface Stats {
  proposed: number
  /** Approvals, including edit-then-approve. */
  approved: number
  /** The subset of `approved` that were edited before approval. */
  edited: number
  rejected: number
  approveRate: number | null
  /** team_knowledge_map + team_knowledge_read calls, including reads denied by the approval gate. */
  reads: number
  /** Reads refused because the claim was not approved — asked, not served. */
  deniedReads: number
  /** team_knowledge_search calls, counted separately so they do not inflate `reads`. */
  searches: number
  /** Distinct sessions seen on team_knowledge_map, the denominator for reads-per-session. */
  sessions: number
  pendingAgeDays: number | null
  /**
   * Abstracts a model wrote (`generate`), not counting the ones a human
   * rewrote afterwards (`curate`). Reported by telemetry, where the question
   * is how much of a space was written by a model rather than judged.
   */
  generatedAbstracts: number
}

/**
 * Every number `cairn status` reports, from an event sequence.
 *
 * Pure and storage-free on purpose: the local `EventLog` reads its events from
 * a JSONL file and the hosted service reads the same shapes from its own
 * storage, and both must then report the same thing. The only
 * way to guarantee that is for both to do the counting HERE. An inline WHERE
 * clause on one side and a filter on the other is how the two silently drift —
 * this function replaces exactly that arrangement.
 *
 * The kinds are load-bearing and are imported, never re-listed: an edit counts
 * as an approval, `curate`, `generate` and `import` count as neither, and
 * `import` in particular must count as neither an approval NOR a resolution.
 *
 * `events` must arrive in `at`-ascending order: `pendingAgeDays` reports the
 * FIRST unresolved proposal it finds, and out of order that is some unresolved
 * proposal rather than the oldest one. The JSONL log is append-ordered by
 * construction, and the hosted service orders its events the same way.
 */
export function statsFromEvents(events: KbEvent[], now: number = Date.now()): Stats {
  const count = (k: EventKind) => events.filter((e) => e.kind === k).length
  const approved = APPROVE_KINDS.reduce((n, k) => n + count(k), 0)
  const rejected = count("reject")
  const reviewed = approved + rejected
  const oldestPending = events
    .filter((e) => e.kind === "propose" && e.id !== undefined)
    .find((e) => !events.some((x) => RESOLVE_KINDS.includes(x.kind) && x.id === e.id))
  const sessions = new Set(
    events
      .filter((e) => e.kind === "map" && typeof e.meta?.session === "string")
      .map((e) => e.meta!.session as string),
  )
  return {
    proposed: count("propose"),
    approved,
    edited: count("edit"),
    rejected,
    approveRate: reviewed === 0 ? null : approved / reviewed,
    reads: count("map") + count("read"),
    deniedReads: events.filter((e) => e.kind === "read" && e.meta?.denied === true).length,
    searches: count("search"),
    sessions: sessions.size,
    pendingAgeDays: oldestPending ? (now - Date.parse(oldestPending.at)) / 86_400_000 : null,
    generatedAbstracts: count("generate"),
  }
}
