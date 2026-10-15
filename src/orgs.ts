import type { AuthConfig } from "./config"

/** One membership, as /v1/me reports it. */
export interface OrgSummary {
  id: string
  slug: string
  name: string
  role: string
}

export interface ListOrgsDeps {
  apiUrl: string
  token: string
  fetchImpl?: typeof fetch
}

/**
 * Every space this account is in.
 *
 * Reads /v1/me, which resolves a bearer token to a USER and lists all their
 * memberships — not just the one the token is scoped to. That asymmetry is the
 * whole reason this works with the token already on disk.
 */
export async function listOrgs(deps: ListOrgsDeps): Promise<OrgSummary[]> {
  const doFetch = deps.fetchImpl ?? fetch
  const res = await doFetch(`${deps.apiUrl}/v1/me`, {
    headers: { authorization: `Bearer ${deps.token}` },
  })
  // An empty list is a true answer — a failed read is not, and returning one
  // for the other would tell someone they are in no spaces when the service is
  // merely down.
  if (!res.ok) throw new Error(`could not read your spaces (${res.status})`)
  return ((await res.json()) as { orgs: OrgSummary[] }).orgs
}

export interface UseOrgDeps extends ListOrgsDeps {
  slug: string
  login: (org: string) => Promise<AuthConfig>
}

/**
 * Point this machine at a different space.
 *
 * This cannot be a config rewrite. A token is scoped to exactly one space,
 * and the service refuses a request for another — so a new token is required, and minting one goes
 * through the browser authorize flow by design. Membership is checked first, so
 * a typo does not open a browser.
 */
export async function useOrg(deps: UseOrgDeps): Promise<AuthConfig> {
  const orgs = await listOrgs(deps)
  const match = orgs.find((o) => o.slug === deps.slug)
  if (!match) {
    const known = orgs.map((o) => o.slug).join(", ")
    throw new Error(
      `not a member of ${deps.slug} — you are in ${known.length > 0 ? known : "no spaces"}`,
    )
  }
  return deps.login(match.slug)
}

/** One member of a space, as /v1/orgs/:id/members reports it. */
export interface Member {
  userId: string
  displayName: string | null
}

export interface ListMembersDeps extends ListOrgsDeps {
  orgId: string
}

/**
 * Everyone in this space, for turning a stored user id into a name.
 *
 * Separate from `listOrgs` because it asks a different question of a different
 * route: `/v1/me` resolves the TOKEN to its user, while this resolves the
 * SPACE to its people — including people whose claims this machine can read
 * but who never logged in here.
 */
export async function listMembers(deps: ListMembersDeps): Promise<Member[]> {
  const doFetch = deps.fetchImpl ?? fetch
  const res = await doFetch(
    `${deps.apiUrl}/v1/orgs/${encodeURIComponent(deps.orgId)}/members`,
    { headers: { authorization: `Bearer ${deps.token}` } },
  )
  if (!res.ok) throw new Error(`could not read this space's members (${res.status})`)
  return ((await res.json()) as { members: Member[] }).members
}
