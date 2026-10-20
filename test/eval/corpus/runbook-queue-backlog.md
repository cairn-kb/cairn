# Runbook: queue backlog

Alert: `LatticeQueueBacklogHigh`, severity SEV2.

The alert fires when more than 20,000 jobs have been ready for over 10 minutes:
runs whose scheduled time has passed, which no runner has picked up. Tenants
feel this as jobs starting late, and the job start SLO burns while it lasts.

Work through the sections in order. Write what you did in the incident
channel as you go; the next person needs it more than you think.

## 1. Look at the shape of the backlog

Open the "Lattice / Queue health" dashboard. The three panels that matter:

- **Ready runs by tenant.** One tenant dominating means a flood (section 3).
  A backlog spread evenly across tenants means the fleet is short of capacity
  or the runners are unhealthy (section 2).
- **Dequeue latency p99.** Above two seconds means the database is the
  bottleneck, not the runners (section 4).
- **Runner count against target.** If the autoscaler's target is above the
  actual count, the platform cannot schedule runner pods.

## 2. Not enough runners

Check that runners are healthy before adding more: a fleet whose runners crash
on start will not be fixed by a bigger fleet. `latticectl runners status`
shows each runner's last heartbeat and the last error it reported.

If the runners are healthy and simply busy, scale them:

    latticectl runners scale --count <n>

Do not exceed 400 runners. Beyond that the database connection pool is the
limit, and more runners make dequeue latency worse for everyone. If 400
runners are not keeping up, go to section 4.

The autoscaler takes over again 30 minutes after a manual scale.

## 3. One tenant flooding the queue

Usually this is a backfill submitted all at once, or a job definition whose
cron spec is wrong. Contact the tenant's team in #lattice-help first.

If the flood is hurting other tenants and the owning team is not answering
within ten minutes, pause the tenant:

    latticectl tenant pause <tenant-key> --reason "<incident link>"

Pausing stops new runs for that tenant from being dequeued; runs already in
flight finish. It needs the admin scope (see Authentication and service
tokens). Resume with `latticectl tenant resume <tenant-key>` once the team has
cancelled the excess runs or agreed to let them drain.

## 4. The database is the bottleneck

If dequeue latency p99 stays above two seconds, page the database on-call and
keep them on the incident. Useful things to have ready for them:

- the output of `latticectl queue stats`, which shows the ready count, the
  leased count and the oldest ready run;
- whether the run history archive job ran last night (it moves old run
  history out of the hot table);
- any long-running migration or report query on the primary.

Do not restart Postgres or fail over to the standby region to clear a
backlog. A failover is a decision for the incident commander, and it
replaces a slow queue with a lost one.

## 5. Afterwards

When the ready count is back under the threshold and the oldest ready run is
under a minute old, resolve the alert. If any tenant's jobs started more than
an hour late, tell them in #lattice-help with the times. Open a postmortem if
the backlog lasted more than an hour or a tenant missed a deadline.
