# ADR 0004: Mount a Dedicated Codex Home

## Status

Accepted

## Context

Codex CLI subscription authentication is stored under `CODEX_HOME`. Mounting the user's entire `~/.codex` into agent containers would expose unrelated auth, config, logs, and sessions.

## Decision

Use a dedicated Codex home under `$XDG_DATA_HOME/prtisan/codex-home` and mount
only that directory into Docker sandboxes. `prtisan run` verifies authentication
both on the host and in the exact managed image before creating review
worktrees. In an interactive terminal it runs `codex login --device-auth`
against this home and resumes the workflow in the same invocation; automation
receives a structured credentials checkpoint.

## Consequences

The browser authorization remains a genuine one-time human action, but users do
not need to discover or run a separate onboarding command. Prtisan never copies
or mounts the normal Codex home. The CLI can prune its own logs and sessions
without touching the user's personal Codex state.
