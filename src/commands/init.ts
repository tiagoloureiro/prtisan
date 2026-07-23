import type { CommandRunner } from "@/exec.js";
import { mustRun } from "@/exec.js";
import type { GitHubClient, GitHubIssueSummary } from "@/github.js";
import { joinPath } from "@/path.js";
import {
  type ScaffoldResult,
  summarizeScaffold,
  writeScaffoldFiles,
} from "@/scaffold.js";
import type { PullRequest } from "@/types.js";

export interface InitInput {
  readonly cwd: string;
  readonly repo?: string;
  readonly targetBranch?: string;
  readonly branch?: string;
  readonly remote?: string;
  readonly force?: boolean;
}

export interface InitDeps {
  readonly runner: CommandRunner;
  readonly github: GitHubClient;
  readonly log?: (message: string) => void;
}

export interface InitResult {
  readonly mode: "local" | "github";
  readonly root: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly branch?: string;
  readonly scaffold: ScaffoldResult;
  readonly issue?: GitHubIssueSummary;
  readonly pr?: Pick<
    PullRequest,
    "number" | "url" | "headRefName" | "baseRefName"
  >;
  readonly reason?: string;
}

const SETUP_MARKER = "agent-train:init";
const DEFAULT_SETUP_BRANCH = "agent-train/setup";

export async function executeInit(
  input: InitInput,
  deps: InitDeps
): Promise<InitResult> {
  const gitRoot = await detectGitRoot(input.cwd, deps.runner);
  if (!gitRoot) {
    return writeLocalScaffold({
      root: input.cwd,
      repo: input.repo ?? "OWNER/REPO",
      targetBranch: input.targetBranch ?? "main",
      reason: "No git repository was detected.",
      force: input.force,
    });
  }

  const detected = await detectGitHubRepo({
    cwd: gitRoot,
    runner: deps.runner,
    repo: input.repo,
  });
  if (!detected) {
    return writeLocalScaffold({
      root: gitRoot,
      repo: input.repo ?? "OWNER/REPO",
      targetBranch: input.targetBranch ?? "main",
      reason: "The git repository is not connected to GitHub through gh.",
      force: input.force,
    });
  }

  await deps.github.assertReady();
  return createSetupPullRequest(
    {
      root: gitRoot,
      repo: detected.repo,
      targetBranch: input.targetBranch ?? detected.defaultBranch,
      branch: input.branch ?? DEFAULT_SETUP_BRANCH,
      remote: input.remote ?? "origin",
      force: input.force,
    },
    deps
  );
}

async function writeLocalScaffold(input: {
  readonly root: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly reason: string;
  readonly force?: boolean;
}): Promise<InitResult> {
  const scaffold = await writeScaffoldFiles(input.root, {
    repo: input.repo,
    targetBranch: input.targetBranch,
    force: input.force,
  });

  return {
    mode: "local",
    root: input.root,
    repo: input.repo,
    targetBranch: input.targetBranch,
    scaffold,
    reason: input.reason,
  };
}

async function createSetupPullRequest(
  input: {
    readonly root: string;
    readonly repo: string;
    readonly targetBranch: string;
    readonly branch: string;
    readonly remote: string;
    readonly force?: boolean;
  },
  deps: InitDeps
): Promise<InitResult> {
  const tempRoot = joinPath("/tmp", `agent-train-init-${crypto.randomUUID()}`);
  const branchExists = await remoteBranchExists(
    deps.runner,
    input.root,
    input.remote,
    input.branch
  );
  await fetchBranch(
    deps.runner,
    input.root,
    input.remote,
    branchExists ? input.branch : input.targetBranch
  );

  try {
    await mustRun(
      deps.runner,
      "git",
      [
        "worktree",
        "add",
        "--force",
        "--detach",
        tempRoot,
        `${input.remote}/${branchExists ? input.branch : input.targetBranch}`,
      ],
      { cwd: input.root }
    );

    const scaffold = await writeScaffoldFiles(tempRoot, {
      repo: input.repo,
      targetBranch: input.targetBranch,
      force: input.force,
    });
    const changed = await hasGitChanges(deps.runner, tempRoot);

    if (changed) {
      await mustRun(
        deps.runner,
        "git",
        [
          "add",
          ".sandcastle/agent-train.config.json",
          ".sandcastle/Dockerfile",
          ".gitignore",
        ],
        { cwd: tempRoot }
      );
      await mustRun(
        deps.runner,
        "git",
        ["commit", "-m", "Configure Agent PR Train"],
        { cwd: tempRoot }
      );
      await mustRun(
        deps.runner,
        "git",
        [
          "push",
          input.remote,
          `HEAD:refs/heads/${input.branch}`,
          "--force-with-lease",
        ],
        { cwd: tempRoot }
      );
    }

    if (!changed && !branchExists) {
      return {
        mode: "github",
        root: input.root,
        repo: input.repo,
        targetBranch: input.targetBranch,
        branch: input.branch,
        scaffold,
        reason:
          "Scaffold files already exist on the target branch; no setup PR was needed.",
      };
    }

    const issue = await findOrCreateSetupIssue(
      deps.github,
      input.repo,
      scaffold
    );
    const pr = await deps.github.createOrUpdatePullRequest({
      repo: input.repo,
      title: "Configure Agent PR Train",
      body: buildSetupPrBody(issue, scaffold),
      baseBranch: input.targetBranch,
      headBranch: input.branch,
    });

    return {
      mode: "github",
      root: input.root,
      repo: input.repo,
      targetBranch: input.targetBranch,
      branch: input.branch,
      scaffold,
      issue,
      pr: {
        number: pr.number,
        url: pr.url,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
      },
    };
  } finally {
    await deps.runner.run("git", ["worktree", "remove", "--force", tempRoot], {
      cwd: input.root,
    });
    await deps.runner.run("rm", ["-rf", tempRoot]);
  }
}

