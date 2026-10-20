import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { notAdoptableMessage } from "@cairn-kb/protocol/event-kinds"
import { CHUNKER_VERSION } from "@cairn-kb/protocol/retrieval"
import { serializeDocument, windowOf } from "../src/documents"
import { EventLog } from "../src/events"
import { FileStore, INDEX_SCHEMA_VERSION } from "../src/store"
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
  const db = (store as unknown as { db: { run(sql: string): void } }).db
  db.run("DELETE FROM passages")
  db.run("DELETE FROM passage_meta")
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

// --- the passage index ------------------------------------------------------

test("an index from the previous version is rebuilt on open", async () => {
  const old = await mkdtemp(join(tmpdir(), "cairn-old-index-"))
  try {
    // What an install from before passages left behind: a document file on
    // disk, and an index.db at user_version 0 holding the whole-document
    // full-text table and nothing else.
    await mkdir(join(old, "documents"), { recursive: true })
    await writeFile(
      join(old, "documents", "doc-legacy.md"),
      serializeDocument({
        id: "doc-legacy",
        title: "Legacy",
        text: "The capybara migration runs before the release.",
        source: "legacy.md",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        hash: "h",
      }),
      "utf-8",
    )
    const before = new Database(join(old, "index.db"))
    before.run("CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED, title, text, source UNINDEXED)")
    before.run("INSERT INTO documents (id, title, text, source) VALUES ('doc-legacy', 'Legacy', 'x', 'legacy.md')")
    before.close()

    const opened = new FileStore(old, new EventLog(old))
    await opened.init()

    const after = new Database(join(old, "index.db"))
    try {
      expect(INDEX_SCHEMA_VERSION * 100 + CHUNKER_VERSION).toBe(201)
      expect((after.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(201)
      const tables = (after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((t) => t.name)
      expect(tables).not.toContain("documents")
    } finally {
      after.close()
    }
    const { hits } = await opened.searchPassages("capybara")
    expect(hits.map((h) => h.doc)).toEqual(["doc-legacy"])
  } finally {
    await rm(old, { recursive: true, force: true })
  }
})

test("an index already at this version is not rebuilt on open", async () => {
  await store.importDocument({ title: "T", text: "findable text", source: "a.md" })
  // Drift only a rebuild would repair: if opening rebuilt, the hit would come back.
  ;(store as unknown as { db: { run(sql: string): void } }).db.run("DELETE FROM passages")
  const reopened = new FileStore(root, new EventLog(root))
  await reopened.init()
  expect((await reopened.searchPassages("findable")).hits).toEqual([])
})

test("a second process can write while the MCP server holds the index", async () => {
  const server = new FileStore(root, new EventLog(root))
  await server.init()
  const writer = new FileStore(root, new EventLog(root))
  await writer.init()
  // The MCP server mid-read: an open read transaction on its connection. In
  // rollback-journal mode that shared lock refuses every other connection's
  // commit with SQLITE_BUSY; under WAL a reader never blocks a writer.
  const held = (server as unknown as { db: Database }).db
  held.run("BEGIN")
  held.query("SELECT count(*) FROM passages").get()
  try {
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      writer.importDocument({ title: `W${i}`, text: `wombat number ${i}`, source: `w${i}.md` })))
  } finally {
    held.run("COMMIT")
  }
  // And both writing at once, as `cairn import` beside a running server does.
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) =>
      writer.importDocument({ title: `X${i}`, text: `wombat extra ${i}`, source: `x${i}.md` })),
    ...Array.from({ length: 5 }, (_, i) =>
      server.importDocument({ title: `S${i}`, text: `wombat entry ${i}`, source: `s${i}.md` })),
  ])
  const { hits } = await server.searchPassages("wombat", { limit: 50 })
  expect(hits.length).toBe(15)
}, 20000)

test("a read at a passage's offset starts on the passage", async () => {
  const text = [
    "## First",
    "Ünïcödé 🚀 " + "padding words to make this section long enough to stand alone. ".repeat(5),
    "## Second",
    "The axolotl section starts here. " + "more words so the section stays its own passage. ".repeat(5),
  ].join("\n\n")
  const { document } = await store.importDocument({ title: "Read", text, source: "read.md" })
  const { hits } = await store.searchPassages("axolotl")
  const hit = hits[0]!
  expect(hit.doc).toBe(document.id)
  expect(windowOf(document.text, hit.offset).text.startsWith(hit.text.slice(0, 50))).toBe(true)
})

test("an index deleted by hand reopens, though its write-ahead log was left behind", async () => {
  const { document } = await store.importDocument({ title: "T", text: "the narwhal note", source: "a.md" })
  // WAL mode keeps index.db-wal and index.db-shm beside the database; deleting
  // index.db alone leaves them to be replayed into a fresh, empty file.
  await rm(join(root, "index.db"), { force: true })
  const reopened = new FileStore(root, new EventLog(root))
  await reopened.init()
  expect((await reopened.searchPassages("narwhal")).hits.map((h) => h.doc)).toEqual([document.id])
})

