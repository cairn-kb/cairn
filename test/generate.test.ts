import { expect, test } from "bun:test"
import { plausibleAbstract } from "../src/abstract"
import { ABSTRACT_GUIDANCE } from "../src/mcp"
import { buildPrompt, generateAbstract, resolveGeneration } from "../src/generate"
import type { Claim } from "@cairn-kb/protocol/types"

const claim: Claim = {
  id: "a",
  status: "approved",
  claim: "Billing uses Postgres, not Mongo",
  body: "ACID guarantees on invoice writes.",
  source: { author: "r", agent: "import", repo: null, session: null },
  created: "2026-08-27T09:00:00.000Z",
  reviewed: null,
  reviewer: null,
  retracted: null,
  overlaps: [],
  cites: [],
  abstract: null,
  abstractBy: null,
  tags: [],
}

test("the prompt carries the one shared definition of an abstract", () => {
  // Not a second prompt: generated and agent-written abstracts must follow the
  // same definition or they drift apart.
  expect(buildPrompt(claim)).toContain(ABSTRACT_GUIDANCE)
})

test("the prompt includes the claim and its body", () => {
  const p = buildPrompt(claim)
  expect(p).toContain("Billing uses Postgres")
  expect(p).toContain("ACID guarantees")
})

const stored = {
  provider: "compatible" as const, model: "ornith:9b",
  baseUrl: null, apiKey: "stored-key", maxTokens: null }

test("an exported key beats a stored one", () => {
  // A stored key must never shadow one deliberately exported.
  const r = resolveGeneration(stored, { CAIRN_MODEL_KEY: "env-key" })
  expect(r!.apiKey).toBe("env-key")
})

test("the stored key is used when the environment has none", () => {
  expect(resolveGeneration(stored, {})!.apiKey).toBe("stored-key")
})

test("CAIRN_MODEL still overrides the stored model", () => {
  // People have this in muscle memory; breaking it would be gratuitous.
  expect(resolveGeneration(stored, { CAIRN_MODEL: "phi4" })!.model).toBe("phi4")
})

test("CAIRN_MODEL_URL still overrides the stored endpoint", () => {
  expect(resolveGeneration(stored, { CAIRN_MODEL_URL: "http://host/v1" })!.baseUrl)
    .toBe("http://host/v1")
})

test("nothing configured resolves to null rather than a guess", () => {
  expect(resolveGeneration(null, {})).toBeNull()
})

test("a stored provider that no longer exists resolves to null", () => {
  expect(resolveGeneration({ ...stored, provider: "hal9000" as never }, {})).toBeNull()
})

// --- the environment is more than CAIRN_MODEL_KEY ---------------------------
//
// "Flag → environment → stored" was implemented as if the environment held one
// variable. A provider's own key variable — the one its SDK documents and the
// one people actually export — lost to a key cairn had written months earlier,
// so rotating a key by exporting the new one kept sending the revoked one.

const anthropicStored = {
  provider: "anthropic" as const, model: "claude-haiku-4-5",
  baseUrl: null, apiKey: "stored-key", maxTokens: null }

test("an exported ANTHROPIC_API_KEY beats a stored key", () => {
  expect(resolveGeneration(anthropicStored, { ANTHROPIC_API_KEY: "env-key" })!.apiKey)
    .toBe("env-key")
})

test("an exported OPENAI_API_KEY beats a stored key", () => {
  const openaiStored = { ...anthropicStored, provider: "openai" as const, model: "gpt-5" }
  expect(resolveGeneration(openaiStored, { OPENAI_API_KEY: "env-key" })!.apiKey).toBe("env-key")
})

test("CAIRN_MODEL_KEY still beats the provider's own variable", () => {
  const r = resolveGeneration(anthropicStored, {
    CAIRN_MODEL_KEY: "shared-key", ANTHROPIC_API_KEY: "provider-key",
  })
  expect(r!.apiKey).toBe("shared-key")
})

test("a provider's variable is not read for a different provider", () => {
  // OPENAI_API_KEY must not become an Anthropic key just by being exported.
  expect(resolveGeneration(anthropicStored, { OPENAI_API_KEY: "env-key" })!.apiKey)
    .toBe("stored-key")
})

