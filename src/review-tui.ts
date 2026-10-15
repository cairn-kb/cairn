/**
 * Review in the terminal.
 *
 * The thing this product measures is whether a person keeps reviewing what
 * agents propose, so friction on this exact loop is what matters most. A
 * developer already in a terminal decides with a keystroke; the browser tab
 * they had to find first is the friction being removed.
 *
 * Prompting is INJECTED, not imported. `@clack/prompts` writes to stdout, and
 * `cairn mcp` shares stdout with the MCP protocol, where one escape sequence
 * corrupts the stream. cli.ts statically imports this module — `case "mcp"`
 * lives in the same file — so clack must reach it only through `ask`, supplied
 * at the call site behind a dynamic import. The purity guard in
 * test/cli.test.ts walks the graph and enforces it.
 */
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rootMessage } from "./errors"
import type { Claim, Store } from "@cairn-kb/protocol/types"
import { createUi, type Ui } from "./ui"
import { wordmark } from "./wordmark"

export type Decision = "approve" | "reject" | "edit" | "skip" | "quit"
export type SpawnFn = (cmd: string, file: string) => Promise<number>

/** The three fields a reviewer may rewrite. `abstract` is "" rather than null:
 *  it round-trips through a text file, which has no way to spell null. */
export interface ClaimText {
  claim: string
  body: string
  abstract: string
}

/** renderClaim returns a string so it can be asserted on; a caller that wants
 *  colour hands its own Ui in. */
const PLAIN = createUi(false)

export function renderClaim(
  claim: Claim,
  index: number,
  total: number,
  overlaps: ReadonlyMap<string, Claim>,
  ui: Ui = PLAIN,
): string {
  // A resolved claim only ever reaches this renderer after a conflict, and
  // its status is the whole reason for rendering it again.
  const position =
    claim.status === "pending"
      ? `${index} of ${total} pending`
      : `${index} of ${total} · already ${claim.status}`
  const where = claim.source.repo ? ` in ${claim.source.repo}` : ""
  const lines = [
    ui.dim(`${position} · proposed by ${claim.source.agent}${where}`),
    "",
    ui.bold(claim.claim),
    "",
    claim.body,
  ]
  if (claim.abstract) {
    // The provenance is the point: "generated" means a model wrote it and no
    // human has looked, and it is what other agents navigate by.
    lines.push("", ui.dim(`abstract  (${claim.abstractBy ?? "unknown"})`), claim.abstract)
  }
  if (claim.overlaps.length > 0) {
    // Named with each overlap's CURRENT status, in the shape `formatClaim`
    // (src/cli.ts) settled on — deliberately the same one, because
    // two renderers inventing separate vocabularies for the same four facts is
    // how a false sentence ships (see src/review-screen.ts).
    //
    // This line used to read `overlaps with N approved claim(s)`, and the
    // "approved" was not checkable from here: `findOverlaps` computes the list
    // against `store.list("approved")` at write time, so every id named an
    // approved claim THEN, and stays put if that claim is retracted after.
    // That defect was live on the worst possible path — the re-render
    // after a conflict, which exists precisely to show a reviewer what the
    // claim says NOW.
    //
    // Still pure and still assertable: the caller resolves and passes the map,
    // exactly as `cairn show` does. That is what the old comment here gave up
    // on, and it did not have to.
    lines.push("", ui.dim("overlaps"))
    for (const id of claim.overlaps) {
      const other = overlaps.get(id)
      if (!other) {
        lines.push(`  ${id} — no longer in this space`)
        continue
      }
      lines.push(`  ${other.claim}`)
      lines.push(
        other.status === "retracted" ? ui.warn(`    ${other.status}`) : ui.dim(`    ${other.status}`),
      )
      lines.push(ui.dim(`    ${other.id}`))
    }
  }
  return lines.join("\n")
}

const MARK = {
  claim: "# claim (one assertive sentence)",
  body: "# body",
  abstract: "# abstract",
}

/**
 * Edit in $EDITOR rather than a prompt. Multi-line prose in a terminal prompt
 * is worse than a textarea; in $EDITOR it is better, and it is the same muscle
 * memory as `git commit`.
 */
