import { expect, test } from "bun:test"
import { anthropic, ANTHROPIC_MAX_TOKENS } from "../src/providers/anthropic"
import type { Claim } from "@cairn-kb/protocol/types"

const claim: Claim = {
  id: "a", status: "approved",
  claim: "Billing uses Postgres, not Mongo",
  body: "ACID guarantees on invoice writes.",
  source: { author: "r", agent: "import", repo: null, session: null },
  created: "2026-08-27T09:00:00.000Z",
  reviewed: null, reviewer: null, retracted: null, overlaps: [], cites: [], abstract: null, abstractBy: null, tags: [],
}

function spy(body: unknown, status = 200) {
  const seen: { url?: string; init?: RequestInit } = {}
  const impl = (async (url: string | URL | Request, init: RequestInit) => {
    seen.url = String(url)
    seen.init = init
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { seen, impl }
}

const message = (text: string, stop = "end_turn") => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-4-5",
  content: [{ type: "text", text }],
  stop_reason: stop,
  usage: { input_tokens: 10, output_tokens: 5 },
})

test("temperature is NEVER sent to Anthropic", async () => {
  // This is the whole reason the seam exists. `temperature` was removed on
  // every current Claude model and returns a 400 — the previous shared
  // implementation sent it unconditionally.
  const { seen, impl } = spy(message("Settles X. Does not settle Y."))
  await anthropic.generate(claim, { model: "claude-haiku-4-5", apiKey: "sk-x", fetchImpl: impl })
  const body = JSON.parse(String(seen.init!.body))
  expect(body.temperature).toBeUndefined()
  expect(Object.keys(body)).not.toContain("temperature")
})

test("the default cap leaves room for thinking", async () => {
  // Current Claude models think by default and max_tokens bounds thinking plus
  // answer. 512 would routinely return empty content.
  const { seen, impl } = spy(message("Settles X. Does not settle Y."))
  await anthropic.generate(claim, { model: "claude-haiku-4-5", apiKey: "sk-x", fetchImpl: impl })
  expect(JSON.parse(String(seen.init!.body)).max_tokens).toBe(ANTHROPIC_MAX_TOKENS)
  expect(ANTHROPIC_MAX_TOKENS).toBeGreaterThan(512)
})

test("reads the text out of a content array, not choices", async () => {
  const { impl } = spy(message("  Settles the datastore. Not caching.  "))
  expect(await anthropic.generate(claim, { model: "m", apiKey: "sk-x", fetchImpl: impl }))
    .toBe("Settles the datastore. Not caching.")
})

test("stop_reason max_tokens is the truncation signal here", async () => {
  const { impl } = spy(message("Settles the datastore but then it gets cut o", "max_tokens"))
  await expect(anthropic.generate(claim, { model: "m", apiKey: "sk-x", fetchImpl: impl }))
    .rejects.toThrow(/cut off/i)
})

test("a response with no text block is a failure, not an empty abstract", async () => {
  // A thinking-only response has content blocks but no text.
  const { impl } = spy({
    id: "msg_1", type: "message", role: "assistant", model: "m",
    content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 0 },
  })
  await expect(anthropic.generate(claim, { model: "m", apiKey: "sk-x", fetchImpl: impl }))
    .rejects.toThrow(/empty/i)
})

test("models come from the API, with the context window as a hint", async () => {
  const { impl } = spy({
    data: [
      { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", max_input_tokens: 200000 },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 1000000 },
    ],
    has_more: false,
  })
  const models = await anthropic.list({ model: "", apiKey: "sk-x", fetchImpl: impl })
  expect(models[0]!.id).toBe("claude-haiku-4-5")
  expect(models[0]!.label).toBe("Claude Haiku 4.5")
  expect(models[0]!.hint).toContain("200")
})

test("a key is required unless the environment already has one", () => {
  expect(anthropic.needsKey({})).toBe(true)
  expect(anthropic.needsKey({ ANTHROPIC_API_KEY: "sk-x" })).toBe(false)
})
