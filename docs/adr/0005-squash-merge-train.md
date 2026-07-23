# ADR 0005: Squash Merge the PR Train

## Status

Accepted

## Context

The desired repository history is one main-branch commit per PR, but stacked branches normally preserve ancestry through merge commits.

## Decision

Use green-only squash merges with head-SHA guards, then restack affected descendant branches and rerun validation. Agent validation status is read from GitHub PR review bodies that carry the `agent-train:validation` marker.

## Consequences

The merge train is slower than a merge-commit train because descendants must be rebased or regenerated after each parent lands. It produces a cleaner main history and stops instead of bypassing branch protection.
