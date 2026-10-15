import { expect, test } from "bun:test"
import { allProviders } from "../src/providers"
import type { Provider } from "../src/providers"
import type { Claim } from "@cairn-kb/protocol/types"

const claim: Claim = {
  id: "a", status: "approved",
  claim: "Billing uses Postgres, not Mongo",
  body: "ACID guarantees on invoice writes.",
  source: { author: "r", agent: "import", repo: null, session: null },
  created: "2026-08-27T09:00:00.000Z",
  reviewed: null, reviewer: null, retracted: null, overlaps: [], cites: [], abstract: null, abstractBy: null, tags: [],
}

/** The success and truncation bodies each provider's SDK expects. */
const BODIES: Record<string, { ok: unknown; truncated: unknown; empty: unknown; models: unknown }> = {
  anthropic: {
    ok: { id: "m", type: "message", role: "assistant", model: "m",
          content: [{ type: "text", text: "  Settles X. Does not settle Y.  " }],
          stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    truncated: { id: "m", type: "message", role: "assistant", model: "m",
          content: [{ type: "text", text: "Settles X but cut o" }],
          stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } },
    empty: { id: "m", type: "message", role: "assistant", model: "m",
          content: [{ type: "text", text: "   " }],
          stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    models: { data: [{ id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }], has_more: false },
  },
  openaiShaped: {
    ok: { id: "c", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "  Settles X. Does not settle Y.  " }, finish_reason: "stop" }] },
    truncated: { id: "c", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Settles X but cut o" }, finish_reason: "length" }] },
    empty: { id: "c", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "   " }, finish_reason: "stop" }] },
    models: { object: "list", data: [{ id: "ornith:9b" }] },
  },
}

const bodiesFor = (p: Provider) => (p.id === "anthropic" ? BODIES.anthropic! : BODIES.openaiShaped!)

const replyWith = (body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch

const cfgFor = (p: Provider) => ({ model: "m", apiKey: "sk-x", fetchImpl: replyWith(bodiesFor(p).ok) })

for (const provider of allProviders()) {
  test(`${provider.id}: a good reply yields the trimmed abstract`, async () => {
    const out = await provider.generate(claim, cfgFor(provider))
    expect(out).toBe("Settles X. Does not settle Y.")
  })

  test(`${provider.id}: a truncated reply fails naming the cap`, async () => {
    await expect(
      provider.generate(claim, { model: "m", apiKey: "sk-x", fetchImpl: replyWith(bodiesFor(provider).truncated) }),
    ).rejects.toThrow(/cut off/i)
  })

  test(`${provider.id}: a whitespace-only reply fails rather than storing a blank`, async () => {
    await expect(
      provider.generate(claim, { model: "m", apiKey: "sk-x", fetchImpl: replyWith(bodiesFor(provider).empty) }),
    ).rejects.toThrow(/empty/i)
  })

  test(`${provider.id}: models are listed with an id and a label`, async () => {
    const models = await provider.list({
      model: "", apiKey: "sk-x", fetchImpl: replyWith(bodiesFor(provider).models),
    })
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(m.id.length).toBeGreaterThan(0)
      expect(m.label.length).toBeGreaterThan(0)
    }
  })

  test(`${provider.id}: an error never echoes the key`, async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 })) as unknown as typeof fetch
    const secret = "sk-super-secret-value"
    let caught: unknown
    let rejected = false
    try {
      await provider.generate(claim, { model: "m", apiKey: secret, fetchImpl: failing })
    } catch (err) {
      rejected = true
      caught = err
    }
    // Asserted separately from the key check: a provider that swallowed the
    // failure and returned a string would otherwise pass this test trivially,
    // and this is the only place the SDK's error path is exercised at all.
    expect(rejected).toBe(true)
    expect(String((caught as Error).message)).not.toContain(secret)
    expect(JSON.stringify(caught)).not.toContain(secret)
    // The error must carry the status, and both SDKs put it at the
    // front of `.message`. Without it a bad key and an endpoint that is simply
    // down read identically — and the CLI now prints this message alone.
    expect(String((caught as Error).message)).toContain("401")
  })
}
