import { Database } from "bun:sqlite"
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { absentTerms } from "@cairn-kb/protocol/absence"
import { makeId, parseClaim, serializeClaim } from "./claims"
import { makeDocId, parseDocument, serializeDocument } from "./documents"
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

/** A document file that would not parse, as it was when last read. */
interface Unreadable {
  name: string
  mtime: number
  size: number
}

/** What `rebuildKeyTable` swaps in: the documents that parsed, and the files that did not. */
interface KeySnapshot {
  docs: Document[]
  unreadable: Unreadable[]
}

/**
 * A file's mtime (whole milliseconds, to fit an INTEGER column) and size, or
 * null if it is gone. Enough to tell that a file recorded as unreadable has
 * been touched since, without reading it.
 */
async function fingerprint(path: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const s = await stat(path)
    return { mtime: Math.trunc(s.mtimeMs), size: s.size }
  } catch {
    return null
  }
}

export class FileStore implements Store {
  private db!: Database

  /**
   * How many `rebuildKeyTable` calls are between their directory read and
   * their swap transaction right now. Nonzero only while that gap is open;
   * see `writeDocument` and `rebuildKeyTable` for why both need to check it.
   */
  private rebuildsInFlight = 0
  /**
   * Documents `writeDocument` wrote while `rebuildsInFlight` was nonzero —
   * folded into the swap transaction below so a rebuild's snapshot, taken
   * before the write landed, cannot shadow it. Cleared only once the LAST
   * overlapping rebuild finishes, not the first: a second rebuild's own read
   * may still be in flight when an earlier one's transaction completes, and
   * clearing this out from under it would stop capturing writes for the rest
   * of that read.
   */
  private readonly pendingRebuildWrites = new Map<string, Document>()

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
    this.db = new Database(join(this.root, "index.db"))
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS claims USING fts5(id UNINDEXED, status UNINDEXED, claim, body, tags)",
    )
    await mkdir(join(this.root, "documents"), { recursive: true })
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, title, text, source UNINDEXED)",
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS document_keys (id TEXT PRIMARY KEY, source TEXT, hash TEXT NOT NULL, created TEXT NOT NULL)",
    )
    this.db.run("CREATE INDEX IF NOT EXISTS document_keys_source ON document_keys (source)")
    this.db.run("CREATE INDEX IF NOT EXISTS document_keys_hash ON document_keys (hash)")
    this.db.run(
      "CREATE TABLE IF NOT EXISTS document_unreadable (name TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL)",
    )
    await this.healKeyTable()
  }

  /**
   * An `index.db` written before `document_keys` existed has no such table —
   * created empty, above, while the documents it describes already exist on
   * disk. Trusting that emptiness would make `importDocument` miss every one
   * of them and write a duplicate for the first re-import of each. So: count
   * the `*.md` names in `documents/` (a `readdir`, nothing parsed) against
   * the rows that account for them, and rebuild the one time they disagree.
   * Equal counts are trusted — the same trust the FTS `documents` index
   * already gets without a recount on every open. This runs on every open
   * (every `cairn mcp`, search, `cairn doctor`), which is why the normal path
   * must never parse a document: that would make opening a space cost a read
   * of the whole corpus.
   *
   * Every file is accounted for by one row in one of two tables: a
   * `document_keys` row if it parsed when the table was last rebuilt, a
   * `document_unreadable` row if it did not (see `rebuildKeyTable`). Counting
   * only `document_keys` would leave a permanently broken file disagreeing
   * forever and every open redoing the full rebuild. The unreadable rows
   * carry each file's mtime and size, so the few files they name — and only
   * those — are stat'ed here: one repaired, replaced or removed since it was
   * recorded triggers the rebuild that re-reads it, which is how a fixed file
   * earns its key row back and its unreadable row goes away.
   *
   * Two further limits this does not try to close. A corpus holding two
   * document files that happen to share one frontmatter `id` collapses to a
   * single `document_keys` row (its primary key), so the counts disagree
   * forever and this rebuilds on every single `init()` rather than once — a
   * pre-existing hazard of trusting frontmatter `id` at all, not one this
   * table introduces. And this only runs at `init()`: a document another
   * process adds to disk while this one is already open — an older cairn
   * binary that writes files without keeping this index, or a second process
   * racing this one — is invisible to `document_keys` until the next open,
   * not the next write.
   */
  private async healKeyTable(): Promise<void> {
    const dir = join(this.root, "documents")
    const names = (await readdir(dir)).filter((n) => n.endsWith(".md"))
    const { n } = this.db.query("SELECT count(*) AS n FROM document_keys").get() as { n: number }
    const unreadable = this.db
      .query("SELECT name, mtime, size FROM document_unreadable")
      .all() as Unreadable[]
    if (n + unreadable.length !== names.length) return this.rebuildKeyTable()
    for (const row of unreadable) {
      const now = await fingerprint(join(dir, row.name))
      if (!now || now.mtime !== row.mtime || now.size !== row.size) return this.rebuildKeyTable()
    }
  }

  private indexDocumentKey(doc: Document): void {
    this.db.run(
      "INSERT OR REPLACE INTO document_keys (id, source, hash, created) VALUES (?, ?, ?, ?)",
      [doc.id, doc.source, doc.hash, doc.created],
    )
  }

  /**
   * `listDocuments()`, tolerant of a file that will never parse — broken
   * frontmatter YAML, or a `created`/`updated` value `parseDocument` cannot
   * turn into a date. Retrying buys nothing for a file like that, so
   * throwing the way `listDocuments()` does would make one bad file a
   * permanent block on `document_keys`: every `init()` on this root would die
   * inside the heal, every `matchDocumentKey` stale hit would die trying to
   * re-derive the table, and `cairn mcp`, search and `cairn doctor`'s space
   * check would die with them, over a file nothing written here can fix.
   *
   * A file skipped here is NOT treated as absent, though. It is returned in
   * `unreadable`, with the mtime and size it had when read, and
   * `rebuildKeyTable` records it in `document_unreadable`. It may well be a
   * document some source was imported as — so `importDocument` refuses to
   * create anything while such a row exists, rather than miss the broken
   * file's key and write a duplicate of it. The space still opens and
   * search still works; only a new document waits until the file is fixed or
   * removed.
   *
   * Only the heal-and-rebuild path below uses this. `listDocuments()` itself
   * still throws on a corrupt file for every other caller — search,
   * `rebuildIndex`'s own FTS pass, the document contract suite — because
   * silently hiding a document from, say, `cairn rebuild`'s count would be a
   * different kind of lie.
   */
  private async listDocumentsTolerant(): Promise<KeySnapshot> {
    const dir = join(this.root, "documents")
    const names = (await readdir(dir)).filter((n) => n.endsWith(".md"))
    const unreadable: Unreadable[] = []
    const docs = await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name)
        // Stat'ed BEFORE the read: an edit landing between the two then
        // shows up as a changed fingerprint at the next open, never as a
        // recorded fingerprint that already matches the edited file.
        const before = await fingerprint(path)
        if (!before) return null // removed mid-read: neither row, recounted next open
        try {
          return parseDocument(await readFile(path, "utf-8"))
        } catch {
          unreadable.push({ name, ...before })
          return null
        }
      }),
    )
    return {
      docs: docs.filter((d): d is Document => d !== null).sort((a, b) => b.created.localeCompare(a.created)),
      unreadable,
    }
  }

  /**
   * Replaces every row of `document_keys` and `document_unreadable`,
   * optionally from a caller-supplied snapshot (so `rebuildIndex`, which
   * already pays for one `listDocuments()` for the FTS table, does not pay
   * for a second — and, having read strictly, has no unreadable files to
   * record). Both tables swap in the same transaction: the heal counts them
   * together, so one replaced without the other would read as a mismatch.
   *
   * The read is resolved BEFORE anything is deleted, and the delete plus
   * every insert then run inside one synchronous `this.db.transaction`, with
   * no `await` between them. Doing the delete first and awaiting the read
   * after — this table's first version — left `document_keys` empty and
   * COMMITTED for the whole directory read: a concurrent `importDocument`
   * sharing this connection (another request in the same process,
   * mid-rebuild) could run its lookup in that window, find no keys at all,
   * and write a duplicate for a document that was on disk the entire time.
   * Reading first and never `await`ing mid-transaction closes that window —
   * every other query on this connection now sees either all the old rows or
   * all the new ones, never neither.
   *
   * `rebuildsInFlight` brackets that same read, for a narrower reason: a
   * `writeDocument` landing inside the window — another document imported
   * or adopted while THIS rebuild is reading the directory — writes its own
   * fresh row immediately, but the snapshot this method is about to swap in
   * was taken before that write happened and does not know about it. Without
   * `pendingRebuildWrites`, the DELETE below would erase that fresh row (or
   * the reinsert would overwrite it with whatever stale copy the snapshot
   * held for the same id) and the write would not reappear until the next
   * `init()`. Folding those writes in, inside the same transaction and after
   * the snapshot, makes the freshest copy win either way.
   */
  private async rebuildKeyTable(snapshot?: KeySnapshot): Promise<void> {
    this.rebuildsInFlight++
    try {
      const { docs, unreadable } = snapshot ?? (await this.listDocumentsTolerant())
      const replace = this.db.transaction(() => {
        this.db.run("DELETE FROM document_keys")
        this.db.run("DELETE FROM document_unreadable")
        for (const doc of docs) this.indexDocumentKey(doc)
        for (const doc of this.pendingRebuildWrites.values()) this.indexDocumentKey(doc)
        for (const u of unreadable) {
          this.db.run("INSERT OR REPLACE INTO document_unreadable (name, mtime, size) VALUES (?, ?, ?)", [
            u.name,
            u.mtime,
            u.size,
          ])
        }
      })
      replace()
    } finally {
      this.rebuildsInFlight--
      if (this.rebuildsInFlight === 0) this.pendingRebuildWrites.clear()
    }
  }

  /**
   * The newest `document_keys` row matching `where` (`ORDER BY created DESC,
   * id DESC LIMIT 1` — the same sort `listDocuments()` used plus `find()`'s
   * "first hit wins", with `id` appended only to break a tie between two
   * imports whose `created` timestamps land in the same millisecond, which
   * `created DESC` alone leaves to SQLite to order however it likes), loaded
   * as a `Document` — or null, for no row.
   *
   * A row whose document is gone, or whose `source`/`hash` no longer agrees
   * with what the row says, means the key table drifted from disk — a
   * document file removed or hand-edited underneath the index, between one
   * `init()` and the next. Rebuilt from disk and re-asked exactly once rather
   * than trusted: trusting it risks matching a document that no longer holds
   * what the row claims, and skipping it with no rebuild risks a duplicate
   * the next line down would otherwise create.
   */
  private async matchDocumentKey(
    where: string,
    params: (string | null)[],
    rebuilt = false,
  ): Promise<Document | null> {
    const row = this.db
      .query(
        `SELECT id, source, hash FROM document_keys WHERE ${where} ORDER BY created DESC, id DESC LIMIT 1`,
      )
      .get(...params) as { id: string; source: string | null; hash: string } | null
    if (!row) return null
    const doc = await this.getDocument(row.id)
    if (doc && doc.source === row.source && doc.hash === row.hash) return doc
    if (rebuilt) return null
    await this.rebuildKeyTable()
    return this.matchDocumentKey(where, params, true)
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
   * Looked up through `document_keys`, not `listDocuments()` — that read and
   * parsed every document on disk to find one, which made a full-corpus
   * import O(n²). The key table holds exactly what the match needs, `source`
   * and `hash`, so each lookup is now one indexed query instead of a scan.
   * Kept honest four ways: written alongside every document
   * (`writeDocument`), healed on `init()` by comparing its row count (plus
   * the files recorded as unreadable) against the files on disk, rebuilt wholesale by `cairn rebuild`
   * (`rebuildIndex`), and — the case those three miss, a document changed or
   * removed on disk between one `init()` and the next — re-derived from disk
   * the moment a lookup's row disagrees with the document it names
   * (`matchDocumentKey`), so a stale hit never falls back to a silent
   * duplicate.
   */
  async importDocument(input: DocumentInput): Promise<ImportDocumentResult> {
    const hash = await hashText(input.text)
    // Never for a source-less input: `source = ?` with a null parameter would
    // match whatever adopted document happened to be newest, regardless of
    // its text. A source-less import has no path to match ON, so it goes
    // straight to the hash branch below -- which is the branch that is
    // CORRECT for it. (The hosted service behaves the same way: a null source
    // never matches.)
    const bySource =
      input.source === null ? null : await this.matchDocumentKey("source = ?", [input.source])
    const now = new Date().toISOString()

    // Past this point the import either claims an adopted document or
    // creates one. A file that would not parse when the key table was last
    // rebuilt has no key row, so if it is THIS source's document (or the
    // adopted copy of this text), neither lookup can see it and the import
    // would write a duplicate of it. Refused loudly instead, naming the
    // files, until they are fixed or removed — the next open notices either
    // and re-reads them (`healKeyTable`). A source that did match above is
    // safe to update: its document was found.
    if (!bySource) this.refuseWhileUnreadable()

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
    const adopted = input.generated
      ? null
      : await this.matchDocumentKey("source IS NULL AND hash = ?", [hash])
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

  private refuseWhileUnreadable(): void {
    const rows = this.db.query("SELECT name FROM document_unreadable ORDER BY name").all() as {
      name: string
    }[]
    if (rows.length === 0) return
    const shown = rows.slice(0, 5).map((r) => r.name).join(", ")
    const more = rows.length > 5 ? `, and ${rows.length - 5} more` : ""
    throw new Error(
      `could not check for an existing document — ${rows.length} document file(s) in ${join(this.root, "documents")} could not be read: ${shown}${more} — fix or remove them, then import again`,
    )
  }

  private async writeDocument(doc: Document): Promise<void> {
    await writeFile(this.docPath(doc.id), serializeDocument(doc), "utf-8")
    this.indexDocument(doc)
    this.indexDocumentKey(doc)
    // See `rebuildKeyTable`: while its read is in flight, THIS row is one a
    // rebuild's snapshot does not know about yet, so it is recorded here to
    // be folded back in once that rebuild swaps the table.
    if (this.rebuildsInFlight > 0) this.pendingRebuildWrites.set(doc.id, doc)
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
      this.db.run("DELETE FROM document_keys WHERE id = ?", [doc.id])
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
    // One `listDocuments()` read, handed to `rebuildKeyTable` rather than
    // read a second time: its own delete-then-reinsert of `document_keys`
    // still happens inside one synchronous transaction, same as a heal or a
    // stale-hit rebuild, so a concurrent `importDocument` never observes the
    // key table empty while `cairn rebuild` is running.
    const docs = await this.listDocuments()
    await this.rebuildKeyTable({ docs, unreadable: [] })
    for (const doc of docs) {
      this.indexDocument(doc)
      documents++
    }
    return { claims, documents }
  }
}