test("a key exported as OPENAI_API_KEY reaches the outgoing Authorization header", async () => {
  // The end of the chain, not just the resolver: with the key exported the
  // picker never asks for one, so nothing else would have caught the client
  // overriding it with the Ollama placeholder.
  const seen: { init?: RequestInit } = {}
  const impl = (async (_url: string | URL | Request, init: RequestInit) => {
    seen.init = init
    return new Response(JSON.stringify({
      id: "c", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Settles X. Not Y." }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch

  const resolved = resolveGeneration(
    { provider: "openai", model: "gpt-5", baseUrl: null, apiKey: null, maxTokens: null },
    { OPENAI_API_KEY: "sk-exported" },
  )!
  await generateAbstract(claim, { ...resolved, fetchImpl: impl })
  const headers = new Headers(seen.init!.headers as Record<string, string>)
  expect(headers.get("Authorization")).toBe("Bearer sk-exported")
})

test("a stored maxTokens reaches the backfill, and the environment overrides it", () => {
  // The cap was already on ProviderConfig and honoured by both providers, but
  // resolveGeneration dropped it — so `cairn model --max-tokens` would write a
  // value that the command needing it silently ignored.
  const stored = {
    provider: "compatible" as const,
    model: "m",
    baseUrl: null,
    apiKey: null,
    maxTokens: 4096,
  }
  expect(resolveGeneration(stored, {})?.maxTokens).toBe(4096)
  expect(resolveGeneration(stored, { CAIRN_MODEL_MAX_TOKENS: "8192" })?.maxTokens).toBe(8192)
  // Same environment-over-stored order as the model and the endpoint.
  expect(resolveGeneration({ ...stored, maxTokens: null }, {})?.maxTokens).toBeUndefined()
  // A typo falls back rather than reaching the API as NaN.
  for (const junk of ["abc", "0", "-1", "1.5", ""]) {
    expect(resolveGeneration(stored, { CAIRN_MODEL_MAX_TOKENS: junk })?.maxTokens).toBe(4096)
  }
})

// --- plausibility: the same bar `cairn model --verify` applies --------------

test("a normal two-sentence abstract is accepted", () => {
  expect(plausibleAbstract("Settles billing storage. Does not settle reporting.")).toBe(
    "Settles billing storage. Does not settle reporting.")
})

test("accepted output is trimmed once, at the validation boundary", () => {
  expect(plausibleAbstract("\n  Settles billing storage. Does not settle reporting.  \n"))
    .toBe("Settles billing storage. Does not settle reporting.")
})

test("a whitespace-only reply is rejected as empty", () => {
  expect(() => plausibleAbstract("  \n\t ")).toThrow("empty")
})

test("a bare classifier label is rejected, the shape the verification reported", () => {
  expect(() => plausibleAbstract("User Safety: safe")).toThrow("label and value")
})

test("a label and value with no sentence ending is rejected", () => {
  expect(() => plausibleAbstract("Category: content moderation verdict")).toThrow("label and value")
})

test("a colon inside a real sentence is not mistaken for a label", () => {
  expect(plausibleAbstract("Covers billing storage: invoices stay in Postgres.")).toBe(
    "Covers billing storage: invoices stay in Postgres.")
})

test("a reply over the guidance's 40-word limit is rejected with the count", () => {
  const long = Array.from({ length: 45 }, (_, i) => `w${i}`).join(" ") + "."
  expect(() => plausibleAbstract(long)).toThrow("45 words")
})

test("exactly 40 words is accepted", () => {
  const exact = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") + "."
  expect(plausibleAbstract(exact)).toBe(exact)
})

test("41 words is rejected with the over-limit reason", () => {
  const over = Array.from({ length: 41 }, (_, i) => `w${i}`).join(" ") + "."
  expect(() => plausibleAbstract(over)).toThrow("41 words")
})

test("a terse three-word sentence is accepted", () => {
  expect(plausibleAbstract("Caches DNS lookups.")).toBe("Caches DNS lookups.")
})

test("a single-word label is rejected, naming the bare label", () => {
  expect(() => plausibleAbstract("SAFE")).toThrow("bare label")
  expect(() => plausibleAbstract("safe")).toThrow("bare label")
})

test("a single-word label is still a bare label with trailing punctuation", () => {
  // Punctuation alone does not make a single token a sentence — "Safe." is
  // still one word, not prose, regardless of the period.
  expect(() => plausibleAbstract("Safe.")).toThrow("bare label")
  expect(() => plausibleAbstract("SAFE.")).toThrow("bare label")
  expect(() => plausibleAbstract("unsafe!")).toThrow("bare label")
  expect(() => plausibleAbstract("  Safe.  ")).toThrow("bare label")
})

test("a generation that fails the bar throws, so backfill records it instead of writing it", async () => {
  const bad = (async () => new Response(JSON.stringify({
    id: "c", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "User Safety: safe" }, finish_reason: "stop" }],
  }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch
  const resolved = resolveGeneration(
    { provider: "compatible", model: "m", baseUrl: "http://x/v1", apiKey: null, maxTokens: null },
    {},
  )!
  await expect(generateAbstract(claim, { ...resolved, fetchImpl: bad })).rejects.toThrow("label and value")
})

test("a provider truncation stays its own error, not the plausibility one", async () => {
  const truncated = (async () => new Response(JSON.stringify({
    id: "c", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "Settles" }, finish_reason: "length" }],
  }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch
  const resolved = resolveGeneration(
    { provider: "compatible", model: "m", baseUrl: "http://x/v1", apiKey: null, maxTokens: null },
    {},
  )!
  const err = await generateAbstract(claim, { ...resolved, fetchImpl: truncated }).then(() => null, (e: unknown) => e as Error)
  expect(err?.message).toContain("cut off")
  expect(err?.message).not.toContain("bare label")
})
