import { Database } from "bun:sqlite"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { absentTerms } from "@cairn-kb/protocol/absence"
import { makeId, parseClaim, serializeClaim } from "./claims"
import { makeDocId, parseDocument, serializeDocument } from "./documents"
import { prepareSqlite } from "./native/sqlite-runtime"
import type { EventSink, Stats } from "./events"
import { ftsQuery } from "./search-query"
import { hashText } from "@cairn-kb/protocol/hash"
import { STATUSES } from "@cairn-kb/protocol/types"
import type {
  Citation,
  CiteInput,
  Claim,
  Document,
  DocumentInput,
  ImportDocumentResult,
  ProposeInput,
  Status,
  Store,
} from "@cairn-kb/protocol/types"
import type { PatchKind } from "@cairn-kb/protocol/event-kinds"
import {
  EMPTY_RETRACT_REASON,
  EMPTY_SUPPORTS,
  IMPOSSIBLE_HASH,
  adoptionRefusal,
  notAdoptableMessage,
  notCitableMessage,
  notRetractableMessage,
  notUncitableMessage,
  retractRefusal,
  statesImpossibleHash,
  statesNoScope,
  unknownClaimMessage,
  unknownDocumentMessage,
} from "@cairn-kb/protocol/event-kinds"

const DIR: Record<Status, string> = {
  pending: "inbox",
  approved: "approved",
  rejected: "rejected",
  retracted: "retracted",
}

/**
 * `generated`/`repo` as `input` alone says — never inherited from whatever a
 * prior import recorded. `importDocument` calls this for every document it
 * writes, so a re-import that omits either field drops it rather than
 * keeping the old value: the text currently being imported is what decides
 * whether it is machine-written and which repo it came from, every time.
 */
function taggedFields(input: DocumentInput): Pick<Document, "generated" | "repo"> {
  const fields: Pick<Document, "generated" | "repo"> = {}
  if (input.generated) fields.generated = true
  if (input.repo) fields.repo = input.repo
  return fields
}

/**
 * A claim somebody has already resolved.
 *
 * Carries `status: 409` because that is how the seam spells a lost race: the
 * hosted store raises a CairnHttpError with the same status and the same
 * sentence, and `runReview` reads the number structurally rather than
 * importing either error class. Two implementations that are meant to be
 * interchangeable have to refuse this the same way — without the guard,
 * FileStore appended a second approve/reject for a claim that was already
 * decided, moving both halves of the approve rate for a review nobody did.
 */
export class AlreadyResolvedError extends Error {
  readonly status = 409
  constructor() {
    super("someone else already reviewed this claim")
    this.name = "AlreadyResolvedError"
  }
}

export class FileStore implements Store {
  private db!: Database

  constructor(
    private root: string,
    private log?: EventSink,
  ) {}

  /**
   * propose, review and put write events, so they need a sink. Constructing a
   * FileStore without one is fine for read-only use — but silently dropping
   * an event would corrupt the approve rate, so this throws instead.
   */
  private events(): EventSink {
    if (!this.log) {
      throw new Error("this FileStore was constructed without an event log; propose, review and put need one")
    }
    return this.log
  }

