import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { READ_WINDOW } from "../src/documents"
import { EMPTY_SUPPORTS } from "@cairn-kb/protocol/event-kinds"
import { EventLog } from "../src/events"
import type { EventSink } from "../src/events"
import {
  ABSTRACT_GUIDANCE,
  CITE_DESCRIPTION,
  createMcpServer,
  createTools,
  MAP_DESCRIPTION,
  PROPOSE_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  TEAM_WRITE_REFUSAL,
  type KbTools,
} from "../src/mcp"
import { FileStore } from "../src/store"
import type { Claim, CiteInput } from "@cairn-kb/protocol/types"
import { VERSION } from "../src/version"

/** A `propose` argument bundle with every required field filled, for tests
 *  that only care about one field varying (here, `cites`). */
const proposeArgs = {
  claim: "Citing claim",
  body: "",
  abstract: "Settles one thing. Does not settle others.",
  author: "r",
  agent: "cursor",
}

/** Shorthand matching kbPropose's own `ProposeInput` shape, for tests that
 *  build a proposal inline rather than through `tools.kbPropose`. */
const proposal = (claim: string) => ({
  claim,
  body: "",
  abstract: "Settles one thing. Does not settle others.",
  source: { author: "r", agent: "cursor", repo: null, session: null },
  overlaps: [],
  cites: [],
  tags: [],
})

let root: string
let tools: KbTools
let log: EventLog
let store: FileStore

/** An approved claim seeded by `cairn import`: no agent wrote it, so it has no
 *  abstract and its claim sentence is the document's title. */
