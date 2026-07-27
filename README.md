# Prtisan

Prtisan is a resumable pull-request integration engine for GitHub. It plans the
complete open PR train, freezes the authority used to judge each PR, runs Codex
only inside a pinned Docker Sandcastle, and advances the train through bounded
repair, guarded squash merge, and direct-child restacking.

It is intentionally pre-launch. The former commands, `.sandcastle`
configuration, run records, and GitHub markers are not compatible.

## Commands

```text
prtisan init plan --cwd /path/to/repo
prtisan init apply <setup-plan-id>
prtisan plan --cwd /path/to/repo
prtisan apply <plan-id>
prtisan status <plan-id>
prtisan export <plan-id>
```

`init` creates a setup PR containing `.prtisan/manifest.json` and
`.prtisan/Dockerfile`; a human must review and merge it. `plan` is read-only and
persists an immutable snapshot. `apply` executes or resumes that snapshot
idempotently. `status` explains the durable checkpoint and next action.
`export` writes redacted, content-addressed evidence.

Authenticate the dedicated home once before applying a train:

```text
CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/prtisan/codex-home" codex login
```

## Safety model

- The whole open train is the unit of authority. Roots and single-parent stacks
  are supported; cycles and multi-parent joins fail before mutation.
- Policy, runtime, checks, review state, and intent contracts are frozen from
  each PR's base snapshot. Policy changes apply only after merge.
- Codex blockers and repairs require a linked issue or the configured structured
  PR-body sections. Deterministic checks and human review still apply to every PR.
- All Codex work and candidate verification runs inside Docker Sandcastle.
- Normal repairs are additive commits. Restacks alone may use force-with-lease,
  guarded by the exact old head and base.
- Required GitHub checks and human approvals are hard external gates.
- Successful merged prefixes remain merged when a later PR blocks.
- The append-only journal lives under `$XDG_STATE_HOME/prtisan`; artifacts and a
  dedicated Codex home live under `$XDG_DATA_HOME/prtisan`. Operator Codex
  credentials are never mounted from the normal Codex home or stored in a target
  repository.

## Development

```text
bun install
bun run typecheck
bun test
bun run build
```

See [the full documentation](docs/index.md) and
[ADR 0007](docs/adr/0007-resumable-integration-engine.md).
