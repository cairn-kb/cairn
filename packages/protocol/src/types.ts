import type { Stats } from "./stats"
import type { PatchKind } from "./event-kinds"

export type Status = "pending" | "approved" | "rejected" | "retracted"

/**
 * Every status a claim can hold, exported once so every place that must
 * enumerate "all of them" reads from the same array rather than each
 * hardcoding its own copy of four literals.
 *
 * This is the single source of truth `FileStore` (src/store.ts) uses for its
 * directory layout, and it is what the hosted service validates a status
 * filter against. A hand-written copy of the list once missed one of the
 * four, so `HttpStore.list("retracted")` was refused while
 * `FileStore.list("retracted")` happily returned `[]`, and `cairn init --team`
 * (src/migrate.ts) aborted migrating any space holding a retracted claim. A fourth status must never again be addable in one place
 * and missed in the other, which is exactly what a single exported array
 * guarantees that two independently-maintained literals cannot.
 */
export const STATUSES: readonly Status[] = ["pending", "approved", "rejected", "retracted"]

/**
 * A withdrawn approval. Denormalised onto the claim rather than read back from
 * the event log, the same trade `reviewed`/`reviewer` already make: every read
 * path that shows a retraction — the MCP tombstone, `cairn show`, the review
 * screen — would otherwise need the log, and the MCP read path has no reason
 * to open it.
 *
 * `by` is who withdrew it. `Claim.reviewer` is left untouched and still names
 * who approved it: both facts matter, and a retraction that overwrote the
 * original reviewer would erase the judgement it is correcting.
 */
export interface Retraction {
  at: string
  by: string
  reason: string
}

/**
 * One document a claim was written from, and what it is claimed to establish.
 *
 * `cites` used to be a bare list of ids, and that is the defect this replaces.
 * Claims routinely disclosed the weakness of their own citations in their
 * `body` — "this convention is not stated in the doc" — and the format
 * discarded every word of it, because there was nowhere for the account to
 * live except prose nobody reads.
 */
export interface Citation {
  /** The cited document's id. */
  doc: string
  /**
   * What this citation grounds, in the citer's own words. Required when a
   * citation is attached — the empty string appears ONLY on a citation stored
   * before this field existed, and is rendered as "no scope stated" rather
   * than as a scope of nothing.
   */
  supports: string
  /**
   * The document's hash when the citation was attached, copied from
   * `Document.hash` rather than recomputed. Any surface rendering a claim can
   * compare it against the document's current hash and say "this document has
   * changed since it was cited" — which is the detectable half of a staleness check.
   *
   * Null on a citation attached before hashes were recorded. Those cannot be
   * checked against the text they were written from, and are
   * unrecoverable.
   */
  hash: string | null
  /**
   * Claim terms not present in the document at that hash — see `absentTerms`
   * in packages/protocol/src/absence.ts.
   *
   * NULL AND `[]` ARE DIFFERENT FACTS and must stay so at every layer. Null is
   * "the check never ran"; `[]` is "the check ran and every term was present".
   * Collapsing them makes an unchecked citation render exactly like a clean
   * one — verifying presence is not verifying
   * absence — applied to a new instrument.
   *
   * Stored beside the hash it was computed against rather than recomputed on
   * read: recomputing would silently follow a document's edits, hiding the
   * very change the hash exists to surface.
   */
  absent: string[] | null
  /**
   * The agent or human that attached it. Agents attach and only humans detach,
   * so which one put a citation there bears directly on whether it deserves a
   * second look — the same denormalisation `reviewed`/`reviewer` already make.
   * "unknown" on a citation stored before the field existed.
   */
  by: string
}

/** Everything a caller decides when attaching a citation. The store computes
 *  `hash`, `absent` and `by` — a caller that could set them could assert a
 *  check it never ran. */
export interface CiteInput {
  doc: string
  supports: string
  /**
   * Citation facts being COPIED rather than established, set only by
   * `cairn init --team`'s migration (src/migrate.ts) as it moves an existing
   * space to a hosted one. Absent everywhere else, and absent from every wire
   * schema — an agent able to set these could assert a check it never ran and
   * date it to whenever suited. When absent, the store computes all three from
   * the document itself.
   *
   * Migration MUST carry them rather than let the target store recompute. A
   * recomputed hash is today's hash, not the hash when the citation was
   * attached, so every "this document has changed since it was cited" warning
   * would silently disappear the moment a space migrated — and a legacy
   * citation's `absent: null` would become a real check nobody ran.
   */
  provenance?: { hash: string | null; absent: string[] | null; by: string }
}

