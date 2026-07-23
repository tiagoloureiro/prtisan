# Agent PR Train

## Language

### Core concepts

Agent PR Train CLI: A local Bun TypeScript command-line tool that coordinates issue implementation, validation, and merging across a dependent set of GitHub pull requests. Avoid: "GitHub workflow" when that could mean GitHub Actions.

Train: A single orchestration run over a selected issue dependency graph. The train owns branch names, PR mappings, validation state, and merge order.

Frontier: The set of issues whose blocking issue branches already exist and can be worked on in parallel.

Issue branch: The branch where one Codex agent implements one GitHub issue.

Synthetic base branch: A generated branch that merges multiple blocker branches so a dependent issue can have one GitHub PR base while still depending on several prior PRs.

Validation pass: A review run that checks a PR against repository standards and the related issue context.

Repair pass: A Codex run on an existing issue branch that attempts to fix blocking validation findings before the tool posts remaining comments.
