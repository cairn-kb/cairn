# Lattice release process

Deploys put commits into production continuously; a release is something
else. A release gives a set of commits a version number, a changelog entry and
a runner image that other teams can pin. Teams that run their own runners
inside their accounts — the data warehouse team and the payments team today —
upgrade from one release to the next, never from an arbitrary commit.

## The release train

Releases leave on a fixed schedule whether or not anything big has landed.
A quiet fortnight produces a small release, and that is fine: a predictable
date is worth more to the teams pinning versions than a full one.

The release captain rotates with the on-call schedule. The engineer coming off
primary on-call is the release captain for the next release, so the person
cutting it has just spent a week watching the code in production.

## Cutting a version

Versions are cut every second Tuesday, in the morning, Lisbon time. The release
captain:

1. Confirms the main branch is green and that the last deploy finished its
   full rollout.
2. Runs `make release VERSION=2026.10.2`, substituting the next number. The
   target tags the commit, builds the runner image and pushes it to
   `registry.lattice.internal/runner` under that tag.
3. Opens the generated changelog draft, edits it into plain sentences, and
   merges it.
4. Posts the version and the changelog link in #lattice-announce.

Version numbers are calendar versions: the year, the month, and a counter
that starts at 1 each month. The second version cut in October 2026 is
`2026.10.2`.

A version is never re-tagged. If something is wrong with a tagged image, the
fix gets the next number.

## The changelog

Every pull request that changes behaviour a runner operator would notice adds
a line under `Unreleased` in `CHANGELOG.md`. The release target moves that
section under the new version heading. Lines are written for the people who
run runners, not for the Lattice team: "Runners now retry a lost lease once
before giving up", not "Refactor lease loop".

## Hotfixes

A hotfix branch is cut from the last tag, never from main. Main may already
hold changes that are not ready for teams pinning versions, and a hotfix must
contain the fix and nothing else.

The hotfix gets the next counter in the current month, is tagged by the
release captain with the same `make release` target, and the fix is then
merged back into main through an ordinary pull request.

## Support window

The two most recent versions are supported. A team on an older version is
asked to upgrade before the Lattice team investigates a problem it reports;
most problems turn out to be fixed already.

## Deprecations

A change that removes something a runner operator relies on is announced one
release ahead, with a changelog line under a `Deprecated` heading, and lands
no earlier than the following release. Removing a configuration key, changing
a default and dropping support for an old job spec format all count.
