import { expect, test } from "bun:test"
import { listOrgs, useOrg } from "../src/orgs"
import type { AuthConfig } from "../src/config"

const ORGS = [
  { id: "o1", slug: "mine", name: "My space", role: "owner" },
  { id: "o2", slug: "acme", name: "Acme", role: "member" },
]

const fetchImpl = (async (input: string, init?: { headers?: Record<string, string> }) => {
  expect(String(input)).toBe("https://api.test/v1/me")
  expect(init!.headers!.authorization).toBe("Bearer tok")
  return new Response(JSON.stringify({ user: { id: "u1" }, orgs: ORGS }), {
    headers: { "content-type": "application/json" },
  })
}) as unknown as typeof fetch

const auth: AuthConfig = {
  token: "new",
  orgId: "o2",
  orgSlug: "acme",
  apiUrl: "https://api.test",
  user: "bob",
}

test("listing the spaces you are in reads /v1/me with the token", async () => {
  const orgs = await listOrgs({ apiUrl: "https://api.test", token: "tok", fetchImpl })
  expect(orgs.map((o) => o.slug)).toEqual(["mine", "acme"])
})

test("a failed read is an error, not an empty list", async () => {
  const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
  await expect(
    listOrgs({ apiUrl: "https://api.test", token: "tok", fetchImpl: failing }),
  ).rejects.toThrow()
})

// A token is scoped to exactly one org, so switching spaces cannot be a
// config rewrite — it has to mint a new token, which is a browser act.
test("switching spaces signs in again against the chosen slug", async () => {
  let askedFor = ""
  const result = await useOrg({
    apiUrl: "https://api.test",
    token: "tok",
    fetchImpl,
    slug: "acme",
    login: async (org) => {
      askedFor = org
      return auth
    },
  })
  expect(askedFor).toBe("acme")
  expect(result.orgSlug).toBe("acme")
})

test("a slug you are not in names the ones you are, and signs in to nothing", async () => {
  let called = false
  await expect(
    useOrg({
      apiUrl: "https://api.test",
      token: "tok",
      fetchImpl,
      slug: "somewhere-else",
      login: async () => {
        called = true
        return auth
      },
    }),
  ).rejects.toThrow(/mine, acme/)
  expect(called).toBe(false)
})
