# ADR 0003: Represent DAG Joins with Synthetic Base Branches

## Status

Accepted

## Context

GitHub pull requests have one base branch, but an open PR may depend on multiple other open PR branches.

## Decision

For multi-blocker PRs, create a synthetic base branch named from the dependent PR number that merges all open blocker branches. The dependent PR branch is based on that synthetic branch.

## Consequences

The stack can preserve real DAG parallelism, but synthetic branches must be regenerated after squash merges or blocker branch changes.
