# Onboarding to the Lattice team

Welcome. This page is the checklist for your first weeks on the team. Your
onboarding buddy will go through it with you; tick things off in your
onboarding issue as you finish them.

## Before your first day

Your manager requests your laptop, your SSO account and your membership of
the Lattice team group. You do not need to request anything yourself before
you start.

## Week one

**Access.** Request access in the #access-requests channel, one request per
system, using the form pinned in that channel. You need:

- the `lattice` monorepo, with write access;
- the Grafana "Lattice" folder;
- the staging Kubernetes namespace;
- a Warden identity for `latticectl` against staging.

Production read access is granted after shadowing two on-call shifts, and
the `lattice:admin` scope only once you join the rotation.

**Local environment.** Clone the monorepo and run `make dev-up`. It starts a
local Postgres and two runners in containers, applies every migration, and
seeds a demo tenant with a handful of jobs. `make dev-down` stops it; `make
dev-reset` wipes the database and seeds it again. If `make dev-up` fails on a
fresh laptop, it is a bug in the setup, not in your laptop: tell your buddy
and fix the setup together.

**Reading.** Read the service overview, the glossary, both ADRs and the
duplicate runs postmortem. The postmortem is the fastest way to understand
why leases and idempotency come up in every design discussion.

**A first change.** Pick an issue labelled `first-change` and get it merged
before the end of the week. It is meant to be small. The point is to go
through review, the pipeline, the canary and a full rollout once, with your
buddy watching.

## Weeks two to four

- Pair with a different teammate each week on whatever they are working on.
- Sit in on the on-call handoff call each week, even before you shadow.
- Shadow two on-call shifts: you are added as a third responder, you see
  every alert, and you follow the primary through anything that happens.
- Read every runbook, and run the steps of one against staging.

## Joining the rotation

You join the on-call rotation after six weeks, once you have shadowed two
shifts, run a runbook against staging and signed in to `latticectl` against
production with your hardware key. Your first week is as secondary, with your
buddy as primary.

## Who to ask

Your buddy first, for anything. The engineering manager for anything about
the team, your role or your growth. #lattice-eng for anything technical that
others might want to hear the answer to: if you had the question, the next
person will too.
