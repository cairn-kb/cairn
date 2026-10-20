import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { appendFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { notAdoptableMessage } from "@cairn-kb/protocol/event-kinds"
import { EventLog } from "../src/events"
import { FileStore } from "../src/store"
import { proposal } from "./store-contract"
import type { Claim } from "@cairn-kb/protocol/types"

let root: string
let store: FileStore

const claim = (id: string, text: string): Claim => ({
  id,
  status: "pending",
  claim: text,
  body: "detail",
  source: { author: "alice", agent: "cursor", repo: null, session: null },
  created: "2026-08-26T09:00:00.000Z",
  reviewed: null,
  reviewer: null,
  retracted: null,
  overlaps: [],
  cites: [],
  abstract: null,
  abstractBy: null,
  tags: ["architecture"],
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-"))
  store = new FileStore(root, new EventLog(root))
  await store.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("put then get returns the claim", async () => {
  await store.put(claim("a", "Billing uses Postgres"), "curate")
  expect((await store.get("a"))?.claim).toBe("Billing uses Postgres")
})

test("get returns null for an unknown id", async () => {
  expect(await store.get("nope")).toBeNull()
})

test("list filters by status", async () => {
  await store.put(claim("a", "one"), "curate")
  await store.put(claim("b", "two"), "curate")
  expect((await store.list("pending")).length).toBe(2)
  expect((await store.list("approved")).length).toBe(0)
})

test("put leaves exactly one file when claim.status changes without move()", async () => {
  const c = claim("a", "one")
  await store.put(c, "curate")
  c.status = "approved"
  await store.put(c, "curate")
  expect((await store.list("pending")).length).toBe(0)
  expect((await store.list("approved")).length).toBe(1)
  expect((await store.get("a"))?.status).toBe("approved")
})

test("move relocates the claim and stamps reviewed", async () => {
  await store.put(claim("a", "one"), "curate")
  await store.move("a", "approved")
  expect((await store.list("pending")).length).toBe(0)
  const moved = await store.get("a")
  expect(moved?.status).toBe("approved")
  expect(moved?.reviewed).not.toBeNull()
})

test("search finds claims by word", async () => {
  await store.put(claim("a", "Billing uses Postgres for invoices"), "curate")
  await store.put(claim("b", "Frontend uses Vue"), "curate")
  const hits = await store.search("postgres")
  expect(hits.length).toBe(1)
  expect(hits[0]!.id).toBe("a")
})

test("rebuildIndex reconstructs the index from files alone", async () => {
  await store.put(claim("a", "Billing uses Postgres"), "curate")
  const fresh = new FileStore(root)
  await fresh.init()
  expect(await fresh.rebuildIndex()).toEqual({ claims: 1, documents: 0 })
  expect((await fresh.search("postgres")).length).toBe(1)
})

test("propose returns the stored claim, and the store owns the id", async () => {
  const created = await store.propose({
    claim: "bun test does not typecheck",
    body: "run tsc separately",
    abstract: "Settles the command. Does not settle performance.",
    source: { author: "alice", agent: "cursor", repo: null, session: null },
    overlaps: [],
    cites: [],
    tags: ["testing"],
  })
  expect(created.id).toBeTruthy()
  expect(created.status).toBe("pending")
  expect(await store.get(created.id)).toEqual(created)
})

test("review approves and returns the updated claim", async () => {
  const c = await store.propose({
    claim: "one",
    body: "b",
    abstract: "a",
    source: { author: "r", agent: "c", repo: null, session: null },
    overlaps: [],
    cites: [],
    tags: [],
  })
  const reviewed = await store.review(c.id, "approve")
  expect(reviewed!.status).toBe("approved")
})

test("review with edits applies them and still approves", async () => {
  const c = await store.propose({
    claim: "one",
    body: "b",
    abstract: "a",
    source: { author: "r", agent: "c", repo: null, session: null },
    overlaps: [],
    cites: [],
    tags: [],
  })
  const reviewed = await store.review(c.id, "edit", { claim: "one, improved" })
  expect(reviewed!.claim).toBe("one, improved")
  expect(reviewed!.status).toBe("approved")
})

test("reviewing an unknown id is null, not a throw", async () => {
  expect(await store.review("missing", "approve")).toBeNull()
})

// --- one content write, one event -----------------------------------------
//
// `HttpStore.put` hardcoded `kind: "curate"`, so `cairn abstracts` recorded a
// curate — a human curated something a model wrote — and then appended its own
// `generate` beside it. One write, two events, one of them false. FileStore
// recorded neither, because `put` is also its own internal write primitive and
// logging there would double-count every propose and review.

test("put records exactly one event, of the kind the caller named", async () => {
  const log = new EventLog(root)
  const s = new FileStore(root, log)
  await s.init()
  await s.put(claim("a", "Billing uses Postgres"), "generate")
  const events = (await log.all()).filter((e) => e.id === "a")
  expect(events.map((e) => e.kind)).toEqual(["generate"])
})

test("curate and generate are distinguishable in the log", async () => {
  const log = new EventLog(root)
  const s = new FileStore(root, log)
  await s.init()
  await s.put(claim("a", "one"), "generate")
  await s.put(claim("a", "one"), "curate")
  expect((await log.all()).filter((e) => e.id === "a").map((e) => e.kind))
    .toEqual(["generate", "curate"])
})

test("propose does not also record a content write", async () => {
  // put is FileStore's internal write primitive as well as a Store method.
  // Logging on every call would put a spurious curate/generate beside every
  // proposal and every review.
  const log = new EventLog(root)
  const s = new FileStore(root, log)
  await s.init()
  const c = await s.propose({
    claim: "Billing uses Postgres", body: "b", abstract: "", tags: [],
    source: { author: "me", agent: "test", repo: null, session: null }, overlaps: [], cites: [],
  })
  expect((await log.all()).filter((e) => e.id === c.id).map((e) => e.kind)).toEqual(["propose"])
})

test("review records the decision and nothing else", async () => {
  const log = new EventLog(root)
  const s = new FileStore(root, log)
  await s.init()
  const c = await s.propose({
    claim: "Billing uses Postgres", body: "b", abstract: "", tags: [],
    source: { author: "me", agent: "test", repo: null, session: null }, overlaps: [], cites: [],
  })
  await s.review(c.id, "approve")
  expect((await log.all()).filter((e) => e.id === c.id).map((e) => e.kind))
    .toEqual(["propose", "approve"])
})

test("rebuildIndex reindexes documents as well as claims", async () => {
  const store = new FileStore(root, new EventLog(root))
  await store.init()
  const { document } = await store.importDocument({ title: "T", text: "findable text", source: "a.md" })
  // Simulate the drift rebuild exists for: the file on disk is the truth, the
  // index is a cache, and a cache that silently disagrees is what this repairs.
  ;(store as unknown as { db: { run(sql: string): void } }).db.run("DELETE FROM documents")
  expect(await store.searchDocuments("findable")).toEqual([])
  // The counts come back named, and a document must be counted as a document:
  // reporting the pair as one sum is what let `cairn rebuild` print "22
  // claims" for a space holding none.
  expect(await store.rebuildIndex()).toEqual({ claims: 0, documents: 1 })
  expect((await store.searchDocuments("findable")).map((d) => d.id)).toEqual([document.id])
})

// --- a generated write must not adopt an unrelated human document ---------
//
// Adoption exists so re-importing the same file after `adoptImport` claims
// the sourceless document in place rather than duplicating it (see
// test/store-contract.ts). A generated write's text happening to hash the
// same as some unrelated sourceless document must not let it silently take
// that document over — it is an agent's overview, not the human's file
// reappearing.

test("a generated write creates its own document rather than adopting an unrelated sourceless one", async () => {
  const { document: human } = await store.importDocument({
    title: "Human notes",
    text: "identical text",
    source: null,
  })
  const { document: generated, outcome } = await store.importDocument({
    title: "Generated overview",
    text: "identical text",
    source: "generated:app/architecture",
    generated: true,
    repo: "app",
  })
  expect(outcome).toBe("created")
  expect(generated.id).not.toBe(human.id)
  expect((await store.listDocuments()).length).toBe(2)
  const refreshedHuman = await store.getDocument(human.id)
  expect(refreshedHuman?.source).toBeNull()
  expect(refreshedHuman?.generated ?? false).toBe(false)
})

// --- importDocument is indexed, not a full scan ---------------------------
//
// `listDocuments()` reads and parses every document on disk. The whole point
// of `document_keys` is that `importDocument`'s normal path never has to.

test("importDocument never reads every document to find one", async () => {
  const spy = spyOn(store, "listDocuments")
  for (let i = 0; i < 30; i++) {
    await store.importDocument({ title: `T${i}`, text: `text ${i}`, source: `${i}.md` })
  }
  expect(spy).not.toHaveBeenCalled()
})

test("an index.db from before the key table self-heals instead of duplicating", async () => {
  await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  await store.importDocument({ title: "U", text: "other text", source: "b.md" })
  // The shape an older cairn left behind: an index.db with no document_keys
  // table at all, while the documents it describes already exist on disk.
  ;(store as unknown as { db: { run(sql: string): void } }).db.run("DROP TABLE document_keys")
  const fresh = new FileStore(root, new EventLog(root))
  await fresh.init()
  const a = await fresh.importDocument({ title: "T", text: "same text", source: "a.md" })
  const b = await fresh.importDocument({ title: "U", text: "other text", source: "b.md" })
  expect(a.outcome).toBe("unchanged")
  expect(b.outcome).toBe("unchanged")
  expect((await fresh.listDocuments()).length).toBe(2)
})

test("a document file deleted by hand is recreated, not thrown on, by the next import of its source", async () => {
  const { document } = await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  await unlink(join(root, "documents", `${document.id}.md`))
  const result = await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  expect(result.outcome).toBe("created")
  expect(result.document.id).not.toBe(document.id)
  expect((await store.listDocuments()).length).toBe(1)
})

test("rebuildIndex restores the key table", async () => {
  const { document } = await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  ;(store as unknown as { db: { run(sql: string): void } }).db.run("DELETE FROM document_keys")
  await store.rebuildIndex()
  const result = await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  expect(result.outcome).toBe("unchanged")
  expect(result.document.id).toBe(document.id)
})

test("a document hand-edited to a new source self-heals rather than mismatching", async () => {
  const { document } = await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  // Rewrite the file's frontmatter directly, bypassing the store entirely —
  // `document_keys` still says `source: a.md` while the file on disk now
  // says `renamed.md`.
  const path = join(root, "documents", `${document.id}.md`)
  const raw = await readFile(path, "utf-8")
  await writeFile(path, raw.replace("a.md", "renamed.md"), "utf-8")

  // The old source no longer names anything real: a fresh document, not a
  // throw and not a false match onto the renamed file.
  const byOldSource = await store.importDocument({ title: "T", text: "same text", source: "a.md" })
  expect(byOldSource.outcome).toBe("created")
  expect(byOldSource.document.id).not.toBe(document.id)

  // The new source resolves straight to the renamed document — the stale
  // row for the old source is what triggered the heal that made this match.
  const byNewSource = await store.importDocument({ title: "T", text: "same text", source: "renamed.md" })
  expect(byNewSource.outcome).toBe("unchanged")
  expect(byNewSource.document.id).toBe(document.id)
})

// --- rebuildKeyTable must never leave document_keys observably empty ------
//
// The table's first version deleted every row, then awaited `listDocuments()`
// before reinserting any of them — a window during which any other query on
// this connection saw an empty table. Fixed by reading first and running the
// delete-plus-reinsert as one synchronous transaction; this is the regression
// test for that fix, not a demonstration that the old code failed (it did not
// reliably fail on every run, which was the danger).

test("a stale-triggered rebuild does not blind a concurrent import of an untouched source", async () => {
  const { document: a } = await store.importDocument({ title: "A", text: "doc a", source: "a.md" })
  const { document: b } = await store.importDocument({ title: "B", text: "doc b", source: "b.md" })
  // Corrupt only a's row, so re-importing "a.md" is the call that detects
  // staleness and drives `rebuildKeyTable`. "b.md"'s row is untouched and
  // must still resolve correctly while that rebuild is in flight.
  ;(store as unknown as { db: { run(sql: string, params: unknown[]): void } }).db.run(
    "UPDATE document_keys SET hash = ? WHERE id = ?",
    ["not-the-real-hash", a.id],
  )
  // Fired together, not awaited one after the other — same pattern as the
  // two-concurrent-adoptions case in store-contract.ts, and for the same
  // reason: both reach their own awaits before either writes, so this needs
  // no timing trick.
  const [resultA, resultB] = await Promise.all([
    store.importDocument({ title: "A", text: "doc a", source: "a.md" }),
    store.importDocument({ title: "B", text: "doc b", source: "b.md" }),
  ])
  expect(resultA.outcome).toBe("unchanged")
  expect(resultA.document.id).toBe(a.id)
  expect(resultB.outcome).toBe("unchanged")
  expect(resultB.document.id).toBe(b.id)
  expect((await store.listDocuments()).length).toBe(2)
})

// A real `importDocument` landing squarely inside `rebuildKeyTable`'s
// directory read is timing-dependent and, on a fast local filesystem with
// only a handful of documents, does not reliably land there — `Promise.all`
// racing the two reliably resolved before this test ever caught the bug it
// was meant to catch. So this drives the same code deterministically
// instead, through the same private seam the other tests in this file reach
// `store.db` through: simulate "a rebuild's read is in flight" by setting
// `rebuildsInFlight` directly, perform a write, then run the rebuild from a
// snapshot taken before that write — exactly the sequence a real interleaving
// produces, with no race to get unlucky on.
//
// A brand-NEW document is what this needs, not an update to an existing one:
// an update's row going missing is self-healing (the next lookup's `hash`
// disagrees with the document on disk, which `matchDocumentKey` already
// treats as stale and rebuilds from). A new document has no prior row to go
// stale FROM — if the rebuild's stale snapshot (taken before it existed)
// erases it with nothing to restore it, the next lookup finds no row at all,
// which reads as "never imported," not "stale," and creates a second
// document for the same source.

test("a document created mid-rebuild is not lost when the rebuild's stale snapshot wins the race", async () => {
  // The snapshot a real rebuild would have taken BEFORE the write below --
  // captured directly, matching what `rebuildKeyTable` does internally.
  const staleSnapshot = await store.listDocuments()

  const internals = store as unknown as {
    rebuildsInFlight: number
    rebuildKeyTable(docs?: unknown[]): Promise<void>
  }
  internals.rebuildsInFlight = 1
  const created = await store.importDocument({ title: "New", text: "new text", source: "new.md" })
  expect(created.outcome).toBe("created")

  // Running the rebuild now, from the pre-write snapshot, is exactly what
  // happens when a real `writeDocument` lands inside `rebuildKeyTable`'s
  // directory read: the DELETE below wipes `document_keys`, and the reinsert
  // -- working only from `staleSnapshot` -- does not know "new.md" exists.
  await internals.rebuildKeyTable(staleSnapshot)
  internals.rebuildsInFlight = 0

  const again = await store.importDocument({ title: "New", text: "new text", source: "new.md" })
  expect(again.outcome).toBe("unchanged")
  expect(again.document.id).toBe(created.document.id)
  expect((await store.listDocuments()).length).toBe(1)
})

// --- one unreadable document must not stop the whole space from opening --
//
// Before `document_keys`, `init()` never read a document's content at all.
// `healKeyTable`'s count-mismatch rebuild made it read every one of them —
// and a single file `parseDocument` cannot make sense of (broken frontmatter
// YAML, or a `created`/`updated` value that is not a date) used to throw
// out of `init()` itself, every time, since the broken file could never earn
// a row and the counts would never agree. `cairn mcp`, search and `cairn
// doctor`'s space check all go through `init()`, so one bad file took all of
// them down at once.

test("a document file that will never parse does not stop init from opening the space", async () => {
  await store.importDocument({ title: "Good", text: "good text", source: "good.md" })
  // A file nothing here can fix: `created` is not a date, which throws a
  // RangeError out of `parseDocument`'s `new Date(...).toISOString()`. The
  // filename does not have to match the frontmatter `id` -- `listDocuments`
  // and its tolerant counterpart both just read every `*.md` in the
  // directory -- so this is exactly the shape of file that could turn up by
  // itself, unrelated to anything the store wrote.
  await writeFile(
    join(root, "documents", "broken.md"),
    "---\nid: doc-broken\ntitle: Broken\nsource: null\ncreated: not-a-date\nupdated: not-a-date\nhash: deadbeef\n---\nbroken body\n",
    "utf-8",
  )
  // The shape an older index.db leaves behind, forcing the heal path on the
  // next open.
  ;(store as unknown as { db: { run(sql: string): void } }).db.run("DELETE FROM document_keys")

  const fresh = new FileStore(root, new EventLog(root))
  await fresh.init()

  const result = await fresh.importDocument({ title: "Good", text: "good text", source: "good.md" })
  expect(result.outcome).toBe("unchanged")
})

// --- adoptImport coverage the generic Store contract cannot exercise ------
//
// Both tests below need a real filesystem underneath the seam — one corrupts
// events.jsonl directly, the other inspects another claim's overlaps array —
// which is exactly what test/store-contract.ts's cases are not allowed to do
// (they run against HttpStore too, over a network, with no file to reach
// into). FileStore-only coverage belongs here instead.

test("adoptImport refuses rather than silently deleting a claim when its event log is damaged", async () => {
  const log = new EventLog(root)
  const s = new FileStore(root, log)
  await s.init()
  const { claim: imported } = await s.importClaim({
    claim: "Using MinerU", body: "It wants Python 3.10.", abstract: "", tags: ["imported"],
    source: { author: "me", agent: "test", repo: null, session: null }, overlaps: [], cites: [],
  })
  // Simulate the damage a crash mid-`appendFile`, or two processes writing at
  // once, leaves behind: a line that will not parse as JSON. `importClaim`
  // above already wrote line 1 (its own `import` event), so this lands on
  // line 2.
  const logPath = join(root, "events.jsonl")
  await appendFile(logPath, `{"kind":"generate","id":"${imported.id}","at":"broken\n`, "utf-8")

  const err = await s.adoptImport(imported.id).then(
    () => null,
    (e: unknown) => e as Error,
  )
  expect(err).not.toBeNull()
  expect(err!.message).toContain(logPath)
  expect(err!.message).toContain("line 2")

  // Fails CLOSED: the claim must still be exactly what it was, and no
  // document must exist from a delete that should never have happened.
  expect((await s.get(imported.id))?.status).toBe("approved")
  expect(await s.listDocuments()).toEqual([])
})

test("adoptImport refuses an import a human moved back to the queue by hand and approved", async () => {
  // The claim this guard specifically exists to catch, and the one the
  // standing positive control (drop "approve" from UNADOPTABLE_KINDS) needs
  // to fail: content that entered through `import` —
  // so it still wears whatever tag the CLI selected it on — and was later
  // approved by a human WITHOUT ever going through `propose`. Its event
  // history ends up exactly `["import", "approve"]`, with no `propose`
  // event to save it if `approve` is ever dropped from UNADOPTABLE_KINDS.
  //
  // Constructed by moving the FILE directly with `rename`, never through
  // `store.move()`: status is owned by the containing directory and
  // imported files are explicitly meant to be hand-editable (`read()`
  // above trusts the directory over the frontmatter for exactly this
  // reason), so a person dragging a file from approved/ into inbox/ needs no
  // code path at all. Depending on no `move()` behaviour here is
  // deliberate: an earlier version of this coverage lived in the shared
  // contract as `store.move(id, "pending")` behind a reachability probe, and
  // if FileStore.move were ever changed to refuse "pending" the way
  // HttpStore.move already does — the exact parity move this codebase made
  // once already for `review` and `AlreadyResolvedError` — that probe would
  // start returning false and the case would go green while asserting
  // nothing, even though the hand-edit path it exists to guard would still
  // be wide open. Moving the file with `rename` sidesteps that: this test
  // cannot be silenced by a change to `move()`.
  const { claim: imported } = await store.importClaim({
    claim: "Using MinerU", body: "It wants Python 3.10.", abstract: "", tags: ["imported"],
    source: { author: "me", agent: "test", repo: null, session: null }, overlaps: [], cites: [],
  })
  await rename(join(root, "approved", `${imported.id}.md`), join(root, "inbox", `${imported.id}.md`))
  // The setup materialised: if it hadn't, the case below would be a no-op
  // dressed as coverage.
  expect((await store.get(imported.id))?.status).toBe("pending")

  await store.review(imported.id, "approve")
  const err = await store.adoptImport(imported.id).then(
    () => null,
    (e: unknown) => e as Error,
  )
  expect(err).not.toBeNull()
  expect(err!.message).toBe(notAdoptableMessage(imported.id, "judged"))
  // The guard is only worth having if the claim survives it.
  expect((await store.get(imported.id))?.status).toBe("approved")
})

test("adoptImport refuses a claim whose history never mentions an import", async () => {
  // The positive half of the guard, and the only place it can be exercised:
  // nothing on the `Store` seam creates a claim without either an `import` or
  // a `propose` event, so a claim carrying neither has to be built underneath
  // the seam. `put` persists and indexes the file and records exactly one
  // `generate` event — the history of a claim that, as far as cairn can tell,
  // arrived from nowhere.
  //
  // A deny list alone would ADOPT this: nothing on it is forbidden. That is
  // the drift the `import` requirement exists to stop, and the reason the
  // guard is two conditions rather than one.
  const c = { ...claim("c-nowhere", "arrived from nowhere"), status: "approved" as const }
  await store.put(c, "generate")
  // The setup materialised: without this the assertion below could pass on a
  // claim that was never there at all, which `adoptImport` refuses with
  // `unknownClaimMessage` — a different sentence, and one that would satisfy a
  // weaker assertion than the one below.
  expect((await store.get(c.id))?.claim).toBe("arrived from nowhere")

  const err = await store.adoptImport(c.id).then(
    () => null,
    (e: unknown) => e as Error,
  )
  expect(err).not.toBeNull()
  expect(err!.message).toBe(notAdoptableMessage(c.id, "not-imported"))
  // The two refusals are different sentences, not one sentence twice.
  expect(err!.message).not.toBe(notAdoptableMessage(c.id, "judged"))
  expect((await store.get(c.id))?.status).toBe("approved")
  expect(await store.listDocuments()).toEqual([])
})

test("adoptImport removes the adopted claim's id from every other claim's overlaps", async () => {
  const { claim: imported } = await store.importClaim({
    claim: "Using MinerU", body: "It wants Python 3.10.", abstract: "", tags: ["imported"],
    source: { author: "me", agent: "test", repo: null, session: null }, overlaps: [], cites: [],
  })
  const pointer = await store.propose({
    claim: "a claim that overlaps the imported one", body: "b", abstract: "", tags: [],
    source: { author: "me", agent: "test", repo: null, session: null },
    overlaps: [imported.id], cites: [],
  })
  // The precondition: if `propose` ever stopped recording overlaps, the
  // assertion below would pass vacuously on an array that was already empty.
  expect(pointer.overlaps).toEqual([imported.id])
  await store.adoptImport(imported.id)
  // The hosted service is held to the same requirement: an overlap pointing at a claim that no longer exists must
  // not dangle.
  expect((await store.get(pointer.id))?.overlaps).toEqual([])
})

test("FileStore lists a retracted claim from its own directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "cairn-status-"))
  try {
    const store = new FileStore(root, new EventLog(root))
    await store.init()
    const claim = await store.propose(proposal("a sentence"))
    await store.move(claim.id, "retracted")
    expect((await store.list("retracted")).map((c) => c.id)).toEqual([claim.id])
    expect(await store.list("approved")).toEqual([])
    expect((await store.get(claim.id))?.status).toBe("retracted")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("FileStore refuses a mine filter rather than answering with the whole queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "cairn-mine-"))
  try {
    const store = new FileStore(root, new EventLog(root))
    await store.init()
    await store.propose(proposal("a sentence"))
    // The positive control: the same call without the filter answers.
    expect((await store.list("pending")).length).toBe(1)
    await expect(store.list("pending", { mine: true })).rejects.toThrow(/team space/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
