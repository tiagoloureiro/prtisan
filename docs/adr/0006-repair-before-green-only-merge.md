# Repair Before Green-Only Merge

## Status

Accepted

## Context

ADR 0005 made the merge train green-only, but stopping immediately on draft state, missing validation, stale validation, failing CI, or ambiguous mergeability forced users to run separate repair steps outside the train. Agent PR Train now treats those states as repairable work when the merge command reaches the PR: it marks drafts ready, runs selected-PR validation, attempts CI and merge-state repair, and revalidates after repair commits. The final squash merge remains green-only and still uses GitHub mergeability plus the head-SHA guard; required human review remains a hard stop.
