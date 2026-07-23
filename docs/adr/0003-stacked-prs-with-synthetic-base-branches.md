# ADR 0003: Represent DAG Joins with Synthetic Base Branches

## Status

Accepted

## Context

GitHub pull requests have one base branch, but an issue may be blocked by multiple issue branches.

## Decision

For multi-blocker issues, create a synthetic base branch that merges all blocker branches. The dependent issue branch is based on that synthetic branch.

## Consequences

The stack can preserve real DAG parallelism, but synthetic branches must be regenerated after squash merges or blocker branch changes.
