# Prtisan

## Language

Prtisan: A local Bun TypeScript command-line tool that advances a complete open
GitHub pull-request train through frozen planning, sandboxed verification,
bounded repair, guarded squash merge, and direct-child restacking.

Run: The primary one-command operation. It creates or reuses repository setup,
selects the newest journaled plan, resumes durable work, or creates fresh
authority after completion or staleness.

Plan: An immutable snapshot of the complete open PR graph and the authority used
to judge it, including head/base SHAs, intent contracts, policy, checks, review
state, runtime, and Codex configuration.

Attempt: A journaled validation and integration lifecycle for one PR snapshot.
Repair counters belong to the attempt and survive process restarts.

Checkpoint: A durable non-success outcome with a blocker and exact next action.
External checks, human approval, ambiguity, credentials, policy, and exhausted
repair become checkpoints rather than speculative branch edits.

Open PR graph: Every open GitHub PR, including drafts. Independent roots and
single-parent stacks are valid; cycles and multi-parent joins are rejected.

Setup PR: The human-reviewed `prtisan/setup` pull request that installs
`.prtisan/manifest.json` and `.prtisan/Dockerfile` on the target branch.

Sandcastle: The pinned Docker environment in which all Codex analysis, editing,
and candidate verification executes. The operator's normal Codex home is never
mounted.

Agent role: One of the seven exhaustive production responsibilities:
`standardsReview`, `specReview`, `repairVerification`, `validationRepair`,
`ciRepair`, `mergeStateRepair`, or `restackConflictRepair`. Every Sandcastle
invocation has exactly one role.

Model profile: A frozen `{ model, reasoningEffort }` pair assigned to one agent
role. The pair is passed explicitly to Codex and is never inferred from a
filename, risk heuristic, canary, or runtime policy.

Routing policy: The repository-owned schema-v2 `codex.roles` map that assigns
one model profile to every agent role. The exact map participates in validation
and review-cache identity.

Evaluation case: A frozen, reproducible role-specific workload with pinned
repository state, prompt/tool/runtime inputs, verification, split, and expected
result. Each role has one screening and two hidden holdout cases per repository.

Gold set: The single-maintainer-authored expected findings, classifications, or
mutation invariants frozen before candidate output is revealed. Gold data for
private repositories stays under XDG data with `0600` permissions.

Managed summary: The single `prtisan:summary` GitHub comment updated in place
with the plan, snapshot, blocker, evidence, and next action.
