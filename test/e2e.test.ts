import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import { createTools } from "../src/mcp"
import { FileStore } from "../src/store"
import type { Claim } from "@cairn-kb/protocol/types"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-e2e-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("propose, approve, and the knowledge becomes visible to agents", async () => {
  const log = new EventLog(root)
  const store = new FileStore(root, log)
  await store.init()
  const tools = createTools(store, log)

  // An agent proposes mid-session.
  const { id } = await tools.kbPropose({
    claim: "Billing uses Postgres, not Mongo",
    body: "ACID guarantees on invoice writes.",
    abstract: "Settles the billing datastore. Says nothing about caching.",
    author: "alice",
    agent: "cursor",
    tags: ["billing"],
  })

  // Before review, agents cannot see it.
  expect((await tools.kbMap()).entries).toEqual([])

  // The human approves, through the same seam `cairn review` drives.
  expect((await store.review(id, "approve"))?.status).toBe("approved")

  // Now it is on the map, with its coverage-aware abstract.
  const { entries: map } = await tools.kbMap()
  expect(map.length).toBe(1)
  expect(map[0]!.abstract).toContain("Says nothing about caching")

  // And readable in full. id is a claim id, never a document id, so this
  // cast just names what kbRead's union already guarantees here.
  const read = (await tools.kbRead([id]))[0] as Claim
  expect(read.body).toContain("ACID")
})

test("rejected knowledge never reaches agents", async () => {
  const log = new EventLog(root)
  const store = new FileStore(root, log)
  await store.init()
  const tools = createTools(store, log)

  const { id } = await tools.kbPropose({
    claim: "We should rewrite everything in Rust",
    body: "",
    abstract: "Settles one thing. Does not settle others.",
    author: "r",
    agent: "cursor",
  })
  await store.review(id, "reject")

  expect((await tools.kbMap()).entries).toEqual([])
  // kbSearch already filters to approved claims, so a rejected one produces
  // no claim hit at all — checked by kind, since a search hit is no longer a
  // bare Claim.
  expect((await tools.kbSearch("Rust")).hits.some((h) => h.kind === "claim")).toBe(false)
  // The approval gate applies to every read path — a rejected claim is as
  // invisible to a direct team_knowledge_read as it is to team_knowledge_map
  // and team_knowledge_search.
  expect(await tools.kbRead([id])).toEqual([])
})