/**
 * Which editor to shell out to.
 *
 * `$VISUAL` before `$EDITOR` is the POSIX convention: `$EDITOR` may name a
 * line editor for dumb terminals, `$VISUAL` the full-screen one. Reading only
 * `$EDITOR` — as this did — ignores half the convention.
 *
 * The fallback matters more than it looks. Neither variable is set on a
 * typical desktop, and the previous hardcoded `vi` dropped a reviewer who had
 * never asked for a modal editor into one they may not know how to leave —
 * friction on the exact loop this product exists to measure. A real session
 * reviewed five claims and edited none. `nano` is present on macOS and most
 * Linux images and prints its own way out at the bottom of the screen; `vi`
 * remains the last resort because POSIX guarantees it.
 */
export function resolveEditor(
  env: { VISUAL?: string; EDITOR?: string },
  isAvailable: (cmd: string) => boolean,
): string {
  const named = env.VISUAL?.trim() || env.EDITOR?.trim()
  if (named) return named
  return isAvailable("nano") ? "nano" : "vi"
}

export async function editClaim(
  claim: Claim,
  editor: string,
  spawn: SpawnFn,
): Promise<ClaimText> {
  const file = join(tmpdir(), `cairn-edit-${claim.id}-${Date.now()}.md`)
  await writeFile(
    file,
    `${MARK.claim}\n${claim.claim}\n\n${MARK.body}\n${claim.body}\n\n${MARK.abstract}\n${claim.abstract ?? ""}\n`,
    "utf-8",
  )
  try {
    const code = await spawn(editor, file)
    if (code !== 0) throw new Error(`${editor} exited ${code} — leaving the claim unchanged`)
    const text = await Bun.file(file).text()
    // Sections, not lines: a body is prose and spans as many lines as it
    // likes, so everything between two markers belongs to the first of them.
    const section = (mark: string, next?: string): string => {
      const start = text.indexOf(mark)
      if (start === -1) return ""
      const from = start + mark.length
      const to = next ? text.indexOf(next, from) : text.length
      return text.slice(from, to === -1 ? text.length : to).trim()
    }
    const edited = {
      claim: section(MARK.claim, MARK.body),
      body: section(MARK.body, MARK.abstract),
      abstract: section(MARK.abstract),
    }
    // A claim IS its sentence. Saving an empty one — by deleting the line, or
    // by mangling the markers so the parser finds nothing — destroys the
    // record under the word "reviewed", which is worse than refusing.
    if (edited.claim === "") {
      throw new Error(
        `the claim sentence came back empty — nothing was recorded; re-run \`cairn review\` and keep a sentence under "${MARK.claim}"`,
      )
    }
    // The body, for the same reason and one layer earlier than the store: the
    // hosted service refuses an empty body with "one of the values sent was
    // empty or malformed", which names nothing, while FileStore accepts it —
    // so the same keystroke silently did two different things depending on who
    // was signed in. Refused here, the sentence can say which field it was.
    if (edited.body === "") {
      throw new Error(
        `the body came back empty — nothing was recorded; re-run \`cairn review\` and keep the text under "${MARK.body}"`,
      )
    }
    return edited
  } finally {
    await rm(file, { force: true })
  }
}

export interface ReviewDeps {
  store: Store
  ask: (claim: Claim, index: number, total: number) => Promise<Decision>
  edit: (claim: Claim) => Promise<ClaimText>
  out: (line: string) => void
  /** Only used to re-render a conflicted claim; plain text by default. */
  ui?: Ui
  /** Walk only the queue that defaults to this person — the claims carrying a
   *  tag they own, plus the ones nobody owns a tag on. Team spaces only;
   *  `FileStore` refuses it and `cairn review` never asks a local root. */
  mine?: boolean
  /** The clock, injectable so a test can pin a time-to-decision rather than
   *  assert that some number came out. Defaults to `Date.now`. */
  now?: () => number
  /** The terminal's width, for the wordmark an empty queue draws. Injected for
   *  the same reason the clock is: a test that reads the real stdout asserts
   *  against whatever terminal it happens to be running in. Defaults to
   *  `process.stdout.columns`, which is `undefined` when stdout is a pipe. */
  columns?: number
}

