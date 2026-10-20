# Observability and SLOs

What Lattice measures, what it promises, and what happens when it misses.

## The SLO

Lattice has one service level objective, because it has one thing tenants
care about most: that jobs start when they are supposed to.

> 99.5% of scheduled jobs start within 60 seconds of their scheduled time,
> measured over a rolling 28 days.

"Start" means a runner has taken the first attempt of the run. On-demand
submissions count from the moment lattice-api accepted them. Runs delayed by
a tenant's own quota or by a paused tenant are excluded, since Lattice
delayed them on purpose.

The SLI is computed from the metric `lattice_job_start_delay_seconds`, a
histogram recorded by the planner and the runners.

There is deliberately no SLO on job success. Whether a job succeeds is mostly
up to the job.

## Error budget policy

The 0.5% left over is the error budget: over 28 days, about 3.4 hours' worth of
late starts at normal volume.

- While budget remains, the team ships features as normal.
- When the budget is spent, feature deploys pause until the rolling window
  recovers. Fixes, reliability work and security changes still go out.
- If a single incident spends more than half the budget, its postmortem
  action items take priority over planned work in the next sprint.

The engineering manager can override the pause for a specific change, and
writes down why in #lattice-eng.

## Dashboards

Dashboards live in Grafana in the "Lattice" folder.

- **Lattice / Overview**: SLO burn, runs per minute, success rate by tenant.
- **Lattice / Queue health**: ready and leased counts, dequeue latency,
  dequeues per second, runner count against target.
- **Lattice / Runners**: heartbeats, attempts per runner, lost attempts,
  runner image versions.
- **Lattice / Tenants**: one row per tenant key with its quota, in-flight runs
  and late starts.

## Alerts

Alerts are defined in the `lattice` monorepo next to the code, and changes to
them go through review like any other change. Every alert links to a runbook;
an alert without one is not merged.

Alerts that page: `LatticeQueueBacklogHigh`, `LatticeSLOFastBurn`,
`LatticeLostAttemptsHigh` and `LatticeReplicationLag`. Everything else is a
working-hours notification in #lattice-eng.

## Logs and traces

Logs are structured JSON and are retained for 14 days. Each line carries the
tenant key, run id and attempt id when there is one, so a single run can be
followed across lattice-api, the planner and a runner.

Traces are sampled: 10% of traces are kept, plus every trace containing an
error. A run's trace id is shown in `latticectl run show`.

Job output is not logged by Lattice. A job's own stdout and stderr go to the
tenant's log stream, which the tenant controls and pays for.
