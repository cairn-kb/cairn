import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import { importFile } from "../src/import-file"
import { FileStore } from "../src/store"

let root: string
let src: string
let store: FileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-if-store-"))
  src = await mkdtemp(join(tmpdir(), "cairn-if-src-"))
  store = new FileStore(root, new EventLog(root))
  await store.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(src, { recursive: true, force: true })
})

test("a frontmatter-only file is empty and stores nothing", async () => {
  const path = join(src, "only.md")
  await writeFile(path, "---\ntags: [x]\n---\n")
  expect(await importFile(store, path, "only.md")).toEqual({ outcome: "empty" })
  expect(await store.listDocuments()).toEqual([])
})

test("a file imported with a repo stores the repo and the source; the same file again is unchanged", async () => {
  const path = join(src, "README.md")
  await writeFile(path, "# App\n\nWhat the app does.\n")
  const first = await importFile(store, path, "app:README.md", "app")
  expect(first.outcome).toBe("created")
  const docs = await store.listDocuments()
  expect(docs).toHaveLength(1)
  expect(docs[0]!.source).toBe("app:README.md")
  expect(docs[0]!.repo).toBe("app")
  expect(docs[0]!.title).toBe("App")
  const again = await importFile(store, path, "app:README.md", "app")
  expect(again.outcome).toBe("unchanged")
  expect(await store.listDocuments()).toHaveLength(1)
})

test("without a repo, nothing is tagged", async () => {
  const path = join(src, "README.md")
  await writeFile(path, "# App\n\nBody.\n")
  await importFile(store, path, "README.md")
  const [doc] = await store.listDocuments()
  expect(doc!.repo).toBeUndefined()
  expect(doc!.source).toBe("README.md")
})
