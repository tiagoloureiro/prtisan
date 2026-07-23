# ADR 0002: Use GitHub Native PR and Issue State

## Status

Accepted

## Context

Validation and merge need a reliable dependency graph for an existing PR stack. Local train state is fragile because a user may already have a large PR stack or may mutate PRs directly on GitHub.

## Decision

Load all open PRs from GitHub, including drafts, with `gh pr list --state open`. Derive dependencies primarily from PR base/head branch relationships and enrich linked closing issues with GitHub native `blockedBy` and `blocking` issue fields when present.

## Consequences

The CLI requires GitHub CLI 2.94 or newer and repository permissions that can read PR metadata and issue dependency fields. PRs without linked closing issues are still included, but validation skips Spec for those PRs.
