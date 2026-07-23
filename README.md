# Agent PR Train

`agent-train` is a local Bun-first CLI for validating and merging a GitHub-native stack of open pull requests through Codex CLI agents, Sandcastle Docker sandboxes, and guarded squash merges.

Canonical documentation is available as a [GitHub Pages site](https://tiagoloureiro.github.io/prtisan/) and as [agent-readable Markdown](docs/index.md).

## Commands

```bash
bun run init --cwd /path/to/repo
bun run validate --cwd /path/to/repo --repo owner/repo
bun run merge --cwd /path/to/repo --repo owner/repo
```

Bare `bun init` is Bun's package initializer, so `agent-train` uses package scripts for local development. After `bun run build`, the binary entrypoint is `agent-train init`, `agent-train validate`, and `agent-train merge`.

`init` creates the target repo scaffold:

- GitHub git repo: writes the files in a temporary worktree, pushes `agent-train/setup`, creates or reuses a setup issue, and opens or updates the matching PR.
- Non-git repo, or a repo not connected to GitHub through `gh`: writes the files directly into the target directory.

`validate` loads all open PRs in the repo, including drafts. It derives dependencies from PR base/head branch relationships plus linked closing issue dependencies, runs Standards review for every PR, runs Spec review only when a closing issue exists, optionally repairs blocking PR findings, and posts a GitHub PR review. It also loads all open issues, validates the target branch against each issue's spec, posts issue comments with the main-branch result, and creates or updates an `agent-train/repair/issue-N` PR when the target branch has blocking gaps and no associated PR is open.

`merge` reloads all open PRs from GitHub, processes them in topological order, stops on draft/not-ready/blocking-validation PRs, squash-merges with `--match-head-commit`, restacks descendants, and revalidates affected PRs.

## Requirements

- Bun for normal operation
- GitHub CLI 2.94+
- Docker
- Git
- Codex CLI
- A target repository with `.sandcastle/agent-train.config.json`, or pass `--repo owner/repo`

## Install the Binary

For local development from this checkout:

```bash
bun install
bun run link-bin
agent-train --help
```

This builds `dist/index.js` and links the package globally with Bun. If `agent-train` is not found afterward, make sure Bun's global bin directory is on your `PATH`:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

To stop using the linked binary:

```bash
bun unlink
```

## GitHub Releases

Pushing a semver tag creates a GitHub Release containing:

- `agent-train-<version>.tgz`
- `SHA256SUMS`

```bash
git tag v0.1.0
git push origin v0.1.0
```

For a public release, install the binary package with Bun:

```bash
bun install --global https://github.com/<owner>/<repo>/releases/download/v0.1.0/agent-train-0.1.0.tgz
agent-train --help
```

For a private repo, download the release asset with `gh` first:

```bash
mkdir -p /tmp/agent-train-release
gh release download v0.1.0 --repo <owner>/<repo> --pattern 'agent-train-*.tgz' --dir /tmp/agent-train-release
bun install --global /tmp/agent-train-release/agent-train-0.1.0.tgz
agent-train --help
```

Use a dedicated `.sandcastle/codex-home` and seed it with Codex authentication before running agents. Do not mount your full `~/.codex` into the sandbox.

```bash
mkdir -p .sandcastle/codex-home
CODEX_HOME="$PWD/.sandcastle/codex-home" codex login
docker build -t sandcastle:agent-train -f .sandcastle/Dockerfile .
```

## Development

```bash
bun install
bun run typecheck
bun test
```