const imported = (title: string): Claim => ({
  id: "import-specs-design",
  status: "approved",
  claim: title,
  body: `# ${title}\n\nLong document body.`,
  source: { author: "alice", agent: "import", repo: null, session: null },
  created: "2026-08-26T09:00:00.000Z",
  reviewed: "2026-08-26T09:00:00.000Z",
  reviewer: "alice",
  retracted: null,
  overlaps: [],
  cites: [],
  abstract: null,
  abstractBy: null,
  tags: ["imported"],
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-mcp-"))
  log = new EventLog(root)
  store = new FileStore(root, log)
  await store.init()
  tools = createTools(store, log)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("the propose description sets a precision bar", () => {
  expect(PROPOSE_DESCRIPTION).toContain("Not task status")
})

test("the cite description says some claims have nothing to cite", () => {
  // The sentence this pins is the whole point of the description: a decided
  // claim has no document, and attaching the nearest one makes it look sourced.
  expect(CITE_DESCRIPTION).toContain("the right number of citations is zero")
  expect(CITE_DESCRIPTION).toContain("cite nothing")
})

test("the cite description constrains rather than encourages", () => {
  // The when-to-cite sentence was removed from search's description so that a
  // non-empty `cites` measures grounding and not instruction-following. A
  // description that told agents to cite would undo that, so this asserts the
  // absence of the encouraging forms rather than trusting a reader to notice
  // one being added later.
  for (const nudge of ["remember to cite", "always cite", "cite whenever", "be sure to cite"]) {
    expect(CITE_DESCRIPTION.toLowerCase()).not.toContain(nudge)
  }
})

test("the cite description does not claim the absence report validates support", () => {
  // Presence is not support and absence is not refutation — packages/protocol/src/absence.ts
  // says so, and the tool an agent reads has to say it too.
  expect(CITE_DESCRIPTION).toContain("cannot tell whether the document supports the claim")
})

test("propose files a pending claim and returns its id", async () => {
  const out = await tools.kbPropose({
    claim: "Billing uses Postgres",
    body: "ACID on invoices",
    abstract: "Settles one thing. Does not settle others.",
    author: "alice",
    agent: "cursor",
  })
  expect(out.id).toContain("billing-uses-postgres")
  // Checked against the store directly, not tools.kbRead: kbRead is gated to
  // approved claims only, so it must not see this pending one (see the
  // dedicated read-gate tests below).
  const store = new FileStore(root)
  await store.init()
  const stored = await store.get(out.id)
  expect(stored!.status).toBe("pending")
})

test("propose attaches overlaps against approved claims", async () => {
  const first = await tools.kbPropose({
    claim: "Billing uses Postgres for invoices",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
    tags: ["billing"],
  })
  const store = new FileStore(root)
  await store.init()
  await store.move(first.id, "approved")

  const second = await tools.kbPropose({
    claim: "Billing uses Postgres, not Mongo, for invoices",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
    tags: ["billing"],
  })
  expect(second.overlaps).toContain(first.id)
})

test("re-proposing an identical claim leaves the approved one intact", async () => {
  const store = new FileStore(root)
  await store.init()

  const first = await tools.kbPropose({
    claim: "Billing uses Postgres, not Mongo",
    body: "first",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  await store.move(first.id, "approved")

  // Same sentence, same day — the ordinary case of two teammates' agents
  // learning the same thing, or one agent retrying a propose that looked like
  // it failed. The approved claim must survive it.
  const second = await tools.kbPropose({
    claim: "Billing uses Postgres, not Mongo",
    body: "second",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })

  expect(second.id).not.toBe(first.id)
  const approved = await store.list("approved")
  expect(approved.map((c) => c.id)).toEqual([first.id])
  expect((await store.list("pending")).map((c) => c.id)).toEqual([second.id])
  // Both survive, and the reviewer is told they overlap — the designed
  // workflow, rather than one silently replacing the other.
  expect(second.overlaps).toContain(first.id)
})

test("kbMap only exposes approved claims", async () => {
  const p = await tools.kbPropose({ claim: "Pending thing", body: "", author: "r",
    abstract: "Settles one thing. Does not settle others.", agent: "cursor" })
  expect((await tools.kbMap()).entries).toEqual([])
  const store = new FileStore(root)
  await store.init()
  await store.move(p.id, "approved")
  const { entries: map } = await tools.kbMap()
  expect(map.length).toBe(1)
  expect(map[0]!.id).toBe(p.id)
})

test("reading and mapping are logged", async () => {
  await tools.kbMap()
  const stats = await log.stats()
  expect(stats.reads).toBe(1)
})

test("kbMap records the calling agent and session", async () => {
  await tools.kbMap({ agent: "cursor", session: "s1" })
  await tools.kbMap({ agent: "cursor", session: "s1" })
  await tools.kbMap({ agent: "claude", session: "s2" })
  const events = (await log.all()).filter((e) => e.kind === "map")
  expect(events[0]!.meta).toEqual({ agent: "cursor", session: "s1" })
  // Reads per session needs the denominator.
  expect((await log.stats()).sessions).toBe(2)
})

test("kbSearch is logged as a search, not as a read", async () => {
  await tools.kbSearch("postgres")
  const stats = await log.stats()
  expect(stats.searches).toBe(1)
  expect(stats.reads).toBe(0)
})

test("a read denied by the gate is logged as denied, not as silence", async () => {
  const p = await tools.kbPropose({
    claim: "Pending claim nobody may read",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  expect(await tools.kbRead([p.id])).toEqual([])
  const stats = await log.stats()
  expect(stats.reads).toBe(1)
  expect(stats.deniedReads).toBe(1)
})

test("kbRead hides a pending claim, then reveals it once approved", async () => {
  const p = await tools.kbPropose({
    claim: "Pending claim for read gate",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  expect(await tools.kbRead([p.id])).toEqual([])

  const store = new FileStore(root)
  await store.init()
  await store.move(p.id, "approved")

  const read = await tools.kbRead([p.id])
  expect(read.length).toBe(1)
  expect(read[0]!.id).toBe(p.id)
})

test("kbRead hides a rejected claim permanently", async () => {
  const p = await tools.kbPropose({
    claim: "Rejected claim for read gate",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  const store = new FileStore(root)
  await store.init()
  await store.move(p.id, "rejected")

  expect(await tools.kbRead([p.id])).toEqual([])
})

test("kbSearch hides a pending claim, then reveals it once approved", async () => {
  await tools.kbPropose({
    claim: "Zephyrwidget uses a custom serializer",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  expect((await tools.kbSearch("Zephyrwidget")).hits).toEqual([])

  const store = new FileStore(root)
  await store.init()
  const pending = (await store.list("pending")).find((c) => c.claim.includes("Zephyrwidget"))!
  await store.move(pending.id, "approved")

  const { hits } = await tools.kbSearch("Zephyrwidget")
  expect(hits.length).toBe(1)
  const [hit] = hits
  expect(hit!.kind).toBe("claim")
  expect(hit!.kind === "claim" && hit.id).toBe(pending.id)
})

test("kbSearch hides a rejected claim permanently", async () => {
  await tools.kbPropose({
    claim: "Quixarnaught batches writes at night",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  const store = new FileStore(root)
  await store.init()
  const pending = (await store.list("pending")).find((c) => c.claim.includes("Quixarnaught"))!
  await store.move(pending.id, "rejected")

  expect((await tools.kbSearch("Quixarnaught")).hits).toEqual([])
})

test("frontmatter claiming approval does not escape the inbox", async () => {
  // The design invites file-level editing, so a claim in inbox/ whose
  // frontmatter says `status: approved` is reachable by a hand edit, a git
  // merge or an agent tidying frontmatter. The directory decides, not the file.
  const store = new FileStore(root)
  await store.init()
  await writeFile(
    join(root, "inbox", "forged.md"),
    [
      "---",
      "id: forged",
      "status: approved",
      "claim: Zalgothrup keys are rotated nightly",
      "source:",
      "  author: r",
      "  agent: cursor",
      "created: 2026-08-26T09:00:00.000Z",
      "tags: []",
      "---",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  )
  await store.rebuildIndex()

  expect(await tools.kbRead(["forged"])).toEqual([])
  expect((await tools.kbSearch("Zalgothrup")).hits).toEqual([])
  expect((await tools.kbMap()).entries).toEqual([])
  expect((await store.get("forged"))!.status).toBe("pending")
})

test("createMcpServer registers exactly the six expected tools and enforces the read gate end to end", async () => {
  const store = new FileStore(root, log)
  await store.init()
  const server = createMcpServer(store, log)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  // This exact-set assertion is also the guard that no
  // `team_knowledge_uncite` tool exists. `listTools()` enumerates every
  // registration the live server actually exposes, so a server that
  // registered `uncite` — whether or not it went on to refuse every call —
  // would fail this list before an agent ever reached it. A source-level
  // regex over src/mcp.ts was tried here too and removed: it duplicated this
  // check without `test/capability-inventory.test.ts`'s comment-stripping
  // step, so a deleted registration with a surviving comment could have
  // passed it while this one still catches the real absence.
  const { tools: registered } = await client.listTools()
  expect(registered.map((t) => t.name).sort()).toEqual([
    "team_knowledge_cite",
    "team_knowledge_map",
    "team_knowledge_propose",
    "team_knowledge_read",
    "team_knowledge_search",
    "team_knowledge_write_document",
  ])

  const proposeResult = await client.callTool({
    name: "team_knowledge_propose",
    arguments: {
      claim: "Server routed claim",
      body: "",
      abstract: "Settles one thing. Does not settle others.",
      author: "r",
      agent: "cursor",
    },
  })
  const proposed = JSON.parse((proposeResult.content as { text: string }[])[0]!.text) as {
    id: string
  }

  // Real integration coverage: go through the wire protocol, not the
  // in-process handler object, so an inlined bypass of the approval gate
  // inside a server.tool callback would show up here.
  const mapBefore = await client.callTool({ name: "team_knowledge_map", arguments: {} })
  expect(JSON.parse((mapBefore.content as { text: string }[])[0]!.text).entries).toEqual([])

  const readBefore = await client.callTool({
    name: "team_knowledge_read",
    arguments: { ids: [proposed.id] },
  })
  expect(JSON.parse((readBefore.content as { text: string }[])[0]!.text)).toEqual([])

  await store.move(proposed.id, "approved")

  const mapAfter = await client.callTool({ name: "team_knowledge_map", arguments: {} })
  const mapped = JSON.parse((mapAfter.content as { text: string }[])[0]!.text) as {
    entries: { id: string }[]
  }
  expect(mapped.entries.map((c) => c.id)).toEqual([proposed.id])

  const readAfter = await client.callTool({
    name: "team_knowledge_read",
    arguments: { ids: [proposed.id] },
  })
  const read = JSON.parse((readAfter.content as { text: string }[])[0]!.text) as { id: string }[]
  expect(read.map((c) => c.id)).toEqual([proposed.id])

  // Logging must happen on the wire path too, not just when calling the
  // KbTools object directly: one propose (via team_knowledge_propose) and four reads —
  // mapBefore + mapAfter + readAfter, plus readBefore, which is refused by the
  // gate and logged as denied rather than dropped.
  const stats = await log.stats()
  expect(stats.proposed).toBe(1)
  expect(stats.reads).toBe(4)
  expect(stats.deniedReads).toBe(1)

  await client.close()
})

test("propose requires an abstract and stores it on the claim", async () => {
  const out = await tools.kbPropose({
    claim: "Billing uses Postgres",
    body: "ACID on invoices",
    abstract: "Settles the billing datastore. Says nothing about caching or reporting.",
    author: "alice",
    agent: "cursor",
  })
  const read = await tools.kbRead([out.id])
  expect(read).toEqual([])
  const store = new FileStore(root)
  await store.init()
  await store.move(out.id, "approved")
  // out.id is a claim id, never a document id, so this cast just names what
  // kbRead's union already guarantees here.
  const reread = (await tools.kbRead([out.id]))[0] as Claim
  expect(reread.abstract).toContain("Says nothing about caching")
})

test("the abstract the agent wrote is what the map shows", async () => {
  const out = await tools.kbPropose({
    claim: "Deploys run on Tuesdays",
    body: "",
    abstract: "Settles the deploy cadence. Does not cover rollback.",
    author: "r",
    agent: "cursor",
  })
  const store = new FileStore(root)
  await store.init()
  await store.move(out.id, "approved")
  const { entries: map } = await tools.kbMap()
  expect(map[0]!.abstract).toBe("Settles the deploy cadence. Does not cover rollback.")
  expect(map[0]!.claim).toBe("Deploys run on Tuesdays")
})

test("the map admits a missing abstract rather than passing the claim off as one", async () => {
  // Seeding is a content write and records one, so this store needs a sink.
  const store = new FileStore(root, new EventLog(root))
  await store.init()
  await store.put(imported("Payments Service — Overview"), "curate")
  const { entries: map } = await tools.kbMap()
  // The title still travels, as a title. What must not happen is it arriving
  // in the abstract field, where an agent would read a genre label as a
  // summary and never open the claim.
  expect(map[0]!.abstract).toBeNull()
  expect(map[0]!.claim).toBe("Payments Service — Overview")
})


/** Connect a real client over the in-memory transport and hand back what the
 *  handshake told it. The annotations, the version and the instructions are
 *  only observable from the client side, which is the side that acts on them. */
async function connected(store: FileStore, log: EventLog) {
  const server = createMcpServer(store, log)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

test("every read tool is annotated read-only, so a host can run it without a prompt", async () => {
  const store = new FileStore(root, log)
  await store.init()
  const client = await connected(store, log)
  const { tools } = await client.listTools()
  const byName = new Map(tools.map((t) => [t.name, t]))

  for (const name of ["team_knowledge_map", "team_knowledge_read", "team_knowledge_search"]) {
    const tool = byName.get(name)!
    // The criteria make `title` pass/fail alongside the hint, and the hint is
    // what decides auto-permission. A missing annotation is not a neutral
    // default: the host assumes the worst and prompts.
    // `title` is the Tool-level field in the current spec; ToolAnnotations
    // also carries one, superseded by this and left unset rather than
    // duplicated.
    expect(tool.title, `${name} has no title`).toBeTruthy()
    expect(tool.annotations?.readOnlyHint, `${name} is not marked read-only`).toBe(true)
  }
})

test("propose is a write, and is deliberately not destructive", async () => {
  const store = new FileStore(root, log)
  await store.init()
  const client = await connected(store, log)
  const { tools } = await client.listTools()
  const propose = tools.find((t) => t.name === "team_knowledge_propose")!

  expect(propose.title).toBeTruthy()
  expect(propose.annotations?.readOnlyHint).toBe(false)
  // It appends a pending claim and removes nothing. Marking it destructive
  // would put a confirmation dialog in front of the one call the product
  // wants agents making more often.
  expect(propose.annotations?.destructiveHint).toBe(false)
  // Two proposals of the same sentence file two claims.
  expect(propose.annotations?.idempotentHint).toBe(false)
})

test("the server reports the build version, not a literal that drifts", async () => {
  const store = new FileStore(root, log)
  await store.init()
  const client = await connected(store, log)
  // Hardcoded, this said 0.1.0 while the CLI shipped 0.4.0 — and nothing in
  // the release workflow's version check can see a string inside mcp.ts.
  expect(client.getServerVersion()?.version).toBe(VERSION)
  expect(client.getServerVersion()?.name).toBe("cairn")
})

test("the map-first rule reaches the host as instructions, not as a tool description", async () => {
  const store = new FileStore(root, log)
  await store.init()
  const client = await connected(store, log)

  expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
  expect(SERVER_INSTRUCTIONS).toContain("team_knowledge_map")
  // The half that guards the regression: the review criteria reject a tool
  // description that tells the model how to behave, and this one used to open
  // with "Call this first, at the start of a session".
  expect(MAP_DESCRIPTION).not.toContain("Call this first")
})

test("the map description tells an agent what a missing abstract means", () => {
  expect(MAP_DESCRIPTION).toContain("null")
})

test("the propose schema tells the agent what an abstract must contain", () => {
  expect(ABSTRACT_GUIDANCE).toContain("does NOT")
})

test("search returns claims before documents", async () => {
  await store.importDocument({ title: "Ingestion", text: "conversion pre-step", source: "a.md" })
  const claim = await store.propose(proposal("conversion is out of band"))
  await store.review(claim.id, "approve")
  const { hits } = await tools.kbSearch("conversion")
  // A rule, not a scoring weight: curated claims outrank raw documents, and
  // an agent can predict that without knowing anything about FTS ranking.
  expect(hits[0]?.kind).toBe("claim")
  expect(hits.at(-1)?.kind).toBe("document")
})

test("a document search hit carries a preview, never the whole text", async () => {
  // Space-separated repeats, not one 10,000-char run: FTS5 tokenizes on
  // whitespace, so a single giant token would never match a 3-letter query —
  // this keeps the document just as long while staying findable.
  await store.importDocument({ title: "Big", text: "zzz ".repeat(2500), source: "a.md" })
  const hit = (await tools.kbSearch("zzz")).hits.find((h) => h.kind === "document")
  expect(hit && "preview" in hit && hit.preview.length < 1000).toBe(true)
})

test("map never returns a document", async () => {
  await store.importDocument({ title: "T", text: "text", source: "a.md" })
  expect((await tools.kbMap()).entries).toEqual([])
})

test("reading a long document returns a window and where to continue", async () => {
  const { document } = await store.importDocument({ title: "T", text: "y".repeat(9000), source: "a.md" })
  const [first] = await tools.kbRead([document.id])
  expect("nextOffset" in first! && first.nextOffset).toBe(READ_WINDOW)
  const [second] = await tools.kbRead([document.id], READ_WINDOW)
  expect("offset" in second! && second.offset).toBe(READ_WINDOW)
})

test("a document read carries the hash a citation can be compared against", async () => {
  // A re-import updates a document in place and keeps its id, so the
  // hash recorded on the citation was the only record that the cited text had
  // moved — and the agent holding it had nothing to compare it with. `cairn
  // show` and the review screen could both see this; the agents that write the
  // citations could not.
  const first = await store.importDocument({ title: "d", text: "the install command", source: "d.md" })
  const { id } = await tools.kbPropose(proposeArgs)
  await store.review(id, "approve")
  await tools.kbCite({ claim: id, doc: first.document.id, supports: "the install command", agent: "cursor" })
  const second = await store.importDocument({ title: "d", text: "some other command", source: "d.md" })
  expect(second.outcome).toBe("updated")
  expect(second.document.id).toBe(first.document.id)

  const [claim, doc] = await tools.kbRead([id, first.document.id])
  const recorded = claim && "cites" in claim ? claim.cites[0]!.hash : null
  expect(recorded).toBe(first.document.hash)
  expect(doc && "hash" in doc && doc.hash).toBe(second.document.hash)
  // The whole point: the two differ, and an agent can now see that they do.
  expect(recorded).not.toBe(second.document.hash)
})

test("a document read hash is the document's, not a hash of the window returned", async () => {
  // The field must answer "has this document changed since it was cited",
  // which a hash of the first READ_WINDOW characters would not: two documents
  // sharing an opening and differing later would compare as identical.
  const { document } = await store.importDocument({ title: "T", text: "y".repeat(9000), source: "a.md" })
  const [first] = await tools.kbRead([document.id])
  const [second] = await tools.kbRead([document.id], READ_WINDOW)
  expect(first && "hash" in first && first.hash).toBe(document.hash)
  expect(second && "hash" in second && second.hash).toBe(document.hash)
})

test("an offset with several ids is refused, naming the remedy", async () => {
  const a = await store.importDocument({ title: "A", text: "a", source: "a.md" })
  const b = await store.importDocument({ title: "B", text: "b", source: "b.md" })
  // One offset across a list silently returns the wrong window from every
  // document but the first, which is worse than a refusal.
  await expect(tools.kbRead([a.document.id, b.document.id], 10)).rejects.toThrow(/one document at a time/)
})

test("a pending claim is still invisible to read", async () => {
  // The approval gate is unchanged. This is the case a document read path is
  // most likely to break by accident.
  const claim = await store.propose(proposal("not yet approved"))
  expect(await tools.kbRead([claim.id])).toEqual([])
})

test("a document id that does not resolve is a miss, not a gate refusal", async () => {
  // deniedReads is read to judge whether the approval gate is a bottleneck.
  // Documents have no gate, so a typo'd or hallucinated document id must not
  // move that counter — it would either manufacture apparent review friction
  // or hide a real document-id usability problem inside a number nobody
  // thinks to check for it. The read still counts as an ask, though.
  expect(await tools.kbRead(["doc-nope"])).toEqual([])
  const stats = await log.stats()
  expect(stats.reads).toBe(1)
  expect(stats.deniedReads).toBe(0)
})

test("propose refuses a citation to a document that does not exist", async () => {
  await expect(
    tools.kbPropose({ ...proposeArgs, cites: [{ doc: "doc-nope", supports: "the install command" }] }),
  ).rejects.toThrow(/doc-nope/)
})

test("propose records the citations it was given", async () => {
  const { document } = await store.importDocument({ title: "T", text: "text", source: "a.md" })
  const { id } = await tools.kbPropose({
    ...proposeArgs,
    cites: [{ doc: document.id, supports: "the install command" }],
  })
  expect((await store.get(id))?.cites.map((c) => c.doc)).toEqual([document.id])
})

test("an agent can attach a citation to an approved claim", async () => {
  const { document } = await store.importDocument({ title: "d", text: "the install command", source: "d.md" })
  const { id } = await tools.kbPropose(proposeArgs)
  await store.review(id, "approve")
  const result = await tools.kbCite({ claim: id, doc: document.id, supports: "the install command", agent: "cursor" })
  expect(result.cites).toBe(1)
  expect((await store.get(id))!.cites[0]!.by).toBe("cursor")
})

test("a proposal citing bare document ids is refused, naming the field", async () => {
  // The clean break. Accepting both shapes would mean a citation could still
  // arrive without scope, which is the whole defect — a grace period here is
  // indistinguishable from not making the change.
  const { document } = await store.importDocument({ title: "d", text: "t", source: "d.md" })
  expect(
    tools.kbPropose({ ...proposeArgs, cites: [document.id] as unknown as CiteInput[] }),
  ).rejects.toThrow(/supports/)
})

test("a citation with no scope is refused", async () => {
  const { document } = await store.importDocument({ title: "d", text: "t", source: "d.md" })
  const { id } = await tools.kbPropose(proposeArgs)
  expect(tools.kbCite({ claim: id, doc: document.id, supports: "  ", agent: "cursor" })).rejects.toThrow(
    EMPTY_SUPPORTS,
  )
})

test("propose refuses a citation whose supports is blank", async () => {
  // The loop in kbPropose that checks each cite's supports before the
  // unknown-document check — previously untested, unlike the equivalent
  // check on kbCite above.
  const { document } = await store.importDocument({ title: "d", text: "t", source: "d.md" })
  await expect(
    tools.kbPropose({ ...proposeArgs, cites: [{ doc: document.id, supports: "   " }] }),
  ).rejects.toThrow(EMPTY_SUPPORTS)
})

test("a padded supports round-trips identically through propose and cite", async () => {
  // The asymmetry already caught once on `reason` (src/store.ts's `retract`):
  // the hosted service trims `supports` before it stores anything, so the
  // FileStore path must trim at the same single
  // point — inside `citation()` — or "  x  " would read back as itself
  // locally and as "x" hosted, two stores disagreeing about a value a human
  // reads back later.
  const { document: docA } = await store.importDocument({ title: "a", text: "t", source: "a.md" })
  const { document: docB } = await store.importDocument({ title: "b", text: "t", source: "b.md" })
  const { id } = await tools.kbPropose({ ...proposeArgs, cites: [{ doc: docA.id, supports: "  padded  " }] })
  expect((await store.get(id))?.cites[0]?.supports).toBe("padded")
  await store.review(id, "approve")
  await tools.kbCite({ claim: id, doc: docB.id, supports: "  also padded  ", agent: "cursor" })
  expect((await store.get(id))?.cites[1]?.supports).toBe("also padded")
})

// --- response economics ----------------------------------------------------
//
// One `team_knowledge_search` over a handful of claims used to return
// kilobytes, because a claim hit carried its whole
// body while a document hit correctly carried a 240-character preview. The
// principle was stated in `SearchHit`'s own doc comment and applied to one of
// the two nouns.

/** `n` approved claims whose text all matches `word`. */
async function seedClaims(word: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const { id } = await tools.kbPropose({
      claim: `${word} claim number ${i}`,
      body: "x".repeat(2000),
      abstract: "Settles one thing. Does not settle others.",
      author: "r",
      agent: "cursor",
    })
    await store.move(id, "approved")
  }
}

async function seedDocs(word: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.importDocument({
      title: `${word} document ${i}`,
      text: `${word} body ${i}\n${"y".repeat(2000)}`,
      source: `${word}-${i}.md`,
    })
  }
}

test("a claim hit carries the sentence and abstract, never the body", async () => {
  // Search is for deciding what to read next. The body is what
  // team_knowledge_read is for, and it is the whole of the byte problem.
  await seedClaims("Balustrade", 1)
  const { hits } = await tools.kbSearch("Balustrade")
  const hit = hits[0]!
  expect(hit.kind).toBe("claim")
  const json = JSON.stringify(hit)
  expect(json).not.toContain("xxxx")
  expect(json).toContain("Balustrade claim number 0")
  expect(json).toContain("Settles one thing")
})

test("search returns at most `limit` of each kind and says what it left out", async () => {
  await seedClaims("Cassowary", 6)
  const result = await tools.kbSearch("Cassowary", 2)
  expect(result.hits.length).toBe(2)
  expect(result.omitted).toBe(4)
  // A number an agent might skip past, and a sentence it will not.
  expect(result.notice).toContain("4")
  // Results within a block are ranked by `bm25`, so "narrow the query" is
  // the wrong advice for a truncated response — raising `limit` is what
  // actually surfaces the rest, in the order they already came back.
  expect(result.notice).not.toContain("narrow")
  expect(result.notice).toContain("raise limit")
  expect(result.notice).toContain("best first")
})

test("the limit applies to each block, so documents are never crowded out", async () => {
  // The load-bearing detail. Claims come first as a whole block, so ONE
  // overall limit would let a popular query fill the response with claims and
  // return no documents at all — and whether an agent ever cites a document
  // is the question the document noun exists to answer. Starving documents
  // out of search would answer it by construction.
  await seedClaims("Ptarmigan", 5)
  await seedDocs("Ptarmigan", 5)
  const { hits, omitted } = await tools.kbSearch("Ptarmigan", 2)
  expect(hits.filter((h) => h.kind === "claim").length).toBe(2)
  expect(hits.filter((h) => h.kind === "document").length).toBe(2)
  expect(omitted).toBe(6)
})

test("nothing is omitted when everything fits, and the notice is absent", async () => {
  await seedClaims("Marmoset", 2)
  const result = await tools.kbSearch("Marmoset", 10)
  expect(result.omitted).toBe(0)
  expect(result.notice).toBeUndefined()
})

test("the map is bounded the same way", async () => {
  // Unbounded, it grows with the space: the call every agent makes at the
  // start of every session is the last one that should scale with success.
  await seedClaims("Nightjar", 5)
  const result = await tools.kbMap({ limit: 2 })
  expect(result.entries.length).toBe(2)
  expect(result.omitted).toBe(3)
  expect(result.notice).toContain("team_knowledge_search")
})

test("a multi-id read records its events in one call, not one per id", async () => {
  // Against the hosted store each append is a POST, so reading five
  // claims made five sequential round trips on the path agents use most —
  // reading is the common operation, proposing the rare one.
  const seen: number[] = []
  const counting: EventSink = {
    append: (kind, id, meta) => {
      seen.push(1)
      return log.append(kind, id, meta)
    },
    appendMany: (events) => {
      seen.push(events.length)
      return log.appendMany(events)
    },
    all: () => log.all(),
    allStrict: () => log.allStrict(),
    stats: () => log.stats(),
  }
  const t = createTools(store, counting)
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    const { id } = await t.kbPropose({
      claim: `Sandgrouse claim ${i}`,
      body: "b",
      abstract: "Settles one thing. Does not settle others.",
      author: "r",
      agent: "cursor",
    })
    await store.move(id, "approved")
    ids.push(id)
  }
  seen.length = 0

  expect((await t.kbRead(ids)).length).toBe(3)
  // One call carrying three events, rather than three calls.
  expect(seen).toEqual([3])
  // And the events themselves are unchanged: the instrument must read exactly
  // the same either way.
  expect((await log.all()).filter((e) => e.kind === "read").length).toBe(3)
})

test("a read that throws part-way still records the ids it got through", async () => {
  // Batching the appends means one failure could discard the whole batch:
  // without the `finally`, a throw on the second id would log nothing for the
  // first, and `reads` would under-count — the one direction a measurement
  // error must never take.
  //
  // An id whose LOOKUP throws records nothing, which is unchanged: the event
  // was always appended after the store returned, not before it was asked.
  const { id } = await tools.kbPropose({
    claim: "Tanager claim",
    body: "b",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  await store.move(id, "approved")
  const exploding = {
    ...store,
    get: async (wanted: string) => {
      if (wanted === "doc-boom") throw new Error("transient")
      return store.get(wanted)
    },
    getDocument: async () => {
      throw new Error("transient")
    },
  } as unknown as FileStore
  const t = createTools(exploding, log)
  await expect(t.kbRead([id, "doc-boom"])).rejects.toThrow("transient")
  expect((await log.all()).filter((e) => e.kind === "read").length).toBe(1)
})

test("a retracted claim reads back as retracted, not as denied", async () => {
  const claim = await store.propose(proposal("a withdrawn sentence"))
  await store.review(claim.id, "approve")
  await store.retract(claim.id, "the citation does not support it", "alice")
  const out = await tools.kbRead([claim.id])
  expect(out).toEqual([
    { kind: "retracted", id: claim.id, reason: "the citation does not support it" },
  ])
})

test("a pending claim is still denied, not tombstoned", async () => {
  // The vacuity guard for the test above: a rule that tombstoned everything
  // non-approved would pass it while destroying the approval gate.
  const claim = await store.propose(proposal("still pending"))
  expect(await tools.kbRead([claim.id])).toEqual([])
})

test("a retracted claim is gone from search and from the map", async () => {
  const claim = await store.propose(proposal("a withdrawn sentence about widgets"))
  await store.review(claim.id, "approve")
  await store.retract(claim.id, "wrong", "alice")
  const { hits } = await tools.kbSearch("widgets")
  expect(hits.some((h) => h.id === claim.id)).toBe(false)
  const { entries: map } = await tools.kbMap({ session: "session-1" })
  expect(map.some((e) => e.id === claim.id)).toBe(false)
})

// --- generated documents and team_knowledge_write_document ----------------

test("a search hit on a generated document reports generated and its repo", async () => {
  await store.importDocument({
    title: "Overview",
    text: "Checkout service architecture Zylophant",
    source: "generated:checkout/architecture",
    generated: true,
    repo: "checkout",
  })
  const hit = (await tools.kbSearch("Zylophant")).hits.find((h) => h.kind === "document")
  expect(hit && "generated" in hit && hit.generated).toBe(true)
  expect(hit && "repo" in hit && hit.repo).toBe("checkout")
})

test("a search hit on an imported document reports generated: false, repo: null", async () => {
  await store.importDocument({ title: "Notes", text: "Swampbuzzard notes", source: "notes.md" })
  const hit = (await tools.kbSearch("Swampbuzzard")).hits.find((h) => h.kind === "document")
  expect(hit && "generated" in hit && hit.generated).toBe(false)
  expect(hit && "repo" in hit && hit.repo).toBe(null)
})

test("a document read on a generated document reports generated and its repo", async () => {
  const { document } = await store.importDocument({
    title: "Overview",
    text: "text",
    source: "generated:app/architecture",
    generated: true,
    repo: "app",
  })
  const [read] = await tools.kbRead([document.id])
  expect(read && "generated" in read && read.generated).toBe(true)
  expect(read && "repo" in read && read.repo).toBe("app")
})

test("a document read on an imported document reports generated: false, repo: null", async () => {
  const { document } = await store.importDocument({ title: "d", text: "t", source: "d.md" })
  const [read] = await tools.kbRead([document.id])
  expect(read && "generated" in read && read.generated).toBe(false)
  expect(read && "repo" in read && read.repo).toBe(null)
})

test("kbWriteDocument creates a generated document tagged with its repo", async () => {
  const out = await tools.kbWriteDocument({
    repo: "app",
    slug: "architecture",
    title: "App architecture",
    text: "How the app is put together.",
    agent: "cursor",
  })
  expect(out.outcome).toBe("created")
  const doc = await store.getDocument(out.id)
  expect(doc?.source).toBe("generated:app/architecture")
  expect(doc?.generated).toBe(true)
  expect(doc?.repo).toBe("app")
})

test("writing the same repo and slug again replaces the document in place", async () => {
  const first = await tools.kbWriteDocument({
    repo: "app",
    slug: "architecture",
    title: "App architecture",
    text: "First draft.",
    agent: "cursor",
  })
  const second = await tools.kbWriteDocument({
    repo: "app",
    slug: "architecture",
    title: "App architecture",
    text: "Second draft.",
    agent: "cursor",
  })
  expect(second.outcome).toBe("updated")
  expect(second.id).toBe(first.id)
  const doc = await store.getDocument(second.id)
  expect(doc?.text).toBe("Second draft.")
})

test("kbWriteDocument refuses a slug that climbs out of its directory, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "app", slug: "../x", title: "t", text: "t", agent: "cursor" }),
  ).rejects.toThrow(/slug/)
})

test("kbWriteDocument refuses a slug that is not lowercase kebab-case, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "app", slug: "Arch", title: "t", text: "t", agent: "cursor" }),
  ).rejects.toThrow(/slug/)
})

test("kbWriteDocument refuses a repo containing a path separator, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "a/b", slug: "x", title: "t", text: "t", agent: "cursor" }),
  ).rejects.toThrow(/repo/)
})

// `repo` is a label an agent was given, not a path segment it invents, and is
// compared by string equality rather than joined onto a filesystem path (see
// `taggedFields` in src/store.ts) — so it is allowed the shape of an actual
// repository name, wider than `slug`'s.
test("kbWriteDocument accepts a repo with dots, underscores and mixed case", async () => {
  const out = await tools.kbWriteDocument({
    repo: "My.Repo_1",
    slug: "x",
    title: "t",
    text: "t",
    agent: "cursor",
  })
  expect(out.outcome).toBe("created")
  const doc = await store.getDocument(out.id)
  expect(doc?.repo).toBe("My.Repo_1")
})

test("kbWriteDocument refuses a slug over 64 characters, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "app", slug: "a".repeat(65), title: "t", text: "t", agent: "cursor" }),
  ).rejects.toThrow(/slug/)
})

test("kbWriteDocument refuses a repo over 100 characters, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "a".repeat(101), slug: "x", title: "t", text: "t", agent: "cursor" }),
  ).rejects.toThrow(/repo/)
})

test("kbWriteDocument refuses an empty title, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "app", slug: "x", title: "  ", text: "t", agent: "cursor" }),
  ).rejects.toThrow(/title/)
})

test("kbWriteDocument refuses empty text, naming the field", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "app", slug: "x", title: "t", text: "   ", agent: "cursor" }),
  ).rejects.toThrow(/text/)
})

