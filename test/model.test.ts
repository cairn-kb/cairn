import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import { runModelCommand, SAMPLE_CLAIM, smallestUnabstracted, verificationSubject } from "../src/model"
import type { ModelInfo } from "../src/providers"
import { FileStore } from "../src/store"
import type { Claim } from "@cairn-kb/protocol/types"

let root: string, store: FileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-model-"))
  store = new FileStore(root, new EventLog(root))
  await store.init()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function approved(id: string, body: string, abstract: string | null) {
  const c: Claim = {
    id, status: "approved", claim: `Claim ${id}`, body,
    source: { author: "r", agent: "import", repo: null, session: null },
    created: "2026-08-27T09:00:00.000Z",
    reviewed: null, reviewer: null, retracted: null, overlaps: [], cites: [], abstract, abstractBy: null, tags: [],
  }
  await store.put(c, "curate")
  return c
}

// One fixed body has to answer both a list-models request and a chat-
// completion request, so it carries both shapes: `data` for models.list(),
// `choices` for chat.completions.create(). A body with only `choices` parses
// to an empty `data: []` under the real openai SDK — a list-models mock that
// cannot list any models is not a realistic fixture.
const reply = (text: string) =>
  (async () =>
    new Response(JSON.stringify({
      id: "c", object: "chat.completion",
      data: [{ id: "ornith:9b", object: "model" }],
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch

const deps = (over: Partial<Parameters<typeof runModelCommand>[0]> = {}) => ({
  store,
  env: {} as Record<string, string | undefined>,
  resolveProvider: async () => "compatible" as const,
  resolveModel: async () => "ornith:9b",
  resolveKey: async () => null,
  confirmKeep: async () => true,
  out: () => {},
  fetchImpl: reply("Settles X. Does not settle Y."),
  ...over,
})

test("verification uses the smallest claim missing an abstract", async () => {
  // A cold run against a 15k-token import took 149 seconds. A verification
  // step that feels hung is one people skip.
  await approved("big", "x".repeat(50_000), null)
  await approved("small", "short body", null)
  await approved("done", "y".repeat(10), "Already has one. Not everything.")
  expect((await smallestUnabstracted(store))?.id).toBe("small")
})

test("an empty store falls back to the built-in sample", async () => {
  expect(await smallestUnabstracted(store)).toBeNull()
  expect(SAMPLE_CLAIM.body.length).toBeGreaterThan(0)
})

test("a space that cannot be read still lets a model be verified, and says so", async () => {
  // `cairn model` proves out a PROVIDER. Failing it because the knowledge
  // service is down would block choosing a model over something unrelated —
  // but substituting the built-in sample silently would let an operator
  // believe they verified against their own claim.
  const said: string[] = []
  const unreachable = {
    ...store,
    list: async () => {
      throw new Error("cairn is not reachable at https://cairn.example")
    },
  } as unknown as FileStore
  const subject = await verificationSubject(unreachable, (l) => said.push(l))
  expect(subject).toBe(SAMPLE_CLAIM)
  expect(said.join("\n")).toContain("cairn.example")
  expect(said.join("\n")).toContain("built-in")
})

test("a claim that already has an abstract is never picked", async () => {
  await approved("done", "tiny", "Settles a thing. Not another.")
  expect(await smallestUnabstracted(store)).toBeNull()
})

test("accepting the verification saves the choice", async () => {
  await approved("small", "short body", null)
  const r = await runModelCommand(deps())
  expect(r.outcome).toBe("saved")
  expect(r.generation).toEqual({
    provider: "compatible", model: "ornith:9b", baseUrl: null, apiKey: null, maxTokens: null })
})

test("rejecting the verification saves nothing", async () => {
  await approved("small", "short body", null)
  const r = await runModelCommand(deps({ confirmKeep: async () => false }))
  expect(r.outcome).toBe("rejected")
  expect(r.generation).toBeUndefined()
})

test("cancelling at any prompt saves nothing", async () => {
  for (const cancelled of [
    { resolveProvider: async () => null },
    { resolveModel: async () => null },
    { confirmKeep: async () => null },
  ]) {
    const r = await runModelCommand(deps(cancelled as never))
    expect(r.outcome).toBe("cancelled")
    expect(r.generation).toBeUndefined()
  }
})

test("verification writes nothing to the store or the event log", async () => {
  // "Prove it works" must not become "quietly generate an abstract nobody
  // reviewed" — cairn abstracts is what fills claims in.
  const before = await approved("small", "short body", null)
  const log = new EventLog(root)
  // A delta, not an absolute: seeding the claim is itself a content write and
  // records one. What this test is about is whether VERIFICATION writes, and
  // an absolute emptiness check answered a different question that happened to
  // agree while `put` recorded nothing.
  const seeded = (await log.all()).length
  await runModelCommand(deps())
  expect((await store.get("small"))?.abstract).toBe(before.abstract)
  expect(await log.all()).toHaveLength(seeded)
})

test("a provider serving no models says so rather than opening an empty picker", async () => {
  // This gate was deleted once and had to be restored, because nothing in the
  // suite named it. resolveModel cannot distinguish "nothing to choose from"
  // from "still loading", so the command has to answer that itself.
  await approved("small", "short body", null)
  const emptyList = (async () =>
    new Response(JSON.stringify({ object: "list", data: [] }), {
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch
  const lines: string[] = []
  let asked = false
  const r = await runModelCommand(deps({
    fetchImpl: emptyList,
    resolveModel: async () => { asked = true; return "ornith:9b" },
    out: (l: string) => lines.push(l),
  }))
  expect(r.outcome).toBe("rejected")
  expect(asked).toBe(false)
  expect(lines.join("\n")).toContain("is serving no models")
  expect(lines.join("\n")).toContain("Ollama")
})

test("a failed generation is reported against the model that failed", async () => {
  // The list call succeeds and only the generation fails, so this reaches the
  // branch a fetch that throws on its first call never gets to.
  await approved("small", "short body", null)
  const listThenFail = (async (url: string | URL | Request) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ object: "list", data: [{ id: "ornith:9b" }] }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    throw new Error("model runner exited")
  }) as unknown as typeof fetch
  const lines: string[] = []
  const r = await runModelCommand(deps({ fetchImpl: listThenFail, out: (l: string) => lines.push(l) }))
  expect(r.outcome).toBe("rejected")
  expect(lines.join("\n")).toContain("ornith:9b")
  expect(lines.join("\n")).toContain("model runner exited")
})

test("--base-url takes the flag position ahead of CAIRN_MODEL_URL", async () => {
  // The interactive path read CAIRN_MODEL_URL only, so `--base-url` alone was
  // accepted and silently dropped. Both calls and the saved config have to
  // land on the flag's endpoint, the same property the CAIRN_MODEL_URL test
  // below pins.
  await approved("small", "short body", null)
  const urls: string[] = []
  const recordingFetch = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(JSON.stringify({
      id: "c", object: "chat.completion",
      data: [{ id: "ornith:9b", object: "model" }],
      choices: [{ index: 0, message: { role: "assistant", content: "Settles X. Does not settle Y." }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch

  const r = await runModelCommand(deps({
    baseUrl: "http://flag.example/v1",
    env: { CAIRN_MODEL_URL: "http://env.example/v1" },
    fetchImpl: recordingFetch,
  }))

  expect(urls.some((u) => u.startsWith("http://flag.example/v1/models"))).toBe(true)
  expect(urls.some((u) => u.startsWith("http://flag.example/v1/chat/completions"))).toBe(true)
  expect(urls.some((u) => u.includes("env.example"))).toBe(false)
  expect(r.generation?.baseUrl).toBe("http://flag.example/v1")
})

test("a key exported as the provider's own variable is used and not stored", async () => {
  // The picker never asks when the provider's variable is set, so the key it
  // uses has to come from there — and it stays there rather than being copied
  // into config.json.
  await approved("small", "short body", null)
  const urls: string[] = []
  const auths: (string | null)[] = []
  const recordingFetch = (async (input: unknown, init: RequestInit) => {
    urls.push(String(input))
    auths.push(new Headers(init.headers as Record<string, string>).get("Authorization"))
    return new Response(JSON.stringify({
      id: "c", object: "chat.completion",
      data: [{ id: "gpt-5", object: "model" }],
      choices: [{ index: 0, message: { role: "assistant", content: "Settles X. Does not settle Y." }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch

  const r = await runModelCommand(deps({
    resolveProvider: async () => "openai" as const,
    resolveModel: async () => "gpt-5",
    env: { OPENAI_API_KEY: "sk-exported" },
    fetchImpl: recordingFetch,
  }))

  expect(r.outcome).toBe("saved")
  expect(auths).toContain("Bearer sk-exported")
  expect(auths).not.toContain("Bearer unused")
  expect(r.generation?.apiKey).toBeNull()
})

test("a failed verification is reported and saves nothing", async () => {
  await approved("small", "short body", null)
  const failing = (async () => {
    throw new Error("connection refused")
  }) as unknown as typeof fetch
  const lines: string[] = []
  const r = await runModelCommand(deps({ fetchImpl: failing, out: (l: string) => lines.push(l) }))
  expect(r.outcome).toBe("rejected")
  expect(lines.join("\n")).toContain("connection refused")
})

test("a key entered at the prompt is stored; one from the environment is not", async () => {
  await approved("small", "short body", null)
  const entered = await runModelCommand(deps({ resolveKey: async () => "sk-typed" }))
  expect(entered.generation?.apiKey).toBe("sk-typed")

  const fromEnv = await runModelCommand(deps({ env: { CAIRN_MODEL_KEY: "sk-env" } }))
  expect(fromEnv.generation?.apiKey).toBeNull()
})

test("resolveModel is handed the models the provider actually listed, and the saved choice comes from them", async () => {
  // resolveModel is hardcoded to "ornith:9b" everywhere else in this file, which
  // would pass even if listing were wired to nothing. Here it picks whatever it
  // is given, so the assertion only holds if provider.list()'s result really
  // reaches the resolver.
  await approved("small", "short body", null)
  let seen: ModelInfo[] = []
  const r = await runModelCommand(deps({
    resolveModel: async (models) => {
      seen = models
      return models[0]?.id ?? null
    },
  }))
  expect(seen).toEqual([{ id: "ornith:9b", label: "ornith:9b" }])
  expect(r.outcome).toBe("saved")
  expect(r.generation?.model).toBe("ornith:9b")
})

test("a custom CAIRN_MODEL_URL is what gets verified against, not the provider default", async () => {
  // The bug this pins: baseUrl was threaded into the saved config but not into
  // the calls that verify it, so the command could save a custom endpoint
  // while silently proving out the provider's default instead. Checking only
  // the saved config, or only one of the two calls, would have passed against
  // that broken code — both calls and the saved value all have to agree.
  await approved("small", "short body", null)
  const urls: string[] = []
  const recordingFetch = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(JSON.stringify({
      id: "c", object: "chat.completion",
      data: [{ id: "ornith:9b", object: "model" }],
      choices: [{ index: 0, message: { role: "assistant", content: "Settles X. Does not settle Y." }, finish_reason: "stop" }],
    }), { headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch

  const r = await runModelCommand(deps({
    env: { CAIRN_MODEL_URL: "https://custom.example/v1" },
    fetchImpl: recordingFetch,
  }))

  expect(urls.some((u) => u.startsWith("https://custom.example/v1/models"))).toBe(true)
  expect(urls.some((u) => u.startsWith("https://custom.example/v1/chat/completions"))).toBe(true)
  expect(r.generation?.baseUrl).toBe("https://custom.example/v1")
})

// A reply that is only non-empty proves the endpoint answered. These pin that
// the verification refuses replies that are not an abstract, and that a refused
// reply saves nothing and says why.
const modelReply = (text: string) => reply(text)

for (const [name, text, reason] of [
  ["whitespace only", "   \n\t  ", "empty"],
  ["a bare safety label", "User Safety: safe", "label and value"],
  ["a single-word verdict", "SAFE", "bare label"],
  ["a single-word verdict with a trailing period", "Safe.", "bare label"],
  ["a label with no sentence", "Content classification verdict: unsafe content detected", "label and value"],
  ["far over the 40-word limit", Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + ".", "80 words"],
] as const) {
  test(`verification rejects ${name} and names why`, async () => {
    await approved("small", "short body", null)
    const seeded = (await new EventLog(root).all()).length
    const lines: string[] = []
    const r = await runModelCommand(deps({ fetchImpl: modelReply(text), out: (l: string) => lines.push(l) }))
    expect(r.outcome).toBe("rejected")
    expect(r.generation).toBeUndefined()
    expect(lines.join("\n")).toContain(reason)
    expect((await store.get("small"))?.abstract).toBeNull()
    expect(await new EventLog(root).all()).toHaveLength(seeded)
  })
}

test("verification accepts a two-sentence reply and trims it before showing it", async () => {
  await approved("small", "short body", null)
  const shown: string[] = []
  const r = await runModelCommand(deps({
    fetchImpl: modelReply("  Settles X. Does not settle Y.  \n"),
    confirmKeep: async (abstract) => { shown.push(abstract); return true },
  }))
  expect(r.outcome).toBe("saved")
  expect(shown).toEqual(["Settles X. Does not settle Y."])
})
