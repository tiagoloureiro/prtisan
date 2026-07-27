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
A valid schema-v1 manifest also produces this setup checkpoint; the reviewed PR
preserves all non-Codex policy while replacing legacy review/repair settings
with the seven schema-v2 role profiles. Malformed manifests fail closed.

Authenticate Codex into the dedicated global home once (never into the target
repository):

```text
CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/prtisan/codex-home" codex login
```

## Advanced planning and recovery

```text
prtisan plan --cwd /path/to/repo
prtisan apply <plan-id>
prtisan status <plan-id>
prtisan export <plan-id>
```

Planning reads every open PR, including drafts. It accepts independent roots and
single-parent chains. Cycles and multi-parent joins are invalid. Each attempt
freezes head/base SHAs, intent, base policy, required checks, reviews, runtime,
and Codex configuration. An external edit that changes this authority makes the
plan stale.

Applying acquires one recoverable repository lease. Every GitHub or Git mutation
is preceded by journaled intent and an idempotency key, then followed by a
journaled result. Re-running the same plan resumes effects without duplicate
commits, comments, draft promotions, retargets, or merges.

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
heuristics cannot alter effort. Production does not benchmark, route
dynamically, run canaries, or rewrite repository policy.

All generated profiles initially use `gpt-5.6-sol` with medium effort. A
maintainer may promote a cheaper profile only from an approved benchmark report.
See the [model-routing methodology](model-routing-methodology.md) and
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
- Privacy-minimal agent telemetry:
  `$XDG_STATE_HOME/prtisan/repositories/<repository-key>/telemetry`
- Artifacts and caches: `$XDG_DATA_HOME/prtisan`
- Dedicated Codex home: `$XDG_DATA_HOME/prtisan/codex-home`

Exports are redacted and content-addressed. Target repositories contain only the
tracked manifest and Dockerfile, never credentials or execution records.
Telemetry stores only role/profile, tokens, calculated credits, duration,
retries, cache use, and terminal outcome. Prompts, repository paths, source,
findings, outputs, and patches are structurally absent.

## Maintainer model evaluation

The benchmark is available only from the source tree:

```text
bun run eval:models validate-corpus
bun run eval:models run --cap 5000
bun run eval:models report --output evals/model-routing/latest-report.json
```

The command validates the frozen 105-case shape, resumes idempotently from its
SQLite journal, runs profiles serially under a P99 credit reserve, and writes
raw private artifacts under XDG data with `0600` permissions. Redacted reports
contain sample counts, quality intervals, hard failures, token mix, credits,
agent/end-to-end latency, rejected profiles, and one recommendation per role.
Rate-only changes require only `report`, which reprices stored tokens.

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
