# ADR 0002: Use GitHub Native Issue Dependencies

## Status

Accepted

## Context

The train needs a reliable dependency graph. Parsing prose from issue bodies would be fragile and easy for agents to damage.

## Decision

Read dependencies from GitHub native `blockedBy` and `blocking` issue fields through `gh`.

## Consequences

The CLI requires GitHub CLI 2.94 or newer and repository permissions that can read issue dependency fields. Repositories without native dependencies must be adapted before they can use the tool.
