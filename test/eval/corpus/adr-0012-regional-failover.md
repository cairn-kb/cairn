# ADR 0012: Active-passive regional failover

- Status: Accepted
- Date: 2026-01-20
- Deciders: the Lattice team and the platform reliability group

## Context

Lattice runs in eu-west-1. A regional outage there stops every scheduled job
for every tenant, including invoice runs with contractual deadlines. The
platform now offers a second region, us-east-2, with the same Kubernetes and
Postgres tooling, and asked each service to say what it would do with it.

Two properties make Lattice harder to spread across regions than a stateless
service:

- The queue is a Postgres table (ADR 0007), so both regions would need to
  agree on who holds each lease.
- Running an attempt twice is worse for tenants than running it late. A late
  invoice run is an apology; a doubled one is a refund.

## Options considered

### Active-active

Both regions accept submissions and run jobs. This needs a multi-writer
database or a partitioning of tenants between regions, and either way a
network partition between the regions can leave both sides believing they hold
a lease. The duplicate-execution risk is exactly the failure Lattice exists to
prevent. Rejected.

### Active-passive, automatic

us-east-2 holds a standby and takes over when health checks from eu-west-1
fail. Rejected because health checks failing from one vantage point is not the
same as a region being gone, and an automatic promotion during a partial
outage produces the split-brain the active-active option was rejected for.

### Active-passive, manual

us-east-2 holds a warm standby. Promotion is deliberate.

## Decision

Active-passive with manual failover. eu-west-1 is the active region and
serves all traffic. us-east-2 runs the full set of components scaled to zero
runners, with Postgres receiving logical replication from the active database.

Failover is decided by the incident commander, never by automation. The
incident commander confirms with the platform reliability group that eu-west-1
is not expected back soon, then runs the failover procedure in the regional
failover runbook: fence the old database, promote the replica, scale the
standby runners, and repoint the lattice-api DNS record.

The targets are an RPO of 5 minutes and an RTO of 45 minutes. The RPO follows
from replication lag, which is alerted on above two minutes. The RTO is
dominated by scaling the standby runner fleet from zero.

## Consequences

- Runs that were in flight in eu-west-1 at the moment of failover are treated
  as lost and retried in us-east-2. Tenants with non-idempotent jobs are told
  this in the onboarding notes, and are asked to use idempotency keys.
- The standby costs little while idle: the database replica and the
  control-plane components, with no runners.
- Failover is rehearsed twice a year on a staging copy, and once a year in
  production during a planned window.
- Failing back to eu-west-1 is the same procedure in reverse, and is scheduled
  rather than rushed: there is no outage forcing it.

## Revisit

Revisit if a tenant needs an RTO below 45 minutes, or if the platform offers a
database with a lease primitive that holds across regions.
