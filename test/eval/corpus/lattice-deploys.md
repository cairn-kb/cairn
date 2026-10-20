# Deploying Lattice

Every change to Lattice reaches production through the same pipeline. Nobody
deploys from a laptop, and nobody edits a running deployment by hand: if the
pipeline is broken, fixing the pipeline is the first job.

## The pipeline

A merge to `main` starts the pipeline. It runs these stages in order, and a
failure at any stage stops it:

1. **Build.** The pipeline builds one container image per component and tags
   each with the commit sha.
2. **Test.** Unit tests, then the integration suite against a throwaway
   Postgres. The integration suite takes about twelve minutes.
3. **Migrate.** Database migrations run in a separate pipeline step before the
   canary, against production, using the migration tool's lock so two
   pipelines cannot migrate at once.
4. **Staging.** The new images go to staging, where a synthetic tenant submits
   a fixed mix of jobs for fifteen minutes.
5. **Canary.** In production, the canary takes 5% of runner traffic for 30
   minutes.
6. **Full rollout.** The remaining runners, the planner and lattice-api are
   replaced in batches of 20%.

A typical change goes from merge to fully deployed in a little over an hour.

## Approvals

A change needs one approving review from an engineer outside the author's
pair before it can merge. The pipeline itself needs no further approval: once
a change is merged, it is expected to go out. If a change should not go out
yet, it should not be merged yet — use a feature flag.

## The canary

The canary is promoted only if the job start SLO holds for the canary runners
for the whole 30 minutes; the target is on the Observability and SLOs page.
The canary is also stopped automatically if its error rate is more than twice
the error rate of the rest of the fleet.

While a canary is running, a second merge queues behind it rather than
replacing it. Two canaries never run at once.

## Migrations

Migrations must be backward compatible for one release: the version before the
change has to keep working against the migrated schema, because during the
canary both versions run against the same database. In practice that means
adding a column in one change and using it in the next, and dropping a column
only after nothing reads it.

Long-running migrations — anything that rewrites a large table — are not run
by the pipeline. Schedule them with the database on-call and run them as a
Lattice job, which is what Lattice is for.

## Rolling back

To return production to the last good version, run:

    latticectl rollback --to previous

This redeploys the previous images to every component at once, skipping the
canary. It does not reverse migrations, which is one more reason they have to
be backward compatible. After a rollback, the pipeline is paused until someone
unpauses it with `latticectl pipeline resume`, so the bad change cannot go
straight out again.

## The deploy freeze

Deploys are blocked from 16:00 UTC on Friday until 08:00 UTC on Monday. The
pipeline enforces this: a merge during the freeze builds and tests, then waits
at the Migrate stage until Monday morning.

There is also a freeze over the last two weeks of December, announced in
#lattice-eng each year.

A fix for an active incident can go out during a freeze. The incident
commander approves it in the incident channel, and the on-call engineer runs
`latticectl pipeline override --reason "<incident link>"`. The override is
logged, and every override is reviewed at the next team retro.

## Error budget

When the job start SLO's error budget is spent, feature changes stop going out
until it recovers; see the error budget policy on the Observability and SLOs
page. Fixes and reliability work continue as normal.
