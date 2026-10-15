import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { APPROVE_KINDS, RESOLVE_KINDS } from "@cairn-kb/protocol/event-kinds"
import { statsFromEvents } from "@cairn-kb/protocol/stats"
import type { EventKind, KbEvent, Stats } from "@cairn-kb/protocol/stats"

export { APPROVE_KINDS, RESOLVE_KINDS }
// Re-exported from their new home: the counting moved to packages/protocol/src/stats.ts so the
// hosted service can do it too, and every existing importer of these three types keeps
// working.
export { statsFromEvents }
export type { EventKind, KbEvent, Stats }

/**
 * What the product needs from an event log. `EventLog` is the local
 * implementation; the hosted one follows the same three methods, so nothing
 * downstream of this interface depends on which it is.
 */
/** One entry for `appendMany`. The same three fields `append` takes. */
export interface EventInput {
  kind: EventKind
  id?: string
  meta?: Record<string, unknown>
}

export interface EventSink {
  append(kind: EventKind, id?: string, meta?: Record<string, unknown>): Promise<void>
  /**
   * Several events as one operation. On the hosted sink that is one round trip
   * instead of N — an agent reading five claims used to make five sequential
   * POSTs on the path agents use most.
   *
   * All or nothing: a batch that fails records nothing, because half a batch
   * leaves the instrument short by an amount nobody can see.
   */
  appendMany(events: EventInput[]): Promise<void>
  all(): Promise<KbEvent[]>
  /**
   * Like `all()`, but a line that will not parse is a REFUSAL, not silence.
   *
   * `all()` exists for stats, where a truncated line quietly dropping is the
   * right trade — one missing read event does not change much. `adoptImport`
   * reads this same log to decide whether a claim is safe to DELETE, and for
   * that call "I could not read this claim's history" must never collapse
   * into "this claim has no history" — which is exactly what `all()`'s
   * tolerance would do to a log damaged by a crash mid-append or two
   * processes writing at once.
   */
  allStrict(): Promise<KbEvent[]>
  stats(): Promise<Stats>
}

export class EventLog implements EventSink {
  private path: string

  constructor(root: string) {
    this.path = join(root, "events.jsonl")
  }

  async append(kind: EventKind, id?: string, meta?: Record<string, unknown>): Promise<void> {
    const event: KbEvent = { kind, at: new Date().toISOString(), id, meta }
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf-8")
  }

  /**
   * One write for the whole batch — which is also what makes it atomic here:
   * a single `appendFile` cannot leave half the events in the log for another
   * process to read between them.
   *
   * One timestamp for all of them, because they describe one call. Giving
   * them millisecond-apart times would invent an ordering the caller never
   * had, and `pendingAgeDays` reads this log in `at` order.
   */
  async appendMany(events: EventInput[]): Promise<void> {
    if (events.length === 0) return
    const at = new Date().toISOString()
    const lines = events
      .map((e) => JSON.stringify({ kind: e.kind, at, id: e.id, meta: e.meta } satisfies KbEvent))
      .join("\n")
    await appendFile(this.path, lines + "\n", "utf-8")
  }

  async all(): Promise<KbEvent[]> {
    const file = Bun.file(this.path)
    if (!(await file.exists())) return []
    const lines = (await file.text()).split("\n").filter((line) => line.trim() !== "")
    const events: KbEvent[] = []
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as KbEvent)
      } catch {
        // A truncated or partially-written line must not take down the whole
        // read path — skip it and keep going.
      }
    }
    return events
  }

  /**
   * `all()`'s opposite trade: refuse rather than skip. Splits WITHOUT
   * filtering blank lines first, so the line number in the thrown error is the
   * real 1-indexed line in `events.jsonl` an operator can open and look at —
   * not an index into a pre-filtered array that no longer matches the file.
   */
  async allStrict(): Promise<KbEvent[]> {
    const file = Bun.file(this.path)
    if (!(await file.exists())) return []
    const lines = (await file.text()).split("\n")
    const events: KbEvent[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.trim() === "") continue
      try {
        events.push(JSON.parse(line) as KbEvent)
      } catch {
        throw new Error(
          `${this.path} will not parse at line ${i + 1} — the event log may be damaged ` +
            `(a crash mid-write, or two processes writing at once). Restore events.jsonl from ` +
            `a backup, or repair that line by hand, before adopting anything.`,
        )
      }
    }
    return events
  }

  async stats(): Promise<Stats> {
    // The arithmetic lives in packages/protocol/src/stats.ts, which the hosted service also calls.
    // Growing a second copy here is exactly how the two ledgers would drift.
    return statsFromEvents(await this.all())
  }
}
