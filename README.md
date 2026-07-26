# Agent PR Train

`agent-train` is a local Bun-first CLI for validating and merging a GitHub-native stack of open pull requests through Codex CLI agents, Sandcastle Docker sandboxes, and guarded squash merges.

Canonical documentation is available as a [GitHub Pages site](https://tiagoloureiro.github.io/prtisan/) and as [agent-readable Markdown](docs/index.md).

## Commands

```bash
bun run init --cwd /path/to/repo
bun run validate --cwd /path/to/repo --repo owner/repo
bun run merge --cwd /path/to/repo --repo owner/repo
bun run tui --cwd /path/to/repo --repo owner/repo
```

Bare `bun init` is Bun's package initializer, so `agent-train` uses package scripts for local development. After `bun run build`, the binary entrypoint is `agent-train init`, `agent-train validate`, `agent-train merge`, and `agent-train tui`.

`init` creates the target repo scaffold:

- GitHub git repo: writes the files in a temporary worktree, pushes `agent-train/setup`, creates or reuses a setup issue, and opens or updates the matching PR.
- Non-git repo, or a repo not connected to GitHub through `gh`: writes the files directly into the target directory.

`validate` defaults to open PRs only, including drafts. It derives dependencies from PR base/head branch relationships plus linked closing issue dependencies, runs Standards review for every PR, runs Spec review only when a closing issue exists, optionally repairs blocking findings, and posts a versioned GitHub review marker tied to the immutable head/base/runtime/issue snapshot. Use `--scope issues` for an explicit target-branch issue sweep or `--scope all` for both; issues already represented by an open PR are excluded.

`merge` reloads all open PRs from GitHub, processes them in topological order, marks draft PRs ready when it reaches them, validates or revalidates the current PR when needed, attempts CI and merge-state repair, squash-merges only after GitHub is green/mergeable with `--match-head-commit`, restacks descendants, and revalidates affected PRs.

`tui` opens an interactive terminal dashboard for the same train. It shows preflight status, open PR layers, validation state, blockers, and a live log. Validate and merge actions require explicit confirmation because they can mutate branches and GitHub state. In non-interactive terminals, use `validate` or `merge` directly.

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
```

`agent-train validate` and `agent-train merge` build the configured Sandcastle
Docker image from `.sandcastle/Dockerfile` when it is missing.

Target repositories are also checked for exact runtime declarations such as
`.tool-versions`, mise files, `.node-version`, `.nvmrc`, `packageManager`,
`engines`, and lockfiles. Conflicting or non-exact declarations fail closed.
Repairs run in an ephemeral branch, pass independent host verification, and are
published with an exact force-with-lease only if the PR snapshot is still
current.

## Development

```bash
bun install
bun run typecheck
bun test
```
