import { expect, test } from "bun:test"
import { allProviders, providerById } from "../src/providers"

test("every provider is reachable by its id", () => {
  for (const p of allProviders()) {
    expect(providerById(p.id)).toBe(p)
  }
})

test("an unknown id is null, not a throw", () => {
  // The id comes out of config.json, which a human can edit.
  expect(providerById("gpt5-turbo-max" as never)).toBeNull()
})

test("the three providers cairn supports are registered", () => {
  expect(allProviders().map((p) => p.id).sort()).toEqual(["anthropic", "compatible", "openai"])
})

test("every provider has a label a human can pick from", () => {
  for (const p of allProviders()) {
    expect(p.label.length).toBeGreaterThan(0)
    expect(p.label).not.toBe(p.id)
  }
})
