# ADR 0008: Repository-owned fixed agent-role model profiles

Date: 2026-07-27

Status: Accepted

## Context

Prtisan previously grouped Codex work into broad `review` and `repair` model
buckets, with a filename-based review-effort override. Those buckets hid
materially different responsibilities and made cost, quality, and latency
tradeoffs difficult to measure or reproduce. A production heuristic could also
make the same frozen validation snapshot run with a different effort.

Repository policy must remain reviewable and validation must remain
deterministic. Defaults should favor quality for open-ended judgment and risky
mutations, then reduce runtime and cost for narrow tasks protected by
deterministic checks.

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
identity.

Generated schema-v2 policy uses:

- Sol-medium for standards review, specification review, validation repair, and
  merge-state repair.
- Terra-medium for repair verification and CI repair.
- Sol-high for restack conflict repair.

Production never chooses profiles dynamically, runs canaries, or rewrites
repository policy. Valid schema-v1 policy produces a reviewed setup migration
with these defaults; malformed policy remains an error. Existing schema-v2
manifests remain authoritative until changed through normal repository review.

## Consequences

- Production routing is explicit, exhaustive, and reproducible.
- Model changes invalidate the right policy and review-cache identities.
- Seven role profiles add manifest verbosity and require reviewed migration.
- Default changes affect new setup manifests and reviewed schema-v1 upgrades,
  not repositories that already own schema-v2 policy.
- Repository maintainers may override any role profile explicitly.

## Reference

[OpenAI model selection guidance](https://developers.openai.com/api/docs/guides/latest-model)
