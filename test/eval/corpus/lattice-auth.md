# Authentication and service tokens

Every request to lattice-api is authenticated, including requests from inside
the platform. There is no unauthenticated endpoint other than the health
check, and the health check returns nothing but a status code.

## Callers

Other services call lattice-api with a service token: a signed bearer token
issued by Warden, the platform's identity service. A service obtains its token
from the Warden sidecar that runs next to it, which handles issuing and
refreshing it.

Service tokens expire after 12 hours. Rotation is automatic: the sidecar
fetches a fresh token when the current one is two thirds of the way through
its lifetime, so a healthy service never presents an expired token. A service
that does see `401 token expired` almost always has a sidecar that has died or
cannot reach Warden; restart the pod before investigating anything else.

Tokens are never written to disk, to logs or to job payloads. lattice-api
rejects a job definition whose environment contains anything that parses as a
Warden token, and says why.

## Scopes

A token carries scopes, and each lattice-api route requires one:

| Scope | Allows |
| --- | --- |
| `lattice:submit` | submitting runs and reading their status, for the token's own tenant |
| `lattice:define` | creating and editing job definitions, for the token's own tenant |
| `lattice:read` | reading definitions and run history across tenants |
| `lattice:admin` | pausing and resuming a tenant, changing quotas, and the `latticectl` operator commands |

Every token is scoped to a tenant key, and lattice-api checks the tenant on
the token against the tenant on the job for every request. A token cannot act
for another tenant, even with `lattice:read`, which can read across tenants
but not write.

## People

Engineers reach `latticectl` and the admin routes through the company SSO.
Signing in gives a token with the same lifetime as a service token.

The `lattice:admin` scope requires a hardware security key at sign-in, and an
admin token is issued only to members of the Lattice team and the platform
on-call group. The scope is reviewed every quarter; anyone who has not used it
in ninety days loses it and can ask for it back.

## Between components

The planner, the runners, the reaper and lattice-api talk to each other over
mTLS. Their certificates come from the platform's internal certificate
authority and are rotated every 72 hours. Each component checks the peer's
certificate subject against an allowlist: runners accept connections only
from the planner and lattice-api, and the database accepts connections only
from the four Lattice components and the migration step of the deploy
pipeline.

## Secrets inside jobs

A job that needs a secret names it in its definition, and the runner fetches
it from the secrets manager when the run starts, using the tenant's own
identity. Lattice never stores the secret's value. A run can only fetch
secrets its tenant has been granted.

## Reporting a problem

If you think a token or certificate has leaked, page the Lattice on-call and
the platform security team at once, then revoke it in Warden. Do not wait to
confirm the leak first.