async function detectGitRoot(
  cwd: string,
  runner: CommandRunner
): Promise<string | undefined> {
  const result = await runner.run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

async function detectGitHubRepo(input: {
  readonly cwd: string;
  readonly runner: CommandRunner;
  readonly repo?: string;
}): Promise<{ repo: string; defaultBranch: string } | undefined> {
  const args = input.repo
    ? ["repo", "view", input.repo, "--json", "nameWithOwner,defaultBranchRef"]
    : ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"];
  const result = await input.runner.run("gh", args, { cwd: input.cwd });
  if (result.exitCode !== 0) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as {
      nameWithOwner?: unknown;
      defaultBranchRef?: { name?: unknown };
    };
    const repo =
      typeof parsed.nameWithOwner === "string"
        ? parsed.nameWithOwner
        : input.repo;
    const defaultBranch =
      typeof parsed.defaultBranchRef?.name === "string"
        ? parsed.defaultBranchRef.name
        : "main";
    return repo ? { repo, defaultBranch } : undefined;
  } catch {
    return undefined;
  }
}

async function remoteBranchExists(
  runner: CommandRunner,
  cwd: string,
  remote: string,
  branch: string
): Promise<boolean> {
  const result = await runner.run(
    "git",
    ["ls-remote", "--exit-code", "--heads", remote, branch],
    { cwd }
  );
  return result.exitCode === 0;
}

async function fetchBranch(
  runner: CommandRunner,
  cwd: string,
  remote: string,
  branch: string
): Promise<void> {
  await mustRun(
    runner,
    "git",
    ["fetch", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd }
  );
}

async function hasGitChanges(
  runner: CommandRunner,
  cwd: string
): Promise<boolean> {
  const result = await mustRun(runner, "git", ["status", "--porcelain"], {
    cwd,
  });
  return result.stdout.trim().length > 0;
}

async function findOrCreateSetupIssue(
  github: GitHubClient,
  repo: string,
  scaffold: ScaffoldResult
): Promise<GitHubIssueSummary> {
  const existing = await github.findIssueByBodyMarker(repo, SETUP_MARKER);
  if (existing) return existing;

  return github.createIssue({
    repo,
    title: "Configure Agent PR Train",
    body: buildSetupIssueBody(scaffold),
  });
}

function buildSetupIssueBody(scaffold: ScaffoldResult): string {
  return [
    `<!-- ${SETUP_MARKER} -->`,
    "",
    "Configure this repository for Agent PR Train.",
    "",
    "Files:",
    ...scaffold.files.map((file) => `- ${file.path}: ${file.status}`),
  ].join("\n");
}

function buildSetupPrBody(
  issue: GitHubIssueSummary,
  scaffold: ScaffoldResult
): string {
  const summary = summarizeScaffold(scaffold);
  return [
    `Closes #${issue.number}`,
    "",
    "<!-- agent-train:init-pr -->",
    "",
    "## Agent Train Setup",
    "",
    `- Created: ${summary.created ?? 0}`,
    `- Updated: ${summary.updated ?? 0}`,
    `- Unchanged: ${summary.unchanged ?? 0}`,
    `- Skipped: ${summary.skipped ?? 0}`,
    "",
    "Files:",
    ...scaffold.files.map((file) => `- ${file.path}: ${file.status}`),
  ].join("\n");
}

export function initSummary(result: InitResult): unknown {
  return {
    mode: result.mode,
    root: result.root,
    repo: result.repo,
    targetBranch: result.targetBranch,
    branch: result.branch,
    issue: result.issue
      ? { number: result.issue.number, url: result.issue.url }
      : undefined,
    pr: result.pr
      ? { number: result.pr.number, url: result.pr.url }
      : undefined,
    reason: result.reason,
    files: result.scaffold.files,
    counts: summarizeScaffold(result.scaffold),
  };
}
