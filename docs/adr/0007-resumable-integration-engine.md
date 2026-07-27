# ADR 0007: Rebuild Prtisan as a Resumable Integration Engine

Status: accepted; supersedes ADRs 0001–0006 where they conflict.

## Context

The former coordinator chain reacted to each validation, CI, and merge failure
locally. This produced repair oscillation, repo-local state, synthetic branches,
and feature-branch workarounds for infrastructure failures. A four-day attempt
to merge Titally PR 117 demonstrated that local progress was not convergence.

## Decision

Expose one deep workflow interface: plan, apply/resume, status, and export.
Freeze the whole open train and its authority in an immutable plan. Record
external-effect intent and result in an append-only XDG journal. Keep GitHub,
Git publication, Sandcastle, clock, artifact, and journal behavior behind
adapters.

Codex may diagnose and repair only inside a pinned Docker Sandcastle and only
against a frozen intent contract. Ordinary repairs are additive. Required
checks and human approval remain external gates. Squash merges preserve a
successful prefix; direct children are reconstructed and published only with
exact force-with-lease guards.

## Consequences

Old CLI commands, `.sandcastle` configuration, run records, synthetic bases,
issue sweeps, branch deletion, repeated comments, and the mutating TUI are not
supported. Interrupted work resumes by plan ID. Infrastructure and ambiguity
become explicit checkpoints instead of speculative branch mutations.
