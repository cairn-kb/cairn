import { expect, test } from "bun:test"
import { compatible, DEFAULT_MAX_TOKENS, OLLAMA_BASE_URL, openai } from "../src/providers/openai-compatible"
import type { Claim } from "@cairn-kb/protocol/types"

const claim: Claim = {
  id: "a", status: "approved",
  claim: "Billing uses Postgres, not Mongo",
  body: "ACID guarantees on invoice writes.",
  source: { author: "r", agent: "import", repo: null, session: null },
  created: "2026-08-27T09:00:00.000Z",
  reviewed: null, reviewer: null, retracted: null, overlaps: [], cites: [], abstract: null, abstractBy: null, tags: [],
}

/** Captures the request the SDK builds, and replies with a canned body. */
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

const completion = (text: string, finish = "stop") => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})

test("ollama is the default endpoint for the compatible provider", async () => {
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", fetchImpl: impl })
  expect(seen.url).toContain(OLLAMA_BASE_URL)
})

test("the endpoint can be pointed anywhere OpenAI-shaped", async () => {
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", baseUrl: "http://lmstudio.local/v1", fetchImpl: impl })
  expect(seen.url).toContain("lmstudio.local")
})

test("temperature IS sent on the OpenAI-shaped path", async () => {
  // The mirror of the Anthropic test: there it is a 400, here it is correct.
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", fetchImpl: impl })
  expect(JSON.parse(String(seen.init!.body)).temperature).toBe(0.2)
})

test("returns the model's text, trimmed", async () => {
  const { impl } = spy(completion("  Settles the datastore. Not caching.  "))
  expect(await compatible.generate(claim, { model: "m", fetchImpl: impl }))
    .toBe("Settles the datastore. Not caching.")
})

test("a reply cut off by the cap is a failure naming the cap", async () => {
  const { impl } = spy(completion("Settles the datastore but then it gets cut o", "length"))
  await expect(compatible.generate(claim, { model: "m", fetchImpl: impl }))
    .rejects.toThrow(/cut off/i)
})

test("an empty reply is a failure, not an empty abstract", async () => {
  const { impl } = spy(completion("   \n "))
  await expect(compatible.generate(claim, { model: "m", fetchImpl: impl }))
    .rejects.toThrow(/empty/i)
})

test("models are listed from the endpoint, not hardcoded", async () => {
  const { impl } = spy({ object: "list", data: [{ id: "ornith:9b" }, { id: "phi4" }] })
  const models = await compatible.list({ model: "", fetchImpl: impl })
  expect(models.map((m) => m.id)).toEqual(["ornith:9b", "phi4"])
})

test("compatible needs no key; openai does", () => {
  expect(compatible.needsKey({})).toBe(false)
  expect(openai.needsKey({})).toBe(true)
  expect(openai.needsKey({ OPENAI_API_KEY: "sk-x" })).toBe(false)
})

test("max_tokens defaults to DEFAULT_MAX_TOKENS when no override is given", async () => {
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", fetchImpl: impl })
  expect(JSON.parse(String(seen.init!.body)).max_tokens).toBe(DEFAULT_MAX_TOKENS)
})

test("an explicit maxTokens override reaches the request body", async () => {
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", maxTokens: 900, fetchImpl: impl })
  expect(JSON.parse(String(seen.init!.body)).max_tokens).toBe(900)
})

test("a configured apiKey reaches the Authorization header", async () => {
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", apiKey: "sk-real-key", fetchImpl: impl })
  const headers = new Headers(seen.init!.headers as Record<string, string>)
  expect(headers.get("Authorization")).toBe("Bearer sk-real-key")
})

test("ollama still gets the non-empty placeholder the SDK insists on", async () => {
  // The `compatible` provider has a fallback endpoint, so the placeholder is
  // correct there: Ollama ignores the value and the SDK refuses an empty one.
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  await compatible.generate(claim, { model: "m", fetchImpl: impl })
  const headers = new Headers(seen.init!.headers as Record<string, string>)
  expect(headers.get("Authorization")).toBe("Bearer unused")
})

test("the openai provider never sends the placeholder as a key", async () => {
  // With no key resolved, real OpenAI must fall through to the SDK's own
  // "the OPENAI_API_KEY environment variable is missing" rather than send
  // `Bearer unused` and turn a missing key into an unexplained 401.
  const { seen, impl } = spy(completion("Settles X. Does not settle Y."))
  try {
    await openai.generate(claim, { model: "m", fetchImpl: impl })
  } catch {
    // The SDK's own missing-key error is one of the two acceptable outcomes.
  }
  const auth = new Headers((seen.init?.headers ?? {}) as Record<string, string>)
    .get("Authorization")
  expect(auth).not.toBe("Bearer unused")
})

test("each provider names the variable its own SDK documents", () => {
  expect(openai.keyEnvVar).toBe("OPENAI_API_KEY")
  // No vendor behind `compatible`, so no conventional variable to read.
  expect(compatible.keyEnvVar).toBeNull()
})