export interface ReviewSummary {
  approved: number
  rejected: number
  edited: number
  skipped: number
}

/**
 * Both stores report a lost race the same way: a numeric HTTP status on the
 * error. Read structurally rather than importing the hosted store's error
 * class — the review loop has no other business knowing about HTTP.
 */
function isConflict(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 409
}

/** Compared against the TRIMMED originals: a section is what lies between two
 *  markers, so an untouched file round-trips to trimmed text and comparing
 *  against the raw claim would report stripped whitespace as a human edit.
 *
 *  Exported (re-exported by review-screen.ts as `editsUnchanged`) so the
 *  full-screen editor judges "did anything change" by the same rule as this
 *  file's own $EDITOR path — two rules for what counts as an edit is how the
 *  `edited` figure drifts. */
export function unchanged(claim: Claim, edits: ClaimText): boolean {
  return (
    edits.claim === claim.claim.trim() &&
    edits.body === claim.body.trim() &&
    edits.abstract === (claim.abstract ?? "").trim()
  )
}

export async function runReview(deps: ReviewDeps): Promise<ReviewSummary> {
  const ui = deps.ui ?? PLAIN
  const pending = await deps.store.list("pending", { mine: deps.mine })
  if (pending.length === 0) {
    // Getting to the end of the queue is a reward state and was printed as a
    // bare absence. This is the one place in the reader where a multi-row mark
    // is free — the queue is empty, so no claim is competing for the rows —
    // and it is plain text rather than a renderable because the screen never
    // mounts a claim here: `runScreenReview` destroys the renderer and flushes
    // the transcript to the terminal the operator gets back.
    const mark = wordmark(deps.columns ?? process.stdout.columns)
    if (mark) {
      for (const line of mark) deps.out(ui.dim(line))
      deps.out("")
    }
    // Filtered emptiness is a different fact from an empty space, and must
    // read as one: "Nothing is waiting for you" is false of the space while
    // claims sit in somebody else's queue.
    deps.out(
      ui.skip(
        deps.mine
          ? "Nothing is waiting for you in the tags you own."
          : "Nothing is waiting for you.",
      ),
    )
    return { approved: 0, rejected: 0, edited: 0, skipped: 0 }
  }

  const tally = { approved: 0, rejected: 0, edited: 0, skipped: 0 }
  /** Named, not just counted — see the closing lines below. */
  const pendingStill: Claim[] = []

  for (const [i, claim] of pending.entries()) {
    const index = i + 1
    // The clock starts before the claim is put in front of the reviewer and
    // stops when the decision is recorded, so it spans reading AND deciding —
    // including the editor round trip on an `edit`, which is real reviewing
    // time and the most expensive kind.
    //
    // Client-measured was chosen over server-derived precisely so this
    // line can exist: the browser measures the same span from render to
    // submit, and the two surfaces put comparable numbers in one log. Derived
    // server-side from a `read` event, the terminal could not have contributed
    // at all.
    //
    // `deps.now` rather than `Date.now` so the suite can pin an interval
    // instead of asserting that some number came out.
    const startedAt = (deps.now ?? Date.now)()
    /** Read at the moment the decision is recorded, never before: an `edit`
     *  spends time in $EDITOR between the keystroke and the write, and that is
     *  the most expensive reviewing there is. Computed here rather than passed
     *  as a start time so the store never has to know what a clock is. */
    const elapsed = () => (deps.now ?? Date.now)() - startedAt
    const decision = await deps.ask(claim, index, pending.length)
    if (decision === "quit") break
    if (decision === "skip") {
      // Skipped claims stay pending and reappear next run.
      tally.skipped++
      pendingStill.push(claim)
      continue
    }
    try {
      if (decision === "edit") {
        const edits = await deps.edit(claim)
        if (unchanged(claim, edits)) {
          // Recording an `edit` here would report an improvement that did not
          // happen, and `edited` is a figure this project reports.
          deps.out(ui.skip("nothing changed in the editor — left pending"))
          tally.skipped++
          pendingStill.push(claim)
          continue
        }
        await requireReviewed(deps, claim, "edit", edits, elapsed())
        tally.edited++
        continue
      }
      await requireReviewed(deps, claim, decision, undefined, elapsed())
      if (decision === "approve") tally.approved++
      else tally.rejected++
    } catch (err) {
      // Never silent: a failed approve that printed nothing would look exactly
      // like a human who declined to decide — the one signal being measured,
      // faked by an infrastructure failure.
      if (isConflict(err)) {
        deps.out(ui.warn(`${rootMessage(err)} — nothing was recorded`))
        deps.out(await currentClaim(deps, claim, index, pending.length, ui))
      } else {
        deps.out(ui.warn(`could not record that decision: ${rootMessage(err)}`))
        deps.out(ui.dim(`  "${claim.claim}" is still pending — decide it again when that is fixed.`))
      }
      tally.skipped++
      pendingStill.push(claim)
    }
  }

  if (pendingStill.length > 0) {
    deps.out("")
    deps.out(ui.dim(`still pending (${pendingStill.length}):`))
    for (const c of pendingStill) deps.out(ui.dim(`  · ${c.claim}`))
  }
  return tally
}

