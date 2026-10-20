import { expect, test } from "bun:test"
import { HttpStore } from "../src/http-store"

/** An HttpStore whose requests land here instead of on a network. */
function recording(answer: unknown = {}) {
  const urls: string[] = []
  const store = new HttpStore({
    baseUrl: "https://example.invalid",
    orgId: "org 1",
    token: "t",
    fetchImpl: (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch,
  })
  return { store, urls }
}

const query = (url: string): Record<string, string> => Object.fromEntries(new URL(url).searchParams)

test("searchPassages sends the raw question, the limit and the semantic flag", async () => {
  const hit = {
    doc: "doc-1", ordinal: 0, offset: 0, length: 4, heading: "T", hash: "h",
    title: "T", source: "a.md", text: "text", generated: false, repo: null,
  }
  const { store, urls } = recording({ hits: [hit], notice: "keyword-only" })
  const r = await store.searchPassages("how do we deploy-with wrangler?")
  expect(urls.length).toBe(1)
  const url = new URL(urls[0]!)
  expect(url.search).toBe("?text=how%20do%20we%20deploy-with%20wrangler%3F&limit=6&semantic=true")
  expect(url.pathname).toBe("/v1/orgs/org%201/passages")
  // The text as asked, not an FTS expression: the service builds the query.
  expect(query(urls[0]!)).toEqual({ text: "how do we deploy-with wrangler?", limit: "6", semantic: "true" })
  expect(r).toEqual({ hits: [hit], notice: "keyword-only" })
})

test("searchPassages passes a caller's limit and keyword-only choice through", async () => {
  const { store, urls } = recording({ hits: [] })
  const r = await store.searchPassages("x", { limit: 2, semantic: false })
  expect(query(urls[0]!)).toEqual({ text: "x", limit: "2", semantic: "false" })
  // No notice key at all when the service sent none.
  expect(r).toEqual({ hits: [] })
})

test("searchPassages answers a blank question without a request", async () => {
  const { store, urls } = recording()
  expect(await store.searchPassages("   ")).toEqual({ hits: [] })
  expect(urls).toEqual([])
})

test("search sends the raw question as text", async () => {
  const { store, urls } = recording({ claims: [] })
  await store.search("deploy-with wrangler")
  expect(new URL(urls[0]!).pathname).toBe("/v1/orgs/org%201/search")
  expect(query(urls[0]!)).toEqual({ text: "deploy-with wrangler" })
})

test("searchDocuments keeps sending a query expression as q", async () => {
  const { store, urls } = recording({ documents: [] })
  await store.searchDocuments("deploy-with wrangler")
  expect(new URL(urls[0]!).pathname).toBe("/v1/orgs/org%201/documents")
  expect(query(urls[0]!)).toEqual({ q: '"deploy-with" OR "wrangler"' })
})
