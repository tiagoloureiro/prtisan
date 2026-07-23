# Agent PR Train

## Language

### Core concepts

Agent PR Train CLI: A local Bun TypeScript command-line tool that validates and merges a dependent set of GitHub pull requests. Avoid: "GitHub workflow" when that could mean GitHub Actions.

Open PR graph: The live dependency graph derived from all open GitHub PRs, including drafts. It is rebuilt from GitHub every run.

Train: The ordered set of open PRs that should merge together. The train does not have a local id or state file; GitHub PRs, branches, reviews, checks, and linked issues are the source of truth.

Setup scaffold: The minimal target-repository files needed before validation or merge can run: `.sandcastle/agent-train.config.json`, `.sandcastle/Dockerfile`, and gitignore rules for local auth, logs, and worktrees.

Frontier: The set of PRs whose blocker PRs have already merged or are otherwise absent from the current open PR graph.

PR branch: The GitHub pull request head branch that Codex may validate, repair, rebase, and push.

Synthetic base branch: A generated branch named from the dependent PR number that merges multiple open blocker branches so a dependent PR can have one GitHub PR base while still depending on several prior PRs.

Validation pass: A review run that checks a PR against repository standards and the related issue context.

Repair pass: A Codex run on an existing PR branch that attempts to fix blocking validation findings before the tool posts remaining comments.
