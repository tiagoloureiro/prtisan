# Prtisan

Prtisan is a resumable pull-request integration engine for GitHub. It plans the
complete open PR train, freezes the authority used to judge each PR, runs Codex
only inside a pinned Docker Sandcastle, and advances the train through bounded
repair, guarded squash merge, and direct-child restacking.

It is intentionally pre-launch. The former commands, `.sandcastle`
configuration, run records, and GitHub markers are not compatible.

## Commands

```text
prtisan run --cwd /path/to/repo
```

`run` is the normal interface. It creates or reuses the one-time setup PR,
creates or resumes the repository's latest frozen plan, applies the train, and
prints the same command at every resumable checkpoint. Human-readable output is
the default; add `--json` for automation. Exit status is `0` for completion, `2`
for a durable checkpoint, and `1` for invalid input or infrastructure failure.

Advanced inspection and recovery commands remain available:

```text
prtisan init plan --cwd /path/to/repo
prtisan init apply <setup-plan-id>
prtisan plan --cwd /path/to/repo
prtisan apply <plan-id>
prtisan status <plan-id>
prtisan export <plan-id>
```

The setup PR contains `.prtisan/manifest.json` and `.prtisan/Dockerfile`; a
human must review and merge it. `plan` is read-only and persists an immutable
snapshot. `apply` executes or resumes that snapshot idempotently. `status`
explains the durable checkpoint and next action. `export` writes redacted,
content-addressed evidence.

Authenticate the dedicated home once before applying a train:

```text
CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/prtisan/codex-home" codex login
```

## Fixed role-based model routing

The repository manifest uses schema v2 and assigns an explicit model profile to
every supported agent role:

```json
{
  "schemaVersion": 2,
  "codex": {
    "roles": {
      "standardsReview": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      },
      "specReview": { "model": "gpt-5.6-sol", "reasoningEffort": "medium" },
      "repairVerification": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      },
      "validationRepair": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      },
      "ciRepair": { "model": "gpt-5.6-sol", "reasoningEffort": "medium" },
      "mergeStateRepair": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      },
      "restackConflictRepair": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      }
    }
  }
}
```

The checked-in profile is authoritative for every Sandcastle invocation. There
are no filename-based effort overrides, dynamic production routing, canaries, or
automatic policy changes. A valid schema-v1 manifest creates a setup checkpoint
and reviewed upgrade PR that preserves non-Codex settings. Malformed policy is a
hard error.

Production records privacy-minimal invocation telemetry in a separate
permission-restricted SQLite database below
`$XDG_STATE_HOME/prtisan/repositories/<repository-key>/telemetry`. It stores the
role, exact profile, token counts, calculated credits, agent duration, retry
count, cache use, and terminal outcome. It never stores prompts, source paths,
findings, output, or patches.

All roles initially retain Sol-medium. A cheaper profile may replace it only
after a maintainer approves a frozen-corpus report that passes every quality and
latency gate.

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

Model evaluation is a maintainer-only development command and is not part of the
published `prtisan` CLI:

```text
bun run eval:models validate-corpus
bun run eval:models run --cap 5000
bun run eval:models report --output evals/model-routing/latest-report.json
```

The combined 105-case corpus and private raw artifacts live below
`$XDG_DATA_HOME/prtisan/model-evaluation` with restrictive permissions. The
SQLite run journal lives below `$XDG_STATE_HOME/prtisan/model-evaluation`.
`report` emits redacted JSON and Markdown aggregates suitable for review. When
only the rate card changes, rerun `report` to reprice stored token measurements;
do not rerun model calls.

See [the full documentation](docs/index.md) and
[ADR 0008](docs/adr/0008-fixed-agent-role-model-profiles.md).
