# On-call

Lattice runs jobs around the clock for teams whose own customers notice when a
nightly export or invoice run is late, so someone on the team is always
reachable. This page covers the rotation, what the on-call engineer is
responsible for, and how a page escalates.

## The rotation

The rotation is weekly. There is a primary and a secondary each week; the
secondary is the previous week's primary, so the second line always knows
what happened in the last seven days.

The handoff happens on Wednesdays at 11:00 UTC, in a short call with the
outgoing and incoming primary. The outgoing primary walks through open
incidents, alerts that fired and were silenced, anything paused, and any
tenant that has been in touch. The notes go in the on-call log at the top of
#lattice-eng.

Wednesday was chosen so that a handoff never lands next to the weekend deploy
freeze or on a Monday after one.

Swaps are fine. Arrange them with a teammate and update the schedule in
PagerDuty yourself; the schedule is the source of truth, not the spreadsheet
some of us still keep.

## Responsibilities

The primary on-call:

- acknowledges every page within 5 minutes, at any hour;
- watches #lattice-help during working hours and answers or routes questions;
- runs the runbook for any alert that fires, and records what was done;
- is the default incident commander for SEV2 and SEV3 incidents;
- keeps the pipeline moving: unpausing it after a rollback, approving freeze
  overrides only as incident commander.

The secondary is a backup, not a second primary. They are paged only when the
primary has not acknowledged.

## Escalation

Pages come from the PagerDuty service `lattice-prod`. If the primary does not
acknowledge within 15 minutes, the page escalates to the secondary. If the
secondary has not acknowledged 15 minutes after that, it escalates to the
engineering manager, and then to the platform duty manager.

Escalating early is always acceptable. Pull in the secondary, the database
on-call or the platform on-call whenever you would like a second pair of eyes;
nobody keeps score.

## Severity

| Severity | Meaning | Who leads |
| --- | --- | --- |
| SEV1 | Jobs are not running for most tenants, or data is lost | the engineering manager, or whoever they hand it to |
| SEV2 | Jobs are delayed or failing for one or more tenants | primary on-call |
| SEV3 | Something is degraded but tenants are not yet affected | primary on-call |

Every SEV1 and SEV2 gets a postmortem within five working days. SEV3s have a
line in the on-call log.

## Looking after yourself

Night pages are expensive, and the rotation is meant to be sustainable.
Anyone on primary is owed a day off in lieu after a week with more than three
night pages, taken within the following month. Tell the engineering manager;
there is no form.

If a single alert pages at night more than twice in a month, it is either
fixed or downgraded to a working-hours notification at the next retro. An
alert nobody acts on at 3am should not be able to wake anyone at 3am.

## Before your first shift

Shadow two shifts, read every runbook under Runbooks, and make sure you can
sign in to `latticectl` with your hardware key. The onboarding page has the
full checklist.