test("searchDocuments finds every matching document, however many sections one of them has", async () => {
  const sec = (i: number) =>
    `## S${i}\n\n` + "zebra zebra zebra stripes. ".repeat(20) + "filler text to make it long enough. ".repeat(10)
  const big = await store.importDocument({
    title: "Big", text: Array.from({ length: 80 }, (_, i) => sec(i)).join("\n\n"), source: "big.md",
  })
  for (let i = 0; i < 30; i++) {
    await store.importDocument({
      title: `Small ${i}`,
      text: `A note that mentions a zebra once, among many other unrelated words about item ${i}.`,
      source: `s${i}.md`,
    })
  }
  const docs = await store.searchDocuments("zebra")
  expect(docs.length).toBe(31)
  expect(docs[0]!.id).toBe(big.document.id)
  expect((await store.searchPassages("zebra")).hits.length).toBe(6)
})

/** Run `during` after the store has read the files for a rebuild, before it writes the index. */
function betweenSnapshotAndWrite(target: FileStore, during: () => Promise<void>): void {
  const seam = target as unknown as { snapshot(): Promise<unknown> }
  const original = seam.snapshot.bind(target)
  seam.snapshot = async () => {
    const snap = await original()
    await during()
    return snap
  }
}

test("a document imported while the index rebuilds stays in the index", async () => {
  await store.importDocument({ title: "Old", text: "the heron note", source: "old.md" })
  const other = new FileStore(root, new EventLog(root))
  await other.init()
  betweenSnapshotAndWrite(store, async () => {
    await other.importDocument({ title: "New", text: "the egret note", source: "new.md" })
  })
  expect(await store.rebuildIndex()).toEqual({ claims: 0, documents: 1 })
  expect((await store.searchPassages("egret")).hits.length).toBe(1)
  expect((await store.searchPassages("heron")).hits.length).toBe(1)
})

test("a document changed while the index rebuilds keeps its new passages", async () => {
  await store.importDocument({ title: "Doc", text: "the bittern note", source: "doc.md" })
  const other = new FileStore(root, new EventLog(root))
  await other.init()
  betweenSnapshotAndWrite(store, async () => {
    await other.importDocument({ title: "Doc", text: "the plover note", source: "doc.md" })
  })
  await store.rebuildIndex()
  expect((await store.searchPassages("plover")).hits.length).toBe(1)
  expect((await store.searchPassages("bittern")).hits).toEqual([])
})

test("a rebuild drops the passages of a document whose file is gone", async () => {
  const { document } = await store.importDocument({ title: "Gone", text: "the curlew note", source: "gone.md" })
  await rm(join(root, "documents", `${document.id}.md`))
  await store.rebuildIndex()
  expect((await store.searchPassages("curlew")).hits).toEqual([])
})

test("an upgrade another process finished first is not written over", async () => {
  const old = await mkdtemp(join(tmpdir(), "cairn-race-index-"))
  try {
    await mkdir(join(old, "documents"), { recursive: true })
    const before = new Database(join(old, "index.db"))
    before.run("CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED, title, text, source UNINDEXED)")
    before.close()
    const slow = new FileStore(old, new EventLog(old))
    const fast = new FileStore(old, new EventLog(old))
    // `fast` upgrades the index and imports while `slow` sits between reading
    // the files and writing: `slow`'s snapshot predates the import, and
    // writing it now would leave the index without that document.
    betweenSnapshotAndWrite(slow, async () => {
      await fast.init()
      await fast.importDocument({ title: "Late", text: "the avocet note", source: "late.md" })
    })
    await slow.init()
    expect((await slow.searchPassages("avocet")).hits.length).toBe(1)
  } finally {
    await rm(old, { recursive: true, force: true })
  }
})

test("an upgrade indexes a file touched between its read and its write rather than leave it out", async () => {
  const old = await mkdtemp(join(tmpdir(), "cairn-touched-index-"))
  try {
    const seed = new FileStore(old, new EventLog(old))
    await seed.init()
    const { document } = await seed.importDocument({ title: "Touched", text: "the dunlin note", source: "t.md" })
    const claim = await seed.propose(proposal("the sanderling claim"))
    // Back to an index from before passages, with the claim row gone too, so
    // both halves start with nothing for the upgrade to keep.
    const db = (seed as unknown as { db: Database }).db
    db.run("DELETE FROM claims")
    db.run("DROP TABLE passages")
    db.run("DROP TABLE passage_meta")
    db.run("PRAGMA user_version = 0")

    // Not a cairn writer: a hand edit, a checkout or a sync tool touching the
    // files after the upgrade read them. Nobody will index them afterwards.
    const later = new Date(Date.now() + 60_000)
    const upgrading = new FileStore(old, new EventLog(old))
    betweenSnapshotAndWrite(upgrading, async () => {
      await utimes(join(old, "documents", `${document.id}.md`), later, later)
      await utimes(join(old, "inbox", `${claim.id}.md`), later, later)
    })
    await upgrading.init()
    expect((await upgrading.searchPassages("dunlin")).hits.map((h) => h.doc)).toEqual([document.id])
    expect((await upgrading.search("sanderling")).map((c) => c.id)).toEqual([claim.id])
  } finally {
    await rm(old, { recursive: true, force: true })
  }
})
