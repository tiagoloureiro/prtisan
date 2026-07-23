import type { CommandRunner } from "./exec.js";
import { mustRun } from "./exec.js";
import { joinPath } from "./path.js";
import { type ScaffoldResult, writeScaffoldFiles } from "./scaffold.js";

export interface SetupWorktreeInput {
  readonly root: string;
  readonly repo: string;
  readonly targetBranch: string;
  readonly branch: string;
  readonly remote: string;
  readonly force?: boolean;
}

export interface SetupWorktreeResult {
  readonly scaffold: ScaffoldResult;
  readonly changed: boolean;
}

export async function createSetupBranchChange(
  input: SetupWorktreeInput,
  runner: CommandRunner
): Promise<SetupWorktreeResult> {
  const tempRoot = joinPath("/tmp", `agent-train-init-${crypto.randomUUID()}`);
  const branchExists = await remoteBranchExists(
    runner,
    input.root,
    input.remote,
    input.branch
  );
  await fetchBranch(runner, input.root, input.remote, input.targetBranch);
  if (branchExists) {
    await fetchBranch(runner, input.root, input.remote, input.branch);
  }

  try {
    await mustRun(
      runner,
      "git",
      [
        "worktree",
        "add",
        "--force",
        "--detach",
        tempRoot,
        `${input.remote}/${input.targetBranch}`,
      ],
      { cwd: input.root }
    );

    const scaffold = await writeScaffoldFiles(tempRoot, {
      repo: input.repo,
      targetBranch: input.targetBranch,
      force: input.force,
    });
    const changed = await hasGitChanges(runner, tempRoot);

    if (changed) {
      await mustRun(
        runner,
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
        runner,
        "git",
        ["commit", "-m", "Configure Agent PR Train"],
        {
          cwd: tempRoot,
        }
      );
      await mustRun(
        runner,
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

    return { scaffold, changed };
  } finally {
    await runner.run("git", ["worktree", "remove", "--force", tempRoot], {
      cwd: input.root,
    });
    await runner.run("rm", ["-rf", tempRoot]);
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