test("kbWriteDocument writes nothing on a validation refusal", async () => {
  await expect(
    tools.kbWriteDocument({ repo: "app", slug: "Arch", title: "t", text: "t", agent: "cursor" }),
  ).rejects.toThrow()
  expect(await store.listDocuments()).toEqual([])
})

test("team_knowledge_write_document is refused in team mode, and writes nothing", async () => {
  const server = createMcpServer(store, log, { mode: "team" })
  const client = await (async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: "test-client", version: "0.0.0" })
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)])
    return c
  })()

  const result = await client.callTool({
    name: "team_knowledge_write_document",
    arguments: { repo: "app", slug: "architecture", title: "t", text: "t", agent: "cursor" },
  })
  expect(result.isError).toBe(true)
  expect((result.content as { text: string }[])[0]!.text).toBe(TEAM_WRITE_REFUSAL)
  expect(await store.listDocuments()).toEqual([])
  await client.close()
})

test("team_knowledge_write_document works when mode defaults to local", async () => {
  const server = createMcpServer(store, log)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const result = await client.callTool({
    name: "team_knowledge_write_document",
    arguments: { repo: "app", slug: "architecture", title: "t", text: "t", agent: "cursor" },
  })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as { outcome: string }
  expect(parsed.outcome).toBe("created")
  await client.close()
})