export interface ClaimSource {
  author: string
  agent: string
  repo: string | null
  session: string | null
}

export interface Claim {
  id: string
  status: Status
  claim: string
  body: string
  source: ClaimSource
  created: string
  reviewed: string | null
  reviewer: string | null
  /** Null for every claim that has not been withdrawn, which is almost all of
   *  them. Non-null exactly when `status === "retracted"`. */
  retracted: Retraction | null
  overlaps: string[]
  /**
   * Documents this claim was written from. Distinct from `overlaps`, which is
   * claim -> claim: a citation points at unreviewed source material, an
   * overlap points at other judged knowledge.
   */
  cites: Citation[]
  abstract: string | null
  /**
   * Who wrote the abstract. "generated" means a model produced it and no human
   * has looked — it is what agents navigate by, so the provenance is worth
   * keeping. `cairn curate` walks exactly those and clears them to "human"
   * once someone has given the abstract their own wording.
   */
  abstractBy: "agent" | "generated" | "human" | null
  tags: string[]
}

export interface ProposeInput {
  claim: string
  body: string
  abstract: string
  source: ClaimSource
  overlaps: string[]
  /** A claim's citations arrive with the proposal — the store has nowhere
   *  else to put them, since `cites` is not derived from anything else on
   *  the claim. The store turns each into a `Citation`. */
  cites: CiteInput[]
  tags: string[]
}

/**
 * Imported material, never reviewed. A claim is "one assertive sentence a
 * reviewer judges"; a document is everything that does not fit that shape —
 * a file's first heading, its README, its spec — held so a claim can cite it
 * rather than be forced to summarize it.
 */
export interface Document {
  /**
   * Opaque, and never derived from `source`. Deriving it would mean two
   * imports of the same file at different paths collide, or a rename orphans
   * every claim that cites the old id — `hash` is what tracks content
   * identity; `id` only ever names a slot.
   */
  id: string
  title: string
  text: string
  /**
   * The path the document was imported from, relative to the imported
   * directory. Null only for an ADOPTED document — one entered by hand, with
   * no file behind it — never for a placeholder or an unknown path: a
   * stringified "null" would match nothing on re-import and get created a
   * second time.
   */
  source: string | null
  created: string
  updated: string
  /** `hashText(text)` — content identity, independent of `id`. What a
   *  re-import compares against to decide "created" vs. "unchanged". */
  hash: string
  /**
   * A machine wrote this text; it is not a team decision. Absent means false.
   * Never affects ranking.
   */
  generated?: boolean
  /** The repository label the document came from. */
  repo?: string
}

/** Everything a caller decides about a document on import. The store fills in
 *  `id`, `created`, `updated` and `hash`. */
export interface DocumentInput {
  title: string
  text: string
  /**
   * Where the text came from, or null when there is no file behind it.
   *
   * Null is the ADOPTED case: `adoptImport` turns a legacy imported claim into
   * a document, and the original path was never recorded, so there is nothing
   * to reconstruct. `Document.source` has always been nullable for exactly
   * that; this input was not, and `runMigration` had to invent something to
   * satisfy it — it sent the document's own id, which is a document id sitting
   * where a file path belongs.
   *
   * That fabrication cost a duplicate. A migrated adopted document matched
   * neither by `source` (its source is an id, not the file's path) nor by the
   * sourceless-plus-identical-hash branch (its source is no longer null), so
   * importing the original documents into the team space created a SECOND
   * document holding the same text — the exact duplicate that branch exists to
   * prevent, with both copies agent-visible through search and no delete path
   * for either.
   *
   * So a source-less document migrates as source-less, and the branch works on
   * the other side too.
   */
  source: string | null
  /**
   * A machine wrote this text; it is not a team decision. Absent means false.
   * Never affects ranking.
   */
  generated?: boolean
  /** The repository label the document came from. */
  repo?: string
}

/** What importing a document did to the store: a fresh id, a changed hash on
 *  an id already held, or neither. */
export type ImportOutcome = "created" | "updated" | "unchanged"

export interface ImportDocumentResult {
  document: Document
  outcome: ImportOutcome
}