/** `review` answers null for an id the store does not have — a claim removed
 *  or reviewed elsewhere while this reviewer was reading it. */
async function requireReviewed(
  deps: ReviewDeps,
  claim: Claim,
  decision: "approve" | "reject" | "edit",
  edits?: ClaimText,
  elapsedMs?: number,
): Promise<void> {
  const updated = await deps.store.review(claim.id, decision, edits, elapsedMs)
  if (updated) return
  throw new Error(
    `${claim.id} is not in this space any more — it may have been removed; run \`cairn status\` to see what is there`,
  )
}

/** Re-read and re-render rather than guess: after a conflict the only useful
 *  thing to show is the status the claim actually has now. */
async function currentClaim(
  deps: ReviewDeps,
  claim: Claim,
  index: number,
  total: number,
  ui: Ui,
): Promise<string> {
  try {
    const current = await deps.store.get(claim.id)
    if (current) {
      // Resolved here because `renderClaim` holds no store — the same division
      // `cairn show` uses. An overlap that no longer resolves is left OUT of
      // the map rather than skipped: the renderer still prints its id and says
      // it is gone, because a list that quietly got shorter is worse than one
      // that admits a gap.
      //
      // INSIDE the try deliberately, and it is a trade-off rather than an
      // oversight. A failing overlap lookup now costs the whole re-render,
      // which falls to the `could not re-read it` line below carrying the real
      // error. The alternative — catching per overlap and leaving it out of
      // the map — would render "no longer in this space" for a claim that is
      // still there and merely unreachable, and a false sentence on the screen
      // that exists to tell a reviewer the truth after a conflict is the worse
      // of the two. `cairn show` resolves the same way for the same reason.
      const overlaps = new Map<string, Claim>()
      for (const id of current.overlaps) {
        const other = await deps.store.get(id)
        if (other) overlaps.set(other.id, other)
      }
      return renderClaim(current, index, total, overlaps, ui)
    }
    return ui.dim(`  "${claim.claim}" is no longer in this space — run \`cairn status\`.`)
  } catch (err) {
    return ui.dim(`  could not re-read it: ${rootMessage(err)} — run \`cairn status\`.`)
  }
}

/**
 * What a reviewer answers for one generated abstract.
 *
 * `write` carries the replacement rather than a signal to go and fetch one: an
 * abstract is two sentences, so it is taken inline at the prompt exactly as a
 * claim sentence is, and the loop stays a pure function over answers.
 */
export type CurateAnswer =
  | { kind: "write"; abstract: string }
  | { kind: "skip" }
  | { kind: "quit" }

export interface CurateDeps {
  store: Store
  ask: (claim: Claim, index: number, total: number) => Promise<CurateAnswer>
  out: (line: string) => void
  ui?: Ui
}

