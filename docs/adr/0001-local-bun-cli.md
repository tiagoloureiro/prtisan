# ADR 0001: Run Agent PR Train as a Local Bun CLI

## Status

Accepted

## Context

The workflow needs Docker, Git worktrees, `gh`, Sandcastle, and Codex CLI subscription authentication. Running it as a normal GitHub Actions workflow would make ChatGPT-managed Codex credentials and branch mutation harder to secure.

## Decision

Build `agent-train` as a local Bun TypeScript CLI. Development, tests, type checking, and the published entrypoint all run through Bun.

## Consequences

The workflow is suitable for a trusted workstation or private runner. Public CI is out of scope unless authentication is redesigned around Codex access tokens or API keys.
