# Prtisan Documentation

Prtisan is the project repository for `agent-train`, a local Bun CLI that helps a developer validate, repair, and merge a GitHub-native train of pull requests with Codex agents running in Sandcastle Docker sandboxes.

Canonical links:

- HTML documentation: <https://tiagoloureiro.github.io/prtisan/>
- Markdown documentation: <https://github.com/tiagoloureiro/prtisan/blob/main/docs/index.md>
- Raw Markdown for agents: <https://raw.githubusercontent.com/tiagoloureiro/prtisan/main/docs/index.md>

## What Prtisan Does

`agent-train` treats GitHub as the source of truth for work in progress. It reads open pull requests, linked closing issues, branch relationships, issue dependencies, review state, and status checks directly from GitHub. It then uses local Codex agents to review implementation branches against repository standards and issue specs, optionally repair blocking gaps, and merge the train in dependency order.

The workflow is intentionally local-first. It needs Docker, Git worktrees, GitHub CLI, Sandcastle, and Codex CLI subscription authentication. Running this from a trusted workstation or private runner keeps Codex credentials and branch mutations under the user's control.

## Requirements

- Bun for development and normal CLI execution.
- Git and a target repository checkout.
- Docker for Sandcastle agent containers.
- GitHub CLI 2.94 or newer, authenticated for the target repository.
- Codex CLI available on the host.
- A dedicated Codex home under `.sandcastle/codex-home`, authenticated with `codex login`.
- A target repository with `.sandcastle/agent-train.config.json`, or commands run with `--repo OWNER/REPO`.

## Init

Run init from this checkout during local development:

```bash
bun run init --cwd /path/to/repo
```

After building and linking the binary, use:

```bash
agent-train init --cwd /path/to/repo
```

For a GitHub-backed git repository, `init`:

- Detects the GitHub repository and default branch through `gh repo view`.
- Builds the scaffold in a temporary worktree based on the current target branch.
- Pushes the setup branch, defaulting to `agent-train/setup`.
- Creates or reuses the setup issue marked with `agent-train:init`.
- Opens or updates the setup PR against the target branch.

For a non-git directory, or a git repository not connected to GitHub through `gh`, `init` writes the scaffold files directly into the target directory.

Generated files:

- `.sandcastle/agent-train.config.json` stores repo, target branch, remote, model, reasoning, concurrency, Docker, mount, and retention settings.
- `.sandcastle/Dockerfile` defines the Sandcastle agent image with Bun, Git, GitHub CLI, and Codex CLI.
- `.gitignore` receives Agent PR Train runtime ignores for `.sandcastle/.env`, Codex home, runs, worktrees, logs, and patches.

## Configuration

The default config targets `origin`, keeps runtime state under `.sandcastle`, and uses bounded concurrency for validation and GitHub API operations. Review and repair models, reasoning effort, Docker image name, CPU budget, extra mounts, and retention policy can all be edited in `.sandcastle/agent-train.config.json`.

If the config still contains `OWNER/REPO`, update it before running validation or pass `--repo OWNER/REPO` to commands that support it.

## GitHub Issue And PR Conventions

- Each implementation PR should close or clearly reference the GitHub issue that defines its expected behavior.
- Issue bodies should contain enough acceptance criteria for an agent to decide whether the target branch or PR satisfies the spec.
- Use GitHub native issue dependencies for blocked-by and blocking relationships.
- Branch relationships are also part of the dependency graph: a PR based on another open PR branch depends on that PR.
- Draft PRs stay in the graph, but `merge` stops before merging draft, not-ready, or blocking-validation PRs.
- PRs without linked closing issues still receive a Standards review; Spec review is skipped because there is no authoritative issue text.

## Validate

Run:

```bash
agent-train validate --cwd /path/to/repo --repo OWNER/REPO
```

`validate` loads all open pull requests, including drafts. It derives dependencies from PR base/head branch relationships, then enriches that graph with linked issue dependencies. For every selected PR it runs a Standards review, and when a closing issue is present it also runs a Spec review against the issue and directly related issues.

By default, validation repairs blocking PR findings when possible and posts a GitHub PR review with the validation marker. It also checks open issues against the target branch, comments with the result, and can create or update an `agent-train/repair/issue-N` PR when the target branch has blocking gaps and there is no associated open PR.

Use `--no-repair` when validation should report findings without letting repair agents commit changes.

## Merge

Run:

```bash
agent-train merge --cwd /path/to/repo --repo OWNER/REPO
```

`merge` reloads open pull requests from GitHub, processes them in topological order, and stops before a PR that is draft, not ready, missing green checks, or blocked by a validation review. Ready PRs are squash-merged with a head-SHA guard so the command does not merge a branch that changed underneath it.

After each squash merge, affected descendants are restacked and validation is rerun for the impacted part of the train. For PRs that depend on multiple blockers, Agent PR Train may create synthetic base branches so GitHub's single-base-branch PR model can still represent a DAG-shaped dependency graph.

## Codex And Sandcastle Setup

Seed the dedicated Codex home once in the target repository:

```bash
mkdir -p .sandcastle/codex-home
CODEX_HOME="$PWD/.sandcastle/codex-home" codex login
```

Build the sandbox image:

```bash
docker build -t sandcastle:agent-train -f .sandcastle/Dockerfile .
```

Do not mount your full personal `~/.codex` into agent containers. The dedicated `.sandcastle/codex-home` keeps unrelated auth, logs, and sessions out of the sandbox.

## Troubleshooting

- `Missing agent train config`: run `agent-train init`, fix `.sandcastle/agent-train.config.json`, or pass `--repo OWNER/REPO`.
- GitHub issue dependency field errors: upgrade GitHub CLI to 2.94 or newer and confirm repository permissions can read issue dependency metadata.
- Missing `CODEX_HOME`: create `.sandcastle/codex-home` and authenticate it with `codex login`.
- Docker image not found: rebuild with `docker build -t sandcastle:agent-train -f .sandcastle/Dockerfile .`.
- Setup branch looks stale: rerun `agent-train init`; the setup branch is rebuilt from the target branch and pushed with `--force-with-lease`.
- Validation is too aggressive: run `agent-train validate --no-repair` to collect review output without repair commits.

## Development

From this repository:

```bash
bun install
bun run typecheck
bun test
```

The release workflow builds and publishes a tarball when a semver tag is pushed. The Pages workflow publishes this `docs/` directory as the public documentation site.