  async init(): Promise<void> {
    for (const status of STATUSES) {
      await mkdir(join(this.root, DIR[status]), { recursive: true })
    }
    prepareSqlite(this.root)
    this.db = new Database(join(this.root, "index.db"))
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS claims USING fts5(id UNINDEXED, status UNINDEXED, claim, body, tags)",
    )
    await mkdir(join(this.root, "documents"), { recursive: true })
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, title, text, source UNINDEXED)",
    )
  }

  private path(status: Status, id: string): string {
    return join(this.root, DIR[status], `${id}.md`)
  }

  private async findPath(id: string): Promise<{ status: Status; path: string } | null> {
    for (const status of STATUSES) {
      const path = this.path(status, id)
      if (await Bun.file(path).exists()) return { status, path }
    }
    return null
  }

  private index(claim: Claim): void {
    this.db.run("DELETE FROM claims WHERE id = ?", [claim.id])
    this.db.run("INSERT INTO claims (id, status, claim, body, tags) VALUES (?, ?, ?, ?, ?)", [
      claim.id,
      claim.status,
      claim.claim,
      claim.body,
      claim.tags.join(" "),
    ])
  }

  /**
   * The write, without the event. Internal callers use this: `put` is also
   * FileStore's own write primitive, and logging on every call would leave a
   * spurious content event beside every propose and every review.
   */
  private async write(claim: Claim): Promise<void> {
    const target = this.path(claim.status, claim.id)
    // Look up any pre-existing file for this id before writing: if the
    // caller mutated claim.status without going through move(), the old
    // file lives under a different status directory and must be removed
    // so put() never leaves two files (and one stale, unindexed) for the
    // same id. Captured before the write so the lookup reflects the prior
    // on-disk state regardless of directory scan order.
    const existing = await this.findPath(claim.id)
    await writeFile(target, serializeClaim(claim), "utf-8")
    // Write-before-unlink, same ordering move() uses: the new file must
    // land before the old one goes.
    if (existing && existing.path !== target) await unlink(existing.path)
    this.index(claim)
  }

  async put(claim: Claim, kind: PatchKind): Promise<void> {
    await this.write(claim)
    // One content write, one event. The hosted store records this server-side
    // inside the PATCH; recording it here keeps the two logs describing the
    // same operation the same way.
    await this.events().append(kind, claim.id)
  }

  /**
   * The containing directory is the sole authority on status; the frontmatter
   * field is a convenience copy that may be stale or hand-edited. Files are
   * meant to be greppable, diffable and editable, so `status: approved` will
   * appear in an inbox/ file sooner or later — via a hand edit, a git merge, or
   * an agent tidying frontmatter. Trusting it there would walk an unreviewed
   * claim straight past the approval gate, which is the entire product.
   */
  private async read(path: string, status: Status): Promise<Claim> {
    const claim = parseClaim(await readFile(path, "utf-8"))
    claim.status = status
    return claim
  }

  async get(id: string): Promise<Claim | null> {
    const found = await this.findPath(id)
    if (!found) return null
    return this.read(found.path, found.status)
  }

  async list(status: Status, opts: { mine?: boolean } = {}): Promise<Claim[]> {
    // A local root has no members, so no tag can belong to one of them and
    // "the queue that defaults to me" has no meaning here. Refused rather than
    // ignored: silently answering with the whole queue would be a claim about
    // ownership this store cannot make. `cairn review --mine` checks the mode
    // and refuses first, with a sentence about team spaces; this is the
    // seatbelt for any other caller.
    if (opts.mine) {
      throw new Error("tag ownership needs a team space — this root is local")
    }
    const dir = join(this.root, DIR[status])
    const names = (await readdir(dir)).filter((n) => n.endsWith(".md"))
    const claims = await Promise.all(names.map((n) => this.read(join(dir, n), status)))
    return claims.sort((a, b) => b.created.localeCompare(a.created))
  }

  async move(id: string, status: Status): Promise<void> {
    const found = await this.findPath(id)
    if (!found) throw new Error(`claim not found: ${id}`)
    const claim = await this.read(found.path, found.status)
    claim.status = status
    claim.reviewed = new Date().toISOString()
    const target = this.path(status, id)
    await writeFile(target, serializeClaim(claim), "utf-8")
    // Write-then-delete rather than rename: the content changed (status,
    // reviewed), so the new file must land before the old one goes.
    if (found.path !== target) await unlink(found.path)
    this.index(claim)
  }

  async search(query: string): Promise<Claim[]> {
    const fts = ftsQuery(query)
    if (fts === null) return []
    const rows = this.db
      .query("SELECT id FROM claims WHERE claims MATCH ? ORDER BY bm25(claims)")
      .all(fts) as { id: string }[]
    // `get` per id, not a join: it is the single place a claim's status
    // directory is resolved, and the ORDER BY above already put the rows in
    // rank order, which `Promise.all` preserves.
    const claims = await Promise.all(rows.map((r) => this.get(r.id)))
    return claims.filter((c): c is Claim => c !== null)
  }

  /**
   * A `CiteInput` turned into a `Citation`, with everything the caller is not
   * allowed to assert filled in from the document itself.
   *
   * `hash` is COPIED from `Document.hash`, never recomputed: the document
   * already carries `hashText(text)` (packages/protocol/src/types.ts), and a second computation
   * of the same thing is exactly how two definitions of "the same text" drift.
   *
   * `supports` is trimmed HERE, once, because this is the one place both of
   * this store's citing paths — `propose` (via `citations`, below) and `cite`
   * — funnel through before a `Citation` is written. The hosted service trims
   * `supports` before it stores anything, so this is also the point where
   * this store has to agree with the hosted one. Trimming it separately in `cite` and leaving
   * `propose` untrimmed was exactly the asymmetry already caught once on
   * `reason` (see `retract`, above): `"  x  "` must not read back as itself
   * from one path and as `"x"` from the other.
   */
  private async citation(claimText: string, input: CiteInput, by: string): Promise<Citation> {
    const doc = await this.getDocument(input.doc)
    if (!doc) throw new Error(unknownDocumentMessage(input.doc))
    const supports = input.supports.trim()
    // A migration is copying a citation, not making one: recomputing here
    // would stamp today's hash on a check somebody ran days ago. Everything
    // else establishes the facts fresh. See `CiteInput.provenance`.
    if (input.provenance) return { doc: doc.id, supports, ...input.provenance }
    return {
      doc: doc.id,
      supports,
      hash: doc.hash,
      absent: absentTerms(claimText, doc.text),
      by,
    }
  }

  /** Every citation on a proposal, attributed to the proposing agent. */
  private async citations(claimText: string, inputs: CiteInput[], by: string): Promise<Citation[]> {
    // Every scope is checked BEFORE any document is read, and that ordering is
    // the parity: the hosted service makes this check before it touches
    // storage, so a proposal carrying both an empty scope and an unknown
    // document is refused for the empty scope there. `Promise.all` below starts every document read at once, so
    // checking inside `citation` would let whichever read finished first pick
    // the refusal — the two stores would disagree, and non-deterministically.
    //
    // `propose` was the one citing path with no scope guard at all on this
    // store while the hosted one refused with a generic error. That is
    // the parity break `store.propose` now closes; `statesNoScope` is the
    // single rule both sides ask.
    for (const input of inputs) {
      if (statesNoScope(input)) throw new Error(EMPTY_SUPPORTS)
      // Same loop, same reason: before any document is read, so two bad
      // citations are refused for the same one on both stores.
      if (statesImpossibleHash(input)) throw new Error(IMPOSSIBLE_HASH)
    }
    return Promise.all(inputs.map((i) => this.citation(claimText, i, by)))
  }

  async propose(input: ProposeInput): Promise<Claim> {
    // Computed before the claim is written, so a citation of an unknown
    // document refuses the whole proposal rather than leaving a claim on disk
    // with a dangling reference.
    const cites = await this.citations(input.claim, input.cites, input.source.agent)
    const claim: Claim = {
      id: makeId(input.claim, new Date()),
      status: "pending",
      claim: input.claim,
      body: input.body,
      source: input.source,
      created: new Date().toISOString(),
      reviewed: null,
      reviewer: null,
      retracted: null,
      overlaps: input.overlaps,
      cites,
      abstract: input.abstract,
      abstractBy: "agent",
      tags: input.tags,
    }
    await this.write(claim)
    await this.events().append("propose", claim.id, { agent: input.source.agent })
    return claim
  }

  async review(
    id: string,
    decision: "approve" | "reject" | "edit",
    edits: { claim?: string; body?: string; abstract?: string } = {},
    elapsedMs?: number,
  ): Promise<Claim | null> {
    const existing = await this.get(id)
    if (!existing) return null
    // Only a pending claim is reviewable. Reviewing a resolved one again
    // appends a second decision event and moves `approved`, `rejected` and
    // `approveRate` for a claim nobody reviewed twice — and the hosted store
    // has answered this with a 409 all along, so accepting it here made two
    // supposedly interchangeable implementations disagree about the one number
    // the product measures.
    if (existing.status !== "pending") throw new AlreadyResolvedError()
    const updated: Claim = {
      ...existing,
      claim: edits.claim ?? existing.claim,
      body: edits.body ?? existing.body,
      abstract: edits.abstract ?? existing.abstract,
      status: decision === "reject" ? "rejected" : "approved",
      reviewed: new Date().toISOString(),
    }
    await this.write(updated)
    // The kind IS the decision: an edit stays `edit` rather than collapsing to
    // `approve`, because the stats report `edited` separately.
    //
    // `meta` carries the time-to-decision when the caller measured one, and is
    // OMITTED rather than sent as null when it did not. An event
    // with `meta: {elapsedMs: null}` and one with no meta at all are different
    // claims about the world — "measured, and the answer was nothing" versus
    // "nobody measured" — and this log is read back to argue that review is
    // actually happening, so the difference is the whole value of the field.
    await this.events().append(
      decision,
      id,
      elapsedMs === undefined ? undefined : { elapsedMs },
    )
    return updated
  }

  async retract(id: string, reason: string, by: string): Promise<Claim | null> {
    // Trimmed once, up front, and the trimmed value is what gets stored and
    // logged — not just what gets validated. The hosted service trims before
    // it stores, so a reason of `"  x  "` is stored as `"x"` there; this store used to check the trimmed value but persist
    // the untrimmed one, which is the one place the two implementations
    // disagreed about a reason a person will read back later.
    const trimmed = reason.trim()
    if (trimmed === "") throw new Error(EMPTY_RETRACT_REASON)
    const existing = await this.get(id)
    if (!existing) return null
    const refusal = retractRefusal(existing.status)
    if (refusal) throw new Error(notRetractableMessage(id, refusal))
    const updated: Claim = {
      ...existing,
      status: "retracted",
      // `reviewed` and `reviewer` are left exactly as they were: they record
      // the approval this is correcting, and overwriting them would erase the
      // judgement rather than withdraw it.
      retracted: { at: new Date().toISOString(), by, reason: trimmed },
    }
    await this.write(updated)
    await this.events().append("retract", id, { by, reason: trimmed })
    return updated
  }

  async cite(claimId: string, input: CiteInput, by: string): Promise<Claim | null> {
    // Checked before the claim lookup and the document lookup below — `"   "`
    // must be refused before "does this claim exist" is even asked, which is
    // the order the hosted route refuses in (its zod schema runs first). The
    // value actually STORED is trimmed once, inside `citation()`, which is
    // what keeps this path and `propose`'s from disagreeing about it — see
    // that method's comment.
    //
    // `statesNoScope` rather than a second `trim() === ""` here: the rule that
    // a scope-less citation may be copied but not created lives in one place
    // (packages/protocol/src/event-kinds.ts). Nothing reaching `cite` carries `provenance` —
    // `HttpStore.cite` cannot send it and the hosted cite route has no field
    // for it — so in practice this refuses exactly what it always did.
    if (statesNoScope(input)) throw new Error(EMPTY_SUPPORTS)
    // Nothing reaching `cite` carries `provenance` today — `HttpStore.cite`
    // cannot send it and the hosted cite route has no field for it — but this
    // store's `cite` takes a `CiteInput`, so the rule is asked here for the
    // same reason `statesNoScope` is: the guard belongs to the input type, not
    // to the callers that happen to exist.
    if (statesImpossibleHash(input)) throw new Error(IMPOSSIBLE_HASH)
    const existing = await this.get(claimId)
    if (!existing) return null
    // Before the document lookup, deliberately: a duplicate citation of a
    // document that has since gone is still a duplicate, and that is the fact
    // the caller can act on. Answering "unknown document" there would send
    // them looking for an id the claim is already carrying.
    if (existing.cites.some((c) => c.doc === input.doc)) {
      throw new Error(notCitableMessage(claimId, input.doc, "already-cited"))
    }
    // No document lookup here, deliberately. `citation()` below reads the
    // document anyway and throws `unknownDocumentMessage(input.doc)`, which is
    // the string `notCitableMessage(_, _, "unknown-document")` returns -- it
    // delegates to exactly that function (packages/protocol/src/event-kinds.ts). A guard here was
    // a second read of the same row for an identical refusal, and it did not
    // buy the ordering either: the duplicate check above is what has to come
    // first, and it still does.
    //
    // `citation` is the same helper `propose` and `importClaim` use, so a
    // citation attached after the fact carries its hash, its absences and its
    // author by exactly the same rules as one offered up front. A second copy
    // of that derivation here is how the two paths would come to disagree
    // about what a citation was checked against.
    const citation = await this.citation(existing.claim, input, by)
    const updated: Claim = { ...existing, cites: [...existing.cites, citation] }
    await this.write(updated)
    await this.events().append("cite", claimId, { doc: input.doc, by })
    return updated
  }

  async uncite(claimId: string, doc: string): Promise<Claim | null> {
    const existing = await this.get(claimId)
    if (!existing) return null
    if (!existing.cites.some((c) => c.doc === doc)) {
      throw new Error(notUncitableMessage(claimId, doc))
    }
    const updated: Claim = { ...existing, cites: existing.cites.filter((c) => c.doc !== doc) }
    await this.write(updated)
    // The removal is in the log even though it is out of the view: `cite` and
    // `uncite` together say what was attached and what a human took back.
    await this.events().append("uncite", claimId, { doc })
    return updated
  }

  /**
   * The claim holding exactly this text, in whatever status. The hosted store
   * dedupes on a fingerprint of the same pair across every status, so this is
   * what keeps the two implementations answering an import the same way — and
   * `rejected` is the status that matters most: a re-import must report the
   * rejection, not quietly create a second copy of what a human turned down.
   */
  private async findByContent(claim: string, body: string): Promise<Claim | null> {
    for (const status of STATUSES) {
      for (const c of await this.list(status)) {
        if (c.claim === claim && c.body === body) return c
      }
    }
    return null
  }

  /**
   * A document that arrives already approved, having never been reviewed.
   *
   * `put` + no event was how import used to spell this, and it worked here
   * precisely because FileStore's put writes no event — which is also why the
   * hosted store could not spell it that way at all. One `import` event, which
   * counts as neither an approval nor a resolution, is what makes the two
   * implementations agree.
   */
  async importClaim(input: ProposeInput): Promise<{ claim: Claim; created: boolean }> {
    const existing = await this.findByContent(input.claim, input.body)
    if (existing) {
      // Logged even though nothing was created, exactly as the service does:
      // the claim table answers "what do we know", the event log answers "how
      // often was it offered". `import` counts towards no reported number
      // either way.
      await this.events().append("import", existing.id, {
        agent: input.source.agent,
        deduplicated: true,
      })
      return { claim: existing, created: false }
    }
    const now = new Date().toISOString()
    // Same ordering as `propose`: an unknown document refuses the import
    // rather than leaving an approved claim citing nothing.
    const cites = await this.citations(input.claim, input.cites, input.source.agent)
    const claim: Claim = {
      id: makeId(input.claim, new Date()),
      status: "approved",
      claim: input.claim,
      body: input.body,
      source: input.source,
      created: now,
      // Resolved on arrival — a claim that reads as unreviewed would sit in
      // pendingAgeDays for ever. The reviewer records WHO RAN the import, which
      // is what the hosted store records too (its own actor id); no review
      // event is written either way, because nobody reviewed anything.
      reviewed: now,
      reviewer: input.source.author,
      retracted: null,
      overlaps: input.overlaps,
      cites,
      abstract: input.abstract.trim() === "" ? null : input.abstract,
      abstractBy: input.abstract.trim() === "" ? null : "agent",
      tags: input.tags,
    }
    await this.write(claim)
    await this.events().append("import", claim.id, { agent: input.source.agent })
    return { claim, created: true }
  }

  async stats(): Promise<Stats> {
    return this.events().stats()
  }

  private docPath(id: string): string {
    return join(this.root, "documents", `${id}.md`)
  }

  private indexDocument(doc: Document): void {
    this.db.run("DELETE FROM documents WHERE id = ?", [doc.id])
    this.db.run("INSERT INTO documents (id, title, text, source) VALUES (?, ?, ?, ?)", [
      doc.id,
      doc.title,
      doc.text,
      doc.source ?? "",
    ])
  }

  async listDocuments(): Promise<Document[]> {
    const dir = join(this.root, "documents")
    const names = (await readdir(dir)).filter((n) => n.endsWith(".md"))
    const docs = await Promise.all(
      names.map(async (n) => parseDocument(await readFile(join(dir, n), "utf-8"))),
    )
    return docs.sort((a, b) => b.created.localeCompare(a.created))
  }

  async getDocument(id: string): Promise<Document | null> {
    const path = this.docPath(id)
    if (!(await Bun.file(path).exists())) return null
    return parseDocument(await readFile(path, "utf-8"))
  }

  async searchDocuments(query: string): Promise<Document[]> {
    const fts = ftsQuery(query)
    if (fts === null) return []
    const rows = this.db
      .query("SELECT id FROM documents WHERE documents MATCH ? ORDER BY bm25(documents)")
      .all(fts) as { id: string }[]
    const docs = await Promise.all(rows.map((r) => this.getDocument(r.id)))
    return docs.filter((d): d is Document => d !== null)
  }

  /**
   * Match order is load-bearing: by `source`, then
   * by `hash` among sourceless (adopted) documents, then create. Reversing the
   * first two would let one edited file claim an unrelated adopted document.
   *
   * **O(n) per call, so a full-corpus import is O(n²)** — `listDocuments()`
   * reads and parses every document on disk to find one. Deliberate, and
   * recorded here because this file's convention is to say why rather than to
   * leave a reader wondering whether it was noticed: the matching
   * is on `source` and on `hash`, neither of which the JSONL-plus-files layout
   * indexes, and the corpus this was built for is tens of documents, not
   * thousands. The hosted service indexes these and does not share the shape.
   * If a local space ever grows enough for this to bite, the fix is an index
   * on those two columns, not a different match order — the order is the part
   * that must not move.
   */
  async importDocument(input: DocumentInput): Promise<ImportDocumentResult> {
    const hash = await hashText(input.text)
    const all = await this.listDocuments()
    // Never for a source-less input: `d.source === input.source` would be
    // `null === null` and claim whatever adopted document happened to be
    // first, regardless of its text. A source-less import has no path to match
    // ON, so it goes straight to the hash branch below -- which is the branch
    // that is CORRECT for it. (The hosted service behaves the same way: a null
    // source never matches.)
    const bySource = input.source === null ? undefined : all.find((d) => d.source === input.source)
    const now = new Date().toISOString()

    if (bySource) {
      if (bySource.hash === hash) {
        await this.events().append("import", bySource.id, { outcome: "unchanged" })
        return { document: bySource, outcome: "unchanged" }
      }
      // `generated`/`repo` omitted below means dropped, not kept: a re-import
      // sets them from THIS input alone, not from whatever `bySource` held, so
      // the current text's author decides them again every time.
      const { generated: _g1, repo: _r1, ...bySourceRest } = bySource
      const updated: Document = {
        ...bySourceRest,
        title: input.title,
        text: input.text,
        hash,
        updated: now,
        ...taggedFields(input),
      }
      await this.writeDocument(updated)
      await this.events().append("import", updated.id, { outcome: "updated" })
      return { document: updated, outcome: "updated" }
    }

    // An adopted document has no path. One whose text matches this file IS
    // this file: it takes the path and keeps its id, so citations survive and
    // adopt-then-reimport does not leave two copies of everything.
    //
    // Never for a generated write, though: `input.generated` means an agent
    // wrote this text just now, not that some unrelated sourceless document
    // has reappeared with a path. Matching on hash alone there would let a
    // generated overview silently claim a human's adopted document the first
    // time the two happened to produce identical bytes.
    const adopted = input.generated ? undefined : all.find((d) => d.source === null && d.hash === hash)
    if (adopted) {
      const { generated: _g2, repo: _r2, ...adoptedRest } = adopted
      const claimed: Document = {
        ...adoptedRest,
        title: input.title,
        source: input.source,
        updated: now,
        ...taggedFields(input),
      }
      await this.writeDocument(claimed)
      await this.events().append("import", claimed.id, { outcome: "updated" })
      return { document: claimed, outcome: "updated" }
    }

    const created: Document = {
      id: makeDocId(input.title, new Date()),
      title: input.title,
      text: input.text,
      source: input.source,
      created: now,
      updated: now,
      hash,
      ...taggedFields(input),
    }
    await this.writeDocument(created)
    await this.events().append("import", created.id, { outcome: "created" })
    return { document: created, outcome: "created" }
  }

  private async writeDocument(doc: Document): Promise<void> {
    await writeFile(this.docPath(doc.id), serializeDocument(doc), "utf-8")
    this.indexDocument(doc)
  }

  /**
   * Turn an imported claim into the document it always was.
   *
   * The guard is event-based rather than tag-based: the `imported` tag is what
   * the CLI selects on, but a tag can be hand-edited and this operation
   * DELETES a claim. Both halves of `adoptionRefusal` apply — nothing in
   * `UNADOPTABLE_KINDS` may appear, and an `import` event must — and the
   * refusal names which half failed. Observational kinds (`read`, `generate`,
   * `curate`) say nothing either way, which is why this is a deny list: an
   * allow list made every imported claim an agent had read un-adoptable.
   *
   * Document first, claim second. A failure between the two leaves a duplicate,
   * which is recoverable; the other order loses the material outright.
   */
  async adoptImport(claimId: string): Promise<Document> {
    const claim = await this.get(claimId)
    // The shared sentence, not a terse local one: `HttpStore.adoptImport` has
    // to be able to say the same thing on a 404, and two literals in two files
    // drift the moment either is edited alone.
    if (!claim) throw new Error(unknownClaimMessage(claimId))
    // `allStrict`, not `all`: this guard's whole job is to read history
    // trustworthily before deciding whether to DELETE a claim, and `all()`'s
    // tolerance of a truncated line — right for a stats read — would turn "I
    // could not read this claim's history" into "this claim has no history"
    // here, which is the one failure mode this operation cannot survive.
    const events = await this.events().allStrict()
    const mine = events.filter((e) => e.id === claimId)
    const refusal = adoptionRefusal(mine.map((e) => e.kind))
    if (refusal) {
      throw new Error(notAdoptableMessage(claimId, refusal))
    }
    const now = new Date().toISOString()
    const doc: Document = {
      id: makeDocId(claim.claim, new Date()),
      title: claim.claim,
      text: claim.body,
      source: null,
      created: claim.created,
      updated: now,
      hash: await hashText(claim.body),
    }
    await this.writeDocument(doc)
    const found = await this.findPath(claimId)
    // Nothing to unlink means another run adopted this claim between the guard
    // above and here, and it has already written a document of its own
    // This used to be `if (found)` — the loser skipped the unlink,
    // fell through, and returned ITS document as though it had done the work,
    // leaving two documents with the same title, text and hash and telling both
    // callers it worked.
    //
    // So: remove the one just written and refuse. The document-first ordering
    // and its reason are unchanged — a CRASH between the two still leaves a
    // recoverable duplicate rather than losing the material — because this is
    // the race being DETECTED, which is a different thing from a failure, and a
    // detected race can clean up after itself.
    if (!found) {
      await unlink(this.docPath(doc.id))
      this.db.run("DELETE FROM documents WHERE id = ?", [doc.id])
      throw new Error(unknownClaimMessage(claimId))
    }
    await unlink(found.path)
    this.db.run("DELETE FROM claims WHERE id = ?", [claimId])
    // Overlaps pointing at a claim that no longer exists would dangle.
    for (const status of STATUSES) {
      for (const other of await this.list(status)) {
        if (!other.overlaps.includes(claimId)) continue
        await this.write({ ...other, overlaps: other.overlaps.filter((o) => o !== claimId) })
      }
    }
    await this.events().append("adopt", doc.id, { fromClaim: claimId })
    return doc
  }

  /**
   * Returns the two counts SEPARATELY rather than their sum.
   *
   * It used to return one number, and `cairn rebuild` then recovered the claim
   * half by calling `listDocuments()` a second time and subtracting. On a
   * FileStore that call reads and parses every document on disk, so naming two
   * numbers cost a whole second pass over the corpus — to derive something
   * this loop had already counted and thrown away. A sum is also the shape
   * that let the CLI print "reindexed 22 claims" for a space holding 0 claims
   * and 22 documents, which is the defect the separate names exist to prevent;
   * returning them apart means the caller cannot re-make that mistake by
   * arithmetic.
   */
  async rebuildIndex(): Promise<{ claims: number; documents: number }> {
    this.db.run("DELETE FROM claims")
    this.db.run("DELETE FROM documents")
    let claims = 0
    let documents = 0
    for (const status of STATUSES) {
      for (const claim of await this.list(status)) {
        this.index(claim)
        claims++
      }
    }
    for (const doc of await this.listDocuments()) {
      this.indexDocument(doc)
      documents++
    }
    return { claims, documents }
  }
}
