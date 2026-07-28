# Prtisan Documentation

[Raw Markdown for agents](https://raw.githubusercontent.com/tiagoloureiro/prtisan/main/docs/index.md)

Prtisan treats a repository's complete open pull-request train as one resumable
integration workflow. GitHub remains the source of pull requests, review
decisions, required checks, and branch state. The local append-only journal is
the source of execution intent and effect history.

## Run a train

```text
prtisan run --cwd /path/to/repo
```

This is the normal interface. It creates or resumes the repository's latest
frozen plan and applies it. At a durable checkpoint it exits with a concise
blocker and prints the exact same `run` command needed to resume. Add `--json`
for structured automation output. Exit status is `0` for completion, `2` for a
durable checkpoint, and `1` for invalid input or infrastructure failure.

On first use, `run` pushes `prtisan/setup` and creates or reuses a
human-reviewed setup PR. The PR adds:

- `.prtisan/manifest.json`, containing schema version, target branch, pinned
  Docker build definition, named verification commands and timeouts, structured
  PR-body contract headings, Codex settings, and resource limits.
- `.prtisan/Dockerfile`, defining the Sandcastle environment.

Prtisan never merges the setup PR. After a human merges it, rerun the same
command. Repeated onboarding does not create duplicate setup PRs or commits.
Existing pull requests whose base commits predate setup are planned with the
reviewed target-branch manifest and do not require manual rebasing.
A valid schema-v1 manifest also produces this setup checkpoint; the reviewed PR
preserves all non-Codex policy while replacing legacy review/repair settings
with the seven schema-v2 role profiles. Malformed manifests fail closed.

In an interactive terminal, `run` starts the one-time Codex device login against
its dedicated global home, waits for authorization, verifies those credentials
inside the managed container, and continues the same invocation. For
non-interactive and `--json` runs, authentication is a `waiting_external`
checkpoint containing this fallback command:

```text
CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/prtisan/codex-home" codex login --device-auth
```

Prtisan never copies or mounts the operator's normal Codex credentials.

## Projects, Conversations, and cleanup

```text
prtisan tui [--cwd /path/to/repo]
```

The TUI is a global, reconnectable agent interface backed by an on-demand local
Worker. Projects are canonical local Git checkouts. Each Project keeps durable
multi-turn Conversations whose agents edit isolated Docker worktrees, produce
one checkpoint commit per successful turn, and can publish at most one pull
request after explicit confirmation. Later turns require another confirmed
Publish to push their checkpoints to that existing pull request. Attachments
are captured by Prtisan and mounted read-only into the Conversation container.

Turns are durable FIFO jobs within a Conversation. Different Conversations may
run concurrently up to the global limit, and queued Turns resume after a Worker
restart.

Any local Git repository can be registered. Docker, GitHub, authentication, and
Prtisan setup are separate capabilities whose absence disables only the
affected action.

```text
prtisan cleanup --cwd /path/to/repo
prtisan cleanup --all --dry-run
```

Cleanup previews containers, images, worktrees, caches, logs, and reclaimable
sessions. It removes only resources whose Prtisan ownership can be proven and
revalidates each target immediately before deletion. It never performs
machine-wide Docker pruning and preserves active, dirty, shared, external,
unlabelled, or unpublished resources. Execution uses a short-lived, one-use
Worker authorization and can remove only candidates present in the reviewed
preview.

## Advanced planning and recovery

```text
prtisan plan --cwd /path/to/repo
prtisan apply <plan-id>
prtisan status <plan-id>
prtisan export <plan-id>
```

Planning reads every open PR, including drafts. It accepts independent roots and
single-parent chains. Cycles and multi-parent joins are invalid. Each plan
freezes the reviewed target-branch manifest and runtime; each attempt freezes
head/base SHAs, intent, base standards, required checks, and reviews. An
external edit that changes this authority makes the plan stale.

Applying acquires one recoverable repository lease whose owner includes the
local process ID. A later invocation immediately reclaims leases left by dead
processes or older UUID-only versions. A genuinely live concurrent invocation
produces a `waiting_external` checkpoint with its PID and the normal resume
command. Every GitHub or Git mutation is preceded by journaled intent and an
idempotency key, then followed by a journaled result. Re-running the same plan
resumes effects without duplicate commits, comments, draft promotions,
retargets, or merges.

`run` selects the newest journaled plan for the canonical repository. It resumes
checkpointed and partially completed plans, creates fresh authority after a
completed train, and replaces a stale plan under the authority of the current
explicit invocation. It never resets an unchanged exhausted repair attempt.

## Review, repair, and gates

For a contracted PR, Prtisan separates:

1. read-only diagnosis with cause, evidence, contract mapping, scope, and
   expected verification;
2. deterministic authorization against the frozen contract;
3. a fresh scoped Codex repair session;
4. declared verification and contract-backed re-review.

All four phases execute in Docker Sandcastle. Ordinary repairs are fast-forward
commits against the exact observed head. A PR gets at most three published
candidates and one unchanged root cause gets at most two. CI runner failures,
credentials, GitHub outages, and policy/governance gates produce checkpoints;
they do not authorize edits to feature branches.

Human approval and required GitHub checks cannot be bypassed. Drafts are marked
ready only while their planned snapshot and prerequisites remain current.

## Agent roles and model profiles

Every Codex invocation is assigned exactly one role:
`standardsReview`, `specReview`, `repairVerification`, `validationRepair`,
`ciRepair`, `mergeStateRepair`, or `restackConflictRepair`.

`.prtisan/manifest.json` schema v2 maps every role to a fixed
`{ model, reasoningEffort }` profile under `codex.roles`. The exact role and
profile participate in validation-policy digests and review-cache keys. Prtisan
passes both values explicitly to Sandcastle; changed filenames and other runtime
heuristics cannot alter effort. Production does not route dynamically, run
canaries, or rewrite repository policy.

Generated policy uses Sol-medium for standards review, specification review,
validation repair, and merge-state repair; Terra-medium for repair verification
and CI repair; and Sol-high for restack conflict repair. Existing schema-v2
manifests remain authoritative. See
[ADR 0008](adr/0008-fixed-agent-role-model-profiles.md).

## Merge and restack

Prtisan revalidates the exact attempt immediately before squash merge and sends
GitHub the expected head SHA. It never deletes the merged branch. After a parent
squash, each direct child is reconstructed from only its unique commits onto the
new base, verified in Sandcastle, published with exact force-with-lease guards,
retargeted, and assigned a new validation attempt. Ambiguous conflicts require
human input.

One `prtisan:summary` comment per PR is updated in place with plan ID, snapshot,
state, blockers, and evidence.

## Durable state and credentials

- Journal and leases: `$XDG_STATE_HOME/prtisan`
- Projects, Conversations, proposals, and Worker jobs:
  `$XDG_STATE_HOME/prtisan/control.sqlite`
- Artifacts and caches: `$XDG_DATA_HOME/prtisan`
- Dedicated Codex home: `$XDG_DATA_HOME/prtisan/codex-home`
- Global TUI and Worker defaults: `$XDG_CONFIG_HOME/prtisan/config.json`

Exports are redacted and content-addressed. Target repositories contain only the
tracked manifest and Dockerfile, never credentials or execution records.

When developing Prtisan, `bun run src/index.ts ...` executes source directly.
The globally linked `prtisan` command executes `dist/index.js`; run
`bun run link-bin` after source changes to rebuild and refresh it.

## GitHub Issue And PR Conventions

An intent contract comes from the primary linked closing issue, or from every
heading named in `contract.prBodySections`. Without one, Codex specification
findings cannot block or authorize repair. Repository rules, deterministic
verification, checks, and human review remain authoritative.

## Outcomes

`completed`, `partially_completed`, `stale`, `waiting_external`,
`needs_human`, `repair_exhausted`, `invalid_plan`, and
`infrastructure_failed` are durable outcomes. `run` prints its exact resume
command for every checkpoint. `status` and `apply <plan-id>` remain available
for manual inspection and recovery.
