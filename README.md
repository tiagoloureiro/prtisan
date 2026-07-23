# Agent PR Train

`agent-train` is a local Bun-first CLI for coordinating dependent GitHub issues through Codex CLI agents, Sandcastle Docker sandboxes, stacked pull requests, automated validation, and a guarded squash-merge train.

## Commands

```bash
bun run src/index.ts create-prs --cwd /path/to/repo
bun run src/index.ts validate --cwd /path/to/repo --train-id <train-id>
bun run src/index.ts merge --cwd /path/to/repo --train-id <train-id>
```

## Requirements

- Bun for normal operation
- GitHub CLI 2.94+
- Docker
- Git
- Codex CLI
- A target repository with `.sandcastle/agent-train.config.json`

Use a dedicated `.sandcastle/codex-home` and seed it with Codex authentication before running agents. Do not mount your full `~/.codex` into the sandbox.

```bash
mkdir -p .sandcastle/codex-home
CODEX_HOME="$PWD/.sandcastle/codex-home" codex login
docker build -t sandcastle:agent-train -f .sandcastle/Dockerfile .
```

## Development

```bash
bun install
bun run typecheck
bun test
```
