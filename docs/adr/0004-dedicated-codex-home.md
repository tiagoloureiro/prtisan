# ADR 0004: Mount a Dedicated Codex Home

## Status

Accepted

## Context

Codex CLI subscription authentication is stored under `CODEX_HOME`. Mounting the user's entire `~/.codex` into agent containers would expose unrelated auth, config, logs, and sessions.

## Decision

Use a dedicated gitignored Codex home under `.sandcastle/codex-home` and mount only that directory into Docker sandboxes.

## Consequences

The user must seed this Codex home once with `codex login` or copied credentials. The CLI can prune logs and sessions without touching the user's personal Codex state.
