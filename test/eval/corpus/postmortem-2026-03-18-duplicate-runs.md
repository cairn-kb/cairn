# Postmortem: duplicate job runs on 2026-03-18

- Severity: SEV2
- Duration: 2 hours 14 minutes (09:41 to 11:55 UTC)
- Incident commander: Tomás Reyes
- Status: action items in progress

This postmortem is blameless. It describes what the system and the process
allowed to happen, not who did what wrong.

## Summary

For a little over two hours, some Lattice attempts were executed by two
runners at the same time. About 3,100 jobs ran twice. Most were harmless
rebuilds and exports, but one tenant's invoice job sent 412 customers a
second copy of their monthly invoice email.

## Impact

- About 3,100 jobs ran twice across 38 tenants.
- 412 duplicate invoice emails from the billing team's tenant. The billing
  team sent a correction the same afternoon.
- No data was lost. Two warehouse loads wrote duplicate rows, which the data
  team removed the next day.

## Timeline (UTC)

- **09:30** A new runner machine image, built that morning, starts rolling out
  through the ordinary autoscaling replacement.
- **09:41** The first runners on the new image begin taking attempts. Their
  leases start expiring before renewal is due; the reaper marks those attempts
  lost and the runs become ready again, and a second runner picks them up
  while the first is still executing.
- **10:52** The billing team reports duplicate invoice emails in
  #lattice-help. This is the first signal. No alert fired.
- **11:05** The on-call engineer declares a SEV2. Tomás Reyes takes incident
  command.
- **11:20** Lost-attempt rate is found to be thirty times normal, all of it on
  runners from the new image.
- **11:31** The autoscaler is pinned to the previous image and the new-image
  runners are drained.
- **11:55** Lost-attempt rate is back to normal. Incident resolved.

## Root cause

The new machine image shipped with a time synchronisation configuration that
pointed at a server unreachable from the runner subnet. The runners' clocks
drifted, and within an hour some were more than 40 seconds ahead of the
database. Lease expiry is computed by the runner but checked by the reaper
against the database clock, so the clock skew made leases look older than
they were, and the reaper reclaimed attempts that were still running.

Nothing in the image pipeline checked time synchronisation, and nothing in
Lattice alerted on a rise in lost attempts.

## What went well

- Once declared, the incident was diagnosed in fifteen minutes, because lost
  attempts and runner image versions were both queryable.
- Draining the new runners stopped the duplicates at once, without a deploy.

## What went badly

- A tenant noticed before we did, by 71 minutes.
- Lease expiry trusted two clocks to agree.

## Action items

| Action | Owner | Status |
| --- | --- | --- |
| Alert when the lost-attempt rate is more than three times its weekly baseline | Lattice on-call | Done |
| Compute lease expiry from the database clock only | Lattice team | In progress |
| Add a time synchronisation check to the machine image pipeline | Platform team | Done |
| Require idempotency keys for all new job types, and publish guidance for existing ones | Lattice team | In progress |
| Add duplicate-execution detection to the run history | Lattice team | Not started |
