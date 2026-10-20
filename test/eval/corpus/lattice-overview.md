# Lattice service overview

Lattice runs scheduled and on-demand batch jobs for the other product teams.
A team describes a job once — an image, a command, a cron spec or a trigger,
and the tenant it belongs to — and Lattice makes sure it runs, retries it when
it fails, and keeps a record of every attempt. Nightly invoice generation,
search index rebuilds, the data warehouse loads and most report exports run on
Lattice today.

This page is the starting point for anyone new to the service. It explains the
moving parts, where they run, who owns them and where to ask questions. The
detail lives in the linked pages: Deploying Lattice, the release process,
Authentication and service tokens, On-call, Observability and SLOs, the ADRs
and the runbooks.

## Components

Lattice is four components and one database.

- **lattice-api** is the only public entry point. It accepts job definitions
  and one-off submissions over HTTP, validates them, and writes them to the
  database. It never runs anything itself.
- **The planner** wakes every ten seconds, reads the job definitions whose
  next run is due, and inserts one row per run into the queue table. It is
  the only component that understands cron specs.
- **Runners** are the worker fleet. Each runner takes one job at a time from
  the queue, holds a lease on it while it runs, and reports the result. The
  fleet scales between 40 and 400 runners depending on queue depth.
- **The reaper** finds runs whose lease has expired without a result, marks
  the attempt as lost and puts the run back in the queue.
- **Postgres** holds the job definitions, the queue and the run history. The
  queue lives in the same database on purpose; ADR 0007 explains why.

All four components are written in Go and deployed as containers on the shared
Kubernetes platform.

## Regions

Lattice runs in two regions. eu-west-1 serves all traffic; us-east-2 holds a
warm standby that receives a replica of the database and keeps a small runner
fleet scaled to zero. ADR 0012 covers when and how traffic moves to the
standby.

## Limits

Every job carries a tenant key, and quotas are enforced per tenant: by default
a tenant may have 200 runs in flight at once. Lattice enforces a hard runtime
ceiling of 6 hours; a run still going after that is killed and recorded as
timed out, and it is not retried. Jobs that need longer should be split into
stages, each submitted as its own job.

Job payloads are limited to 256 KB. Anything bigger belongs in object storage,
with the job carrying a reference to it.

## Ownership

Lattice is owned by a team of seven engineers and one engineering manager,
Priya Natarajan. Product decisions go through the team's product owner, Ines
Albescu.

The team works in #lattice-eng. Other teams ask questions, report problems and
request quota changes in #lattice-help, which the on-call engineer watches
during working hours. Anything urgent outside working hours goes through the
page described on the On-call page, not a chat message.

## Where things live

| What | Where |
| --- | --- |
| Source | the `lattice` monorepo |
| Runner image | the internal container registry |
| Dashboards | Grafana, folder "Lattice" |
| Runbooks | this space, under Runbooks |
| Decisions | this space, under ADRs |

## History

Lattice replaced a set of cron hosts that each team ran for itself. The
migration finished in early 2025; the last cron host was switched off in
April 2025. Some job definitions still carry a `legacy_host` label from that
migration. It has no effect and can be removed when a team next edits the job.