/**
 * The seam. Local files implement it, and so does the hosted service. Async
 * despite bun:sqlite being synchronous — a remote implementation cannot be
 * sync.
 */
export interface Store {
  /**
   * Every claim with this status.
   *
   * `mine` narrows the answer to the queue that defaults to the signed-in
   * person: claims carrying a tag they own, plus claims no one owns a tag on.
   * It is a filter and never a permission — the unfiltered call still returns
   * everything, and nothing is hidden from anyone.
   *
   * Only a team store can honour it: ownership is a row in a shared space, and
   * a local root has no members to own anything. `FileStore` therefore REFUSES
   * `mine` rather than ignoring it — a filter that quietly returned the whole
   * queue would be answering a question it never asked.
   */
  list(status: Status, opts?: { mine?: boolean }): Promise<Claim[]>
  get(id: string): Promise<Claim | null>
  /** A content update, and what it means. The kind is the caller's to state:
   *  a hardcoded one recorded a human curating what a model had written. */
  put(claim: Claim, kind: PatchKind): Promise<void>
  move(id: string, status: Status): Promise<void>
  search(query: string): Promise<Claim[]>
  /**
   * Create a claim and return it. The STORE owns the id: the hosted
   * implementation has the server assign one, so a caller cannot know it in
   * advance and `put` — which returns void — cannot hand it back.
   */
  propose(input: ProposeInput): Promise<Claim>
  /**
   * The status change, any edits, and the event as ONE operation. Split into
   * move-then-append, a failure between the two either understates the approve
   * rate or claims a review that never happened.
   */
  review(
    id: string,
    decision: "approve" | "reject" | "edit",
    edits?: { claim?: string; body?: string; abstract?: string },
    /**
     * How long the reviewer spent on this claim, in milliseconds, measured by
     * whichever surface they used.
     *
     * This is the metric that keeps `approveRate` falsifiable.
     * An approve rate of 1 cannot be told apart from rubber-stamping by the
     * rate alone, and moving review to a one-tap button is the moment that
     * indistinguishability could become permanent — so the interval is
     * recorded on the decision event, where it can be read back against it.
     *
     * CLIENT-MEASURED, deliberately. The server could
     * derive it from a `read` event instead and be harder to lie to, but it
     * would be confidently wrong in the ordinary case: a reviewer with five
     * tabs open, or one who walks away mid-claim, produces an interval that
     * measures their lunch. This is the only option both surfaces can send, so
     * it is the only one under which the terminal and the browser measure the
     * same thing. The reviewer is measuring themselves and that is the design;
     * the threat being defended against is an unfalsifiable rate, not a
     * reviewer defeating their own instrument.
     *
     * OPTIONAL, and absent is a real answer rather than a zero: a caller that
     * did not measure must not be recorded as having measured nothing. It is
     * the same distinction `absent: null` versus `absent: []` draws for terms,
     * and `provenanceOf`'s required `people` map draws for names.
     */
    elapsedMs?: number,
  ): Promise<Claim | null>
  /**
   * Withdraw an approval. Its own operation, never a `review` decision: the
   * guard in `FileStore.review` (src/store.ts) is correct and stays, so spelling a withdrawal
   * as a second review would move `approved`, `rejected` and `approveRate` for
   * a claim nobody reviewed twice — the same reasoning that gave `importClaim`
   * its own operation.
   *
   * Null for an unknown id, matching `get` and `review`; a throw for a claim
   * that exists but cannot be withdrawn, matching `review`'s
   * `AlreadyResolvedError` and `adoptImport`'s refusal. Both stores must
   * refuse with the same sentence.
   *
   * `by` is who is withdrawing it. The hosted store derives its own actor from
   * the request principal and ignores this, exactly as `importClaim` does with
   * `source.author`.
   */
  retract(id: string, reason: string, by: string): Promise<Claim | null>
  /**
   * Attach a document to a claim as evidence, in place.
   *
   * Its own operation, never a `review` and never a `put`: a citation must not
   * move `approved`, `rejected` or `approveRate`, and the propose-and-approve
   * cycle a `supersede` would cost is exactly the movement this objects
   * to. An AGENT may call this and it lands immediately — a grounding path
   * that stalls behind a review gate stops being evidence that agents ground
   * claims on their own.
   *
   * No status gate: a claim in any status may gain evidence. Null for an
   * unknown claim id, matching `get`, `review` and `retract`; a throw for a
   * citation that cannot be attached, matching their `AlreadyResolvedError`.
   *
   * `by` is who attached it. The hosted store derives its own actor from the
   * request principal and ignores this, exactly as `retract` and `importClaim`
   * already do — a caller that could name someone else is a caller that could
   * attribute its own citation to a human.
   *
   * `input.provenance` is NOT honoured by either implementation, and that is
   * correct rather than an omission: a citation attached after the fact
   * establishes its own facts — its hash, its absences, its author — where a
   * migration copying one must preserve the check somebody already ran. Only
   * the importing paths take `provenance`. Said here because the type permits
   * what the behaviour refuses, and a future migration would otherwise reach
   * for this method and silently get today's hash stamped on an old check.
   */
  cite(claimId: string, input: CiteInput, by: string): Promise<Claim | null>
  /**
   * Detach a citation. HUMAN-ONLY, and enforced by `team_knowledge_uncite`
   * simply not existing on the MCP surface rather than by a runtime check an
   * agent can hit and work around: an agent must not be able to strip evidence
   * that makes a claim look weak.
   *
   * The event log keeps both halves — the `cite` and the `uncite` — so the
   * removal is recoverable even though the current view no longer shows it.
   */
  uncite(claimId: string, doc: string): Promise<Claim | null>
  /**
   * A document entering the space already approved, having never been reviewed.
   *
   * Its own operation because it is its own thing. `propose` + `review` is the
   * only way to spell it out of the other two, and that spelling adds one to
   * both halves of the approve rate for every claim that arrives this way — the
   * number the product measures, moved by an action nobody reviewed.
   * This records a single `import` event, which counts as neither an approval
   * nor a resolution.
   *
   * Its caller is `runMigration` (`src/migrate.ts`), and only that: a local
   * space moving into a team space carries its already-approved claims across
   * without re-reviewing them. `cairn import` does NOT reach here — it writes
   * documents now, not claims — and this doc used to say "for every file
   * imported", which described that older arrangement.
   *
   * Returns whether it CREATED the claim. A store dedupes an import against
   * the content it already holds, in any status, so the claim handed back may
   * be one somebody has since rejected — and a caller that cannot tell those
   * apart either counts a repeat as an import or treats the store's correct
   * answer as a failure and aborts.
   */
  importClaim(input: ProposeInput): Promise<{ claim: Claim; created: boolean }>
  /**
   * The counts `cairn status` reports. On the seam because the ledger has to
   * follow the store: reading claims from a shared space and counts from a
   * file on one laptop produced a status whose first line contradicted its
   * third.
   */
  stats(): Promise<Stats>
  /**
   * Every document the space holds. Unfiltered by status because documents
   * have none — they are imported material, never reviewed, so there is no
   * pending/approved/rejected to page over the way `list` does for claims.
   */
  listDocuments(): Promise<Document[]>
  /** An unknown id is null, not a throw — the same contract `get` holds for
   *  claims, for the same reason: a caller checking "is this already here"
   *  should not have to catch to find out. */
  getDocument(id: string): Promise<Document | null>
  /**
   * Text search over documents, kept off `search`. `search` answers "what has
   * a reviewer judged" — mixing in unreviewed material would hand an agent a
   * document indistinguishable from a claim in the one place it asks "what do
   * we know", which is the exact confusion a document exists to avoid.
   */
  searchDocuments(query: string): Promise<Document[]>
  /**
   * Seed or refresh a document from a file. The three-state outcome —
   * created, updated, unchanged — is what lets `cairn import` say what it
   * actually did on a second run over the same directory, instead of
   * reporting either "nothing happened" for a real edit or "created" for a
   * file whose content has not moved since the last import.
   */
  importDocument(input: DocumentInput): Promise<ImportDocumentResult>
  /**
   * Turn an imported claim into the document it always was, and delete the
   * claim. The only operation on this seam that deletes an approved claim —
   * guarded event-based rather than tag-based, so a hand-edited `imported` tag
   * can never talk this into destroying material a human actually judged. A
   * claim that is not adoptable is refused with a thrown error rather than a
   * null, matching the convention `AlreadyResolvedError` set: both
   * implementations must refuse it with the same sentence, or an operator
   * reading the CLI's error sees a different explanation depending on which
   * store answered.
   */
  adoptImport(claimId: string): Promise<Document>
}
