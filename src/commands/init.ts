import type { CommandRunner } from "@/exec.js";
import type { GitHubClient } from "@/github.js";
import type { PrtisanManifest } from "@/manifest.js";
import {
  type ScaffoldResult,
  summarizeScaffold,
  writeScaffoldFiles,
} from "@/scaffold.js";
import { createSetupBranchChange } from "@/setup-worktree.js";
import type { PullRequest } from "@/types.js";

export interface InitInput {
  readonly cwd: string;
  readonly repo?: string;
  readonly targetBranch?: string;
  readonly branch?: string;
  readonly remote?: string;
  readonly force?: boolean;
  readonly manifest?: PrtisanManifest;
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
  readonly pr?: Pick<
    PullRequest,
    "number" | "url" | "headRefName" | "baseRefName"
  >;
  readonly reason?: string;
}

const DEFAULT_SETUP_BRANCH = "prtisan/setup";

export async function executeInit(
  input: InitInput,
  deps: InitDeps
): Promise<InitResult> {
  const root = await detectGitRoot(input.cwd, deps.runner);
  if (!root) {
    const repo = input.repo ?? "OWNER/REPO";
    const targetBranch = input.targetBranch ?? "main";
    return {
      mode: "local",
      root: input.cwd,
      repo,
      targetBranch,
      scaffold: await writeScaffoldFiles(input.cwd, {
        repo,
        targetBranch,
        force: input.force,
      }),
      reason: "No Git repository was detected.",
    };
  }
  const discovered = await detectGitHubRepo(root, deps.runner, input.repo);
  if (!discovered) {
    const repo = input.repo ?? "OWNER/REPO";
    const targetBranch = input.targetBranch ?? "main";
    return {
      mode: "local",
      root,
      repo,
      targetBranch,
      scaffold: await writeScaffoldFiles(root, {
        repo,
        targetBranch,
        force: input.force,
      }),
      reason: "The Git repository is not connected to GitHub through gh.",
    };
  }

  await deps.github.assertReady();
  const targetBranch = input.targetBranch ?? discovered.defaultBranch;
  const branch = input.branch ?? DEFAULT_SETUP_BRANCH;
  const change = await createSetupBranchChange(
    {
      root,
      repo: discovered.repo,
      targetBranch,
      branch,
      remote: input.remote ?? "origin",
      force: input.force,
      manifest: input.manifest,
    },
    deps.runner
  );
  if (!change.changed) {
    return {
      mode: "github",
      root,
      repo: discovered.repo,
      targetBranch,
      branch,
      scaffold: change.scaffold,
      reason:
        "The Prtisan manifest and Dockerfile already exist on the target branch.",
    };
  }
  const pr = await deps.github.createOrUpdatePullRequest({
    repo: discovered.repo,
    title: "Configure Prtisan",
    body: setupPullRequestBody(change.scaffold),
    baseBranch: targetBranch,
    headBranch: branch,
  });
  return {
    mode: "github",
    root,
    repo: discovered.repo,
    targetBranch,
    branch,
    scaffold: change.scaffold,
    pr: {
      number: pr.number,
      url: pr.url,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    },
  };
}

async function detectGitRoot(
  cwd: string,
  runner: CommandRunner
): Promise<string | undefined> {
  const result = await runner.run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function detectGitHubRepo(
  cwd: string,
  runner: CommandRunner,
  requested?: string
): Promise<
  { readonly repo: string; readonly defaultBranch: string } | undefined
> {
  const result = await runner.run(
    "gh",
    requested
      ? ["repo", "view", requested, "--json", "nameWithOwner,defaultBranchRef"]
      : ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { cwd }
  );
  if (result.exitCode !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as {
      nameWithOwner?: unknown;
      defaultBranchRef?: { name?: unknown };
    };
    const repo =
      requested ??
      (typeof value.nameWithOwner === "string"
        ? value.nameWithOwner
        : undefined);
    return repo
      ? {
          repo,
          defaultBranch:
            typeof value.defaultBranchRef?.name === "string"
              ? value.defaultBranchRef.name
              : "main",
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function setupPullRequestBody(scaffold: ScaffoldResult): string {
  const summary = summarizeScaffold(scaffold);
  return [
    "<!-- prtisan:init-pr -->",
    "## Summary",
    "",
    "Add the repository-owned Prtisan manifest and Sandcastle Codex runtime.",
    "",
    "## Acceptance criteria",
    "",
    "- Verification commands and timeouts match repository policy.",
    "- The Dockerfile contains only the tools required for Sandcastle and Codex.",
    "- The setup is human-reviewed before any integration plan is applied.",
    "",
    "## Generated files",
    "",
    ...scaffold.files.map((file) => `- \`${file.path}\`: ${file.status}`),
    "",
    `Created: ${summary.created ?? 0}; updated: ${summary.updated ?? 0}; unchanged: ${summary.unchanged ?? 0}.`,
  ].join("\n");
}

export function initSummary(result: InitResult): unknown {
  return {
    mode: result.mode,
    root: result.root,
    repo: result.repo,
    targetBranch: result.targetBranch,
    branch: result.branch,
    scaffold: summarizeScaffold(result.scaffold),
    pr: result.pr,
    reason: result.reason,
  };
}
