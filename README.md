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

## Interactive Projects and Conversations

```text
prtisan tui [--cwd /path/to/repo]
```

The TUI is a global, reconnectable agent interface. It lists registered local
Git Projects, keeps persistent multi-turn Conversations, streams agent activity,
shows Run history and blockers, and exposes setup, policy, publication, export,
and cleanup actions. Any local Git repository can be added; unavailable Docker,
GitHub, authentication, or setup capabilities are shown as action blockers.

Each Conversation freezes a base commit and model profile, then edits an
isolated Prtisan branch/worktree inside Docker. Successful turns create
checkpoint commits. Captured attachments are mounted read-only into the agent
container. Publication pushes that branch and opens one pull request; later
turns remain local until another confirmed Publish updates the same pull
request.

An on-demand per-user Worker owns durable queued turns and mutations. Turns run
FIFO within one Conversation while separate Conversations can run concurrently;
queued Turns survive a Worker restart. The Worker exits automatically after its
idle timeout.

## Safe cleanup

```text
prtisan cleanup --cwd /path/to/repo
prtisan cleanup --all
prtisan cleanup --all --only images --only caches --dry-run
prtisan cleanup --all --yes --json
```

Cleanup previews all safe disposable categories by default: containers, images,
worktrees, caches, logs, and reclaimable sessions. It deletes only resources
whose Prtisan ownership can be proven and rechecks them immediately before
removal. Confirmation authorizes only the exact reviewed candidate set through
a short-lived, one-use Worker authorization. Active or dirty workspaces,
external or unlabelled Docker resources, history, evidence, configuration,
credentials, and unpublished work are always preserved and reported.
Non-interactive deletion requires `--yes`.

The setup PR contains `.prtisan/manifest.json` and `.prtisan/Dockerfile`; a
human must review and merge it. `plan` is read-only and persists an immutable
snapshot. `apply` executes or resumes that snapshot idempotently. `status`
explains the durable checkpoint and next action. `export` writes redacted,
content-addressed evidence.

Existing pull requests do not need to be rebased onto the setup commit.
After the setup PR merges, `run` applies the reviewed target-branch policy to
the complete open train, including pull requests whose base commits predate
Prtisan.

`run` also owns the one-time Codex authentication step. In an interactive
terminal it starts `codex login --device-auth` against Prtisan's dedicated
Codex home, waits for authorization, verifies the same credentials inside the
managed container, and continues the train in the same invocation.
Non-interactive and `--json` runs return a credentials checkpoint with the exact
fallback command:

```text
CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/prtisan/codex-home" codex login --device-auth
```

Prtisan never copies or mounts credentials from the operator's normal Codex
home.

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
        "model": "gpt-5.6-terra",
        "reasoningEffort": "medium"
      },
      "validationRepair": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      },
      "ciRepair": { "model": "gpt-5.6-terra", "reasoningEffort": "medium" },
      "mergeStateRepair": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "medium"
      },
      "restackConflictRepair": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "high"
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

Generated policy favors quality first, runtime second, and cost third. Sol-medium
handles reviews, validation repair, and merge-state repair; Terra-medium handles
the narrower repair-verification and CI-repair loops; restack conflict repair
uses Sol-high. Existing schema-v2 manifests remain authoritative and are never
rewritten automatically.

## Safety model

- The whole open train is the unit of authority. Roots and single-parent stacks
  are supported; cycles and multi-parent joins fail before mutation.
- Repository policy and runtime are frozen from the reviewed target-branch
  snapshot. PR code, standards, checks, review state, and intent contracts
  remain pinned to each PR snapshot. Policy changes apply only after merge.
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
- Mutable Project, Conversation, proposal, and job state lives in a separate
  control database under `$XDG_STATE_HOME/prtisan`; global UI/worker defaults
  live under `$XDG_CONFIG_HOME/prtisan`.

## Development

```text
bun install
bun run typecheck
bun test
bun run build
```

`bun run src/index.ts ...` executes the current TypeScript source and does not
need a build. The globally installed `prtisan` command executes `dist/index.js`;
after changing source, run `bun run link-bin` once to rebuild and refresh that
linked command.

See [the full documentation](docs/index.md) and
[ADR 0008](docs/adr/0008-fixed-agent-role-model-profiles.md).
