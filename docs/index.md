# Prtisan Documentation

[Raw Markdown for agents](https://raw.githubusercontent.com/tiagoloureiro/prtisan/main/docs/index.md)

Prtisan treats a repository's complete open pull-request train as one resumable
integration workflow. GitHub remains the source of pull requests, review
decisions, required checks, and branch state. The local append-only journal is
the source of execution intent and effect history.

## Onboarding

```text
prtisan init plan --cwd /path/to/repo
prtisan init apply <setup-plan-id>
```

Planning onboarding is read-only. Applying a current setup plan pushes
`prtisan/setup` and opens or updates a human-reviewed setup PR. The PR adds:

- `.prtisan/manifest.json`, containing schema version, target branch, pinned
  Docker build definition, named verification commands and timeouts, structured
  PR-body contract headings, Codex settings, and resource limits.
- `.prtisan/Dockerfile`, defining the Sandcastle environment.

The integration commands refuse to operate until this PR is merged.

Authenticate Codex into the dedicated global home once (never into the target
repository):

```text
CODEX_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/prtisan/codex-home" codex login
```

## Planning and applying

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
- Artifacts and caches: `$XDG_DATA_HOME/prtisan`
- Dedicated Codex home: `$XDG_DATA_HOME/prtisan/codex-home`

Exports are redacted and content-addressed. Target repositories contain only the
tracked manifest and Dockerfile, never credentials or execution records.

## GitHub Issue And PR Conventions

An intent contract comes from the primary linked closing issue, or from every
heading named in `contract.prBodySections`. Without one, Codex specification
findings cannot block or authorize repair. Repository rules, deterministic
verification, checks, and human review remain authoritative.

## Outcomes

`completed`, `partially_completed`, `stale`, `waiting_external`,
`needs_human`, `repair_exhausted`, `invalid_plan`, and
`infrastructure_failed` are durable outcomes. `status` provides the exact next
action; after the external condition is corrected, run `apply` with the same
plan ID.
