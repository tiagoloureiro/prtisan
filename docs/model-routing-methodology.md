# Model-routing benchmark methodology

## Scope and invariants

This benchmark is a maintainer-only development system. It recommends a
repository policy; it never changes production routing or rewrites a manifest.
Prompts, tools, the Docker image, code-review skill, repository commits, and
verification commands are pinned across profiles. One maintainer authors and
freezes gold labels before candidate output is revealed.

The corpus has 105 cases: 15 for each of seven agent roles. Every role contains
three cases from each of `prtisan`, `titally`, `titance`, `titect`, and
`titrain`: one screening case and two hidden holdouts. Historical cases are
preferred; seeded defects or conflicts use controlled patches and frozen
digests.

The combined corpus, private gold, raw outputs, and patches stay under
`$XDG_DATA_HOME/prtisan/model-evaluation` with `0600` file permissions. Public
schemas, scoring, public Prtisan cases, corpus digests, and redacted aggregates
may be committed.

## Candidates and staged execution

The serial tournament has a 5,000-credit soft cap:

1. Screen Sol, Terra, Luna, and GPT-5.4 Mini at low and medium effort.
2. Advance Sol-medium plus at most three cheaper non-dominated profiles per
   role.
3. Run holdouts, then rerun the cheapest qualifying finalist and Sol-medium.
   If the finalist fails, try the next-cheapest candidate.
4. When no lower-effort candidate qualifies, test high effort for at most the
   two cheaper models with the strongest medium-effort quality.
5. Before scheduling a case, reserve a conservative observed per-role P99 cost.
   Stop if the remaining budget cannot cover it and report any unavoidable
   final-run overshoot.
6. Retain Sol-medium whenever evidence is incomplete.

`bun run eval:models run` is resumable: the SQLite primary key is the run, case,
profile, and replicate. Pre-agent infrastructure failure is retried once and is
excluded from quality. Completed structured-output attempts, including retries,
remain part of token spend.

## Quality scoring and hard failures

Review roles score 70% blocking-finding F1, 10% advisory F1, and 20%
evidence/rule/contract attribution. Repair verification scores 80%
resolved/unresolved macro F1 and 20% new-blocker F1. Mutation roles score either
100 or zero and require the intended cause to be addressed, declared
verification to pass, allowed scope to be respected, and gates to remain
intact.

Malformed structured output scores zero. A critical blocker miss, false
approval of an unresolved critical finding, unauthorized mutation, gate
weakening, or verification regression disqualifies the profile.

## Promotion gate

Candidate and Sol-medium results are paired by holdout case and replicate. A
candidate qualifies only when all hard invariants pass and:

- a fixed-seed 10,000-sample paired bootstrap has a 95% lower confidence bound
  of at least -2 quality points;
- paired median agent duration is no slower than Sol-medium;
- candidate p95 agent duration is at most 110% of Sol-medium; and
- token usage is available and the model has a pinned rate.

Among qualifying profiles, the lowest median Codex-credit cost wins; median
agent latency breaks ties. Credits are:

```text
uncached input × input rate
  + cached input × cached rate
  + output × output rate
```

Rates are per million tokens. The versioned card pins Sol at
125/12.5/750, Terra at 62.5/6.25/375, Luna at 25/2.5/150, and GPT-5.4 Mini
at 18.75/1.875/113 input/cached/output credits. Missing usage or an unpriced
model is unavailable, never zero.

## Commands and reevaluation

```text
bun run eval:models validate-corpus
bun run eval:models run --cap 5000
bun run eval:models report --output evals/model-routing/latest-report.json
```

The report contains only redacted aggregates: samples, quality deltas and
intervals, hard failures, token mix, total/median/p95 credits, agent and
end-to-end latency, rejections, and recommendations.

Reevaluate only after an explicit model, prompt, skill, role schema, runtime, or
evaluation-policy change. When only rates change, rerun `report`; it reprices
stored token measurements without changing validation identity or invoking a
model.
