# ADR 0008: Repository-owned fixed agent-role model profiles

Date: 2026-07-27

Status: Accepted

## Context

Prtisan previously grouped Codex work into broad `review` and `repair` model
buckets, with a filename-based review-effort override. Those buckets hid
materially different responsibilities and made cost, quality, and latency
tradeoffs difficult to measure or reproduce. A production heuristic could also
make the same frozen validation snapshot run with a different effort.

Model and rate-card changes are inevitable, but repository policy must remain
reviewable and validation must remain deterministic. Benchmark prompts, source,
gold labels, and outputs from private repositories must not leak into the target
repository or public reports.

## Decision

Prtisan defines exactly seven agent roles:

- `standardsReview`
- `specReview`
- `repairVerification`
- `validationRepair`
- `ciRepair`
- `mergeStateRepair`
- `restackConflictRepair`

Manifest schema v2 maps each role to one fixed `{ model, reasoningEffort }`
profile. Every Sandcastle invocation explicitly receives its role's exact
profile. The role and profile are part of validation-policy and review-cache
identity. Rate-card versions are reporting inputs and do not affect validation
identity.

Production never chooses profiles dynamically, runs canaries, or writes policy
from telemetry. Valid schema-v1 policy produces a reviewed setup migration;
malformed policy remains an error. Generated schema-v2 policy initially assigns
Sol-medium to every role.

A maintainer-only staged tournament may recommend a different profile. It uses
a frozen 105-case corpus, pre-authored gold labels, hard disqualification rules,
a fixed-seed paired bootstrap, latency gates, and lowest median Codex-credit
cost. Inconclusive evidence retains Sol-medium. Updating a repository manifest
is a separate human-reviewed setup PR.

Production telemetry is written to a separate `0600` XDG SQLite database and is
limited to role/profile, token counts, calculated credits, agent duration,
retry count, cache use, and terminal outcome. It structurally excludes prompts,
paths, source, findings, outputs, and patches.

## Consequences

- Production routing is explicit, exhaustive, and reproducible.
- Model changes invalidate the right policy/cache identities; rate-only changes
  can reprice stored observations without rerunning models.
- Seven role profiles add manifest verbosity and require reviewed migration.
- A cheaper model cannot be promoted from intuition or aggregate telemetry; it
  must pass the frozen role-specific benchmark.
- Private corpus maintenance and gold adjudication remain a deliberate
  maintainer responsibility.

## References

- [Model-routing methodology](../model-routing-methodology.md)
- [Official Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card.docx)
- [OpenAI model selection guidance](https://developers.openai.com/api/docs/guides/latest-model)