export interface CurateSummary {
  /** Abstracts a human replaced, now `abstractBy: "human"`. */
  written: number
  /** Left as they were, whether by choice, by a no-op edit, or by a failure. */
  skipped: number
}

/**
 * What `cairn curate` renders: the claim, what it says, and the abstract other
 * agents are currently navigating by.
 *
 * Not `renderClaim`. That one frames a claim by its position in the review
 * queue — "3 of 8 pending", or "already approved" for the conflict case — and
 * every claim here is approved on purpose, so borrowing it would print "already
 * approved" as if something had gone wrong. The body is kept: an abstract can
 * only be judged against the text it claims to summarise.
 */
export function renderAbstract(claim: Claim, index: number, total: number, ui: Ui = PLAIN): string {
  return [
    ui.dim(`${index} of ${total} · approved, abstract written by ${claim.abstractBy ?? "nobody"}`),
    "",
    ui.bold(claim.claim),
    "",
    claim.body,
    "",
    ui.dim("current abstract"),
    claim.abstract ?? "",
  ].join("\n")
}

/**
 * Give a human's wording to the abstracts a model wrote.
 *
 * The gap this closes: `abstractBy` has three values and, without this,
 * nothing in the CLI could write `"human"`. `cairn review` only ever
 * reaches `store.list("pending")`, and `runBackfill` — the only other `put`
 * caller — always stamps `"generated"` and regenerates wholesale under `--all`,
 * so it cannot correct one. `cairn status` went on counting generated abstracts
 * nobody had reviewed with nothing to point the reader at. The abstract is what
 * agents navigate by, so "a model wrote this and no human has looked" is a
 * distinction worth being able to clear.
 *
 * It writes through `store.put`, which is a PATCH of exactly the three fields
 * this touches and carries `kind: "curate"` — an event in neither
 * APPROVE_KINDS nor RESOLVE_KINDS, so nothing a curate does moves `proposed`,
 * `approved`, `edited`, `rejected` or `approveRate`. No event is appended here
 * on top of that: the service records the curate inside the same request that
 * changed the claim, and a second one from this side would double it.
 */
export async function runCurate(deps: CurateDeps): Promise<CurateSummary> {
  const ui = deps.ui ?? PLAIN
  // Only the machine-written ones. An `agent` abstract came with the claim and
  // a reviewer already saw it while approving; a `human` one is the state this
  // command produces. Neither is waiting for anybody.
  const targets = (await deps.store.list("approved")).filter((c) => c.abstractBy === "generated")
  if (targets.length === 0) {
    deps.out(ui.skip("No generated abstracts are waiting for a human."))
    return { written: 0, skipped: 0 }
  }

  const tally = { written: 0, skipped: 0 }
  for (const [i, claim] of targets.entries()) {
    const answer = await deps.ask(claim, i + 1, targets.length)
    if (answer.kind === "quit") break
    if (answer.kind === "skip") {
      tally.skipped++
      continue
    }
    const abstract = answer.abstract.trim()
    // An empty abstract is worse than a machine-written one: `team_knowledge_map`
    // returns it in place of a summary, and a blank where a sentence belongs is
    // what stops an agent looking further.
    if (abstract === "") {
      deps.out(ui.warn("an abstract cannot be empty — left as generated"))
      tally.skipped++
      continue
    }
    if (abstract === (claim.abstract ?? "").trim()) {
      // Stamping `human` on text a human did not change would clear the very
      // flag this command exists to make meaningful.
      deps.out(ui.skip("nothing changed — left as generated"))
      tally.skipped++
      continue
    }
    try {
      await deps.store.put({ ...claim, abstract, abstractBy: "human" }, "curate")
      tally.written++
    } catch (err) {
      // Never silent, for the same reason a failed approve is not: an abstract
      // that looks written and was not is a claim agents keep navigating by
      // the model's wording.
      deps.out(ui.warn(`could not save that abstract: ${rootMessage(err)}`))
      deps.out(ui.dim(`  "${claim.claim}" still has the generated one.`))
      tally.skipped++
    }
  }
  return tally
}
