# ADR 0007: Keep the job queue in Postgres

- Status: Accepted
- Date: 2025-11-04
- Deciders: the Lattice team, with the database on-call group consulted

## Context

When Lattice replaced the per-team cron hosts, the queue was a table in the
same Postgres database as the job definitions. That was meant to be
temporary. By late 2025 the service was handling around 900 dequeues per
second at peak, and the question came up again: should the queue move to a
dedicated system before load forces the move in a hurry?

What the queue has to provide:

- **Exactly one runner per attempt.** Two runners executing the same attempt
  is the failure tenants notice most, because most jobs are not idempotent.
- **Transactional enqueue.** The planner records that a run is due and
  enqueues it in one step; if those can diverge, runs are lost or doubled.
- **Priorities and per-tenant fairness.** One tenant submitting fifty thousand
  runs must not starve everyone else.
- **Inspection.** On-call engineers answer "why has this run not started?"
  many times a week, and the answer should be one SQL query away.

## Options considered

### Kafka

The platform already operates Kafka. Partitioned topics would give far more
headroom than Postgres. But per-message acknowledgement with leases has to be
built on top, per-tenant fairness fights the partitioning model, and the
enqueue can no longer share a transaction with the run record without an
outbox, which is a second queue in Postgres anyway.

### SQS

SQS gives visibility timeouts, which are close to leases, and no servers to
run. It has no priorities beyond separate queues, ordering and fairness would
need one queue per tenant, and "why has this run not started?" becomes a
question for a console rather than a query. It would also be the only part of
Lattice that cannot run in a developer's local environment.

### Stay in Postgres

Keep the queue table and dequeue with `SELECT ... FOR UPDATE SKIP LOCKED`,
ordered by priority and by a per-tenant fairness counter, inside the same
transaction that writes the lease.

## Decision

Keep the queue in Postgres, using `SKIP LOCKED` dequeues. The enqueue shares a
transaction with the run record, which gives the transactional guarantee for
free, and the lease is a column on the same row.

Load tests against a production-sized replica showed an upper bound of roughly
4,000 dequeues per second before lock contention on the queue table's index
dominated. That is more than four times the late-2025 peak.

## Consequences

- One database to operate, back up and fail over, which ADR 0012 relies on.
- Queue depth, lease state and history are all queryable with ordinary SQL,
  and the runbooks use that heavily.
- The queue competes with the run history for the database's resources.
  Run history older than 30 days is moved to a partitioned archive table so
  the hot table stays small.
- There is a ceiling. Revisit this decision when sustained load passes 2,500
  dequeues per second for a week, which leaves time to move before the upper
  bound is close.

## Follow-up

- Add a dashboard panel for dequeues per second against the revisit
  threshold. (Done: "Lattice / Queue health".)
- Document the fairness counter in the glossary.
