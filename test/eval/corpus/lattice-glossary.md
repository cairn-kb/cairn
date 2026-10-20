# Lattice glossary

Words the Lattice team uses with a specific meaning. If a page uses one of
these differently, the page is wrong; please fix it.

## Job

A definition of something to run: a container image, a command, the tenant it
belongs to, and either a cron spec or "on demand". A job is not an execution.
Jobs are created and edited through lattice-api with the `lattice:define`
scope.

## Run

One scheduled or submitted execution of a job. The planner creates a run when
a cron spec comes due; a submission through lattice-api creates one at once.
A run is ready when its scheduled time has passed and no runner holds it.

## Attempt

One try at a run. A run has one or more attempts. An attempt ends as
succeeded, failed, timed out or lost. A failed or lost attempt is retried with
exponential backoff, starting at 30 seconds and doubling each time. A timed-out
attempt is never retried.

## Dead letter

After 5 failed attempts a run moves to the dead-letter table, and no further
attempts are made. The owning team is notified in their configured channel.
Dead-lettered runs can be replayed with `latticectl run replay <run-id>` once
the cause is fixed; replaying starts a fresh run with a fresh attempt count.

## Runner

A worker process that executes one attempt at a time. Runners are stateless:
everything a runner knows about an attempt is in the database or in the
attempt's payload.

## Lease

The claim a runner holds on an attempt while executing it. A lease lasts 90
seconds and is renewed every 30 seconds. If a lease expires without being
renewed, the reaper marks the attempt as lost and the run becomes ready again.
The lease length is the longest a run can go unwatched.

## Reaper

The component that finds expired leases and marks their attempts as lost. It
runs every 15 seconds.

## Planner

The component that turns cron specs into runs. It is the only component that
parses cron specs, and it evaluates them in UTC.

## Tenant key

The identifier of the team or service a job belongs to. Quotas, scopes,
dashboards and billing are all per tenant key. A tenant key never changes; a
renamed team retains its old key.

## Fairness counter

A per-tenant number used to order dequeues so that a tenant with a large
number of ready runs cannot starve the others. Each dequeue for a tenant
raises its counter; runs from the tenant with the lowest counter are dequeued
first, within the same priority.

## Backfill

Submitting the runs a job would have made over a past period, usually after a
fix to the job. Backfills go in at the lowest priority so they never delay
scheduled runs.

## Drain

Stopping a runner from taking new attempts while letting its current attempt
finish. Every runner is drained before it is replaced in a deploy.

## Freeze

A period when the deploy pipeline will not deploy to production. See
Deploying Lattice for the weekly and end-of-year freezes.
