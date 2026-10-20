import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { firstAnswer, suggestQuestion } from "../src/first-answer"
import { EventLog } from "../src/events"
import { FileStore } from "../src/store"

test("suggests the first title that is not a README or the repo label", () => {
  expect(suggestQuestion(["README.md", "Deploying the API", "Testing"], "app")).toEqual({
    query: "Deploying the API",
    question: 'What does "Deploying the API" say about how this project works?',
  })
})

test("falls back to the repo label when every title is a README or the label itself", () => {
  expect(suggestQuestion(["README", "README.md", "app"], "app")).toEqual({
    query: "app",
    question: 'What does "app" say about how this project works?',
  })
})

test("falls back to the repo label when there are no titles", () => {
  expect(suggestQuestion([], "app")).toEqual({
    query: "app",
    question: 'What does "app" say about how this project works?',
  })
})

let root: string
let log: EventLog
let store: FileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-first-answer-"))
  log = new EventLog(root)
  store = new FileStore(root, log)
  await store.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("runs a real search over an imported document without counting it in stats", async () => {
  await store.importDocument({ title: "Deploying the API", text: "how to ship the service", source: "deploy.md" })
  const before = await store.stats()

  const result = await firstAnswer(store, "Deploying the API")

  expect(result.hits.some((h) => h.kind === "document" && h.title === "Deploying the API")).toBe(true)
  const after = await store.stats()
  expect(after).toEqual(before)
  expect(after.searches).toBe(0)
})

test("returns no hits over an empty store", async () => {
  const result = await firstAnswer(store, "anything")
  expect(result.hits).toEqual([])
})