test("onSearchResult is called with the hit count, from the server handler only", async () => {
  await store.importDocument({ title: "d", text: "Quetzalcoatl", source: "d.md" })
  const seen: number[] = []
  const server = createMcpServer(store, log, { onSearchResult: async (n) => { seen.push(n) } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  await client.callTool({ name: "team_knowledge_search", arguments: { query: "Quetzalcoatl" } })
  expect(seen).toEqual([1])
  await client.close()
})

test("team_knowledge_search still returns hits when onSearchResult rejects", async () => {
  await store.importDocument({ title: "d", text: "Quetzalcoatl", source: "d.md" })
  const server = createMcpServer(store, log, {
    onSearchResult: async () => {
      throw new Error("hook failed")
    },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const result = await client.callTool({ name: "team_knowledge_search", arguments: { query: "Quetzalcoatl" } })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as { hits: unknown[] }
  expect(parsed.hits.length).toBe(1)
  await client.close()
})

test("team_knowledge_search still returns hits when onSearchResult throws synchronously", async () => {
  await store.importDocument({ title: "d", text: "Quetzalcoatl", source: "d.md" })
  const throwsSync = (() => {
    throw new Error("sync fail")
  }) as unknown as (hits: number) => Promise<void>
  const server = createMcpServer(store, log, { onSearchResult: throwsSync })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const result = await client.callTool({ name: "team_knowledge_search", arguments: { query: "Quetzalcoatl" } })
  expect(result.isError).toBeFalsy()
  const parsed = JSON.parse((result.content as { text: string }[])[0]!.text) as { hits: unknown[] }
  expect(parsed.hits.length).toBe(1)
  await client.close()
})

test("createTools(...).kbSearch alone never calls onSearchResult — only the server handler can", async () => {
  // `init`'s own demonstration search (src/first-answer.ts) calls kbSearch
  // this way, bypassing the server entirely, which is the whole reason it can
  // never count toward the first-answer metric.
  await store.importDocument({ title: "d", text: "Quetzalcoatl", source: "d.md" })
  const seen: number[] = []
  const t = createTools(store, log)
  const result = await t.kbSearch("Quetzalcoatl")
  expect(result.hits.length).toBe(1)
  expect(seen).toEqual([])
})
