import type { CommandRunner } from "./exec.js";
import { mustRun } from "./exec.js";
import { ensureDir } from "./fs.js";
import { dirname, joinPath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export class GitClient {
  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string,
    private readonly config: AgentTrainConfig
  ) {}

  async assertReady(): Promise<void> {
    await mustRun(this.runner, "git", ["--version"], { cwd: this.cwd });
  }

  async fetchBranch(branch: string): Promise<void> {
    await mustRun(
      this.runner,
      "git",
      [
        "fetch",
        this.config.remote,
        `refs/heads/${branch}:refs/remotes/${this.config.remote}/${branch}`,
      ],
      { cwd: this.cwd }
    );
  }

  async prepareBranchFromBase(
    branch: string,
    baseBranch: string
  ): Promise<void> {
    await this.fetchBranch(baseBranch);
    const remoteBranchExists = await this.branchExistsOnRemote(branch);
    if (remoteBranchExists) {
      await this.fetchBranch(branch);
    }

    await this.upsertLocalBranch(
      branch,
      remoteBranchExists
        ? `${this.config.remote}/${branch}`
        : `${this.config.remote}/${baseBranch}`
    );
  }

  async pushBranch(branch: string): Promise<void> {
    await mustRun(
      this.runner,
      "git",
      [
        "push",
        "--set-upstream",
        this.config.remote,
        branch,
        "--force-with-lease",
      ],
      { cwd: this.cwd }
    );
  }

  async branchExistsOnRemote(branch: string): Promise<boolean> {
    const result = await this.runner.run(
      "git",
      ["ls-remote", "--exit-code", "--heads", this.config.remote, branch],
      { cwd: this.cwd }
    );
    return result.exitCode === 0;
  }

  async revParseRemoteBranch(branch: string): Promise<string> {
    await this.fetchBranch(branch);
    const result = await mustRun(
      this.runner,
      "git",
      ["rev-parse", `${this.config.remote}/${branch}`],
      {
        cwd: this.cwd,
      }
    );
    return result.stdout.trim();
  }

  async createSyntheticBaseBranch(input: {
    readonly runId: string;
    readonly label: string;
    readonly syntheticBranch: string;
    readonly blockerBranches: readonly string[];
  }): Promise<void> {
    const worktreePath = joinPath(
      this.cwd,
      ".sandcastle",
      "runs",
      input.runId,
      "worktrees",
      input.label
    );

    await this.clearManagedWorktree(worktreePath);
    await this.fetchBranch(this.config.targetBranch);
    for (const branch of input.blockerBranches) {
      await this.fetchBranch(branch);
    }

    try {
      await mustRun(
        this.runner,
        "git",
        [
          "worktree",
          "add",
          "--force",
          "--detach",
          worktreePath,
          `${this.config.remote}/${this.config.targetBranch}`,
        ],
        { cwd: this.cwd }
      );

      await mustRun(
        this.runner,
        "git",
        ["switch", "-C", input.syntheticBranch],
        {
          cwd: worktreePath,
        }
      );

      for (const branch of input.blockerBranches) {
        await mustRun(
          this.runner,
          "git",
          ["merge", "--no-edit", "--no-ff", `${this.config.remote}/${branch}`],
          {
            cwd: worktreePath,
          }
        );
      }

      await mustRun(
        this.runner,
        "git",
        [
          "push",
          "--set-upstream",
          this.config.remote,
          input.syntheticBranch,
          "--force-with-lease",
        ],
        { cwd: worktreePath }
      );
    } finally {
      await this.runner.run(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        { cwd: this.cwd }
      );
    }
  }

  async rebaseBranchOntoBase(input: {
    readonly runId: string;
    readonly label: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly oldBaseAnchorSha?: string;
  }): Promise<string> {
    const worktreePath = joinPath(
      this.cwd,
      ".sandcastle",
      "runs",
      input.runId,
      "worktrees",
      input.label
    );

    await this.clearManagedWorktree(worktreePath);
    await this.fetchBranch(input.branch);
    await this.fetchBranch(input.baseBranch);

    try {
      await mustRun(
        this.runner,
        "git",
        [
          "worktree",
          "add",
          "--force",
          "-B",
          input.branch,
          worktreePath,
          `${this.config.remote}/${input.branch}`,
        ],
        { cwd: this.cwd }
      );

      const nextBase = `${this.config.remote}/${input.baseBranch}`;
      const nextBaseAnchorSha = await this.revParseRemoteBranch(
        input.baseBranch
      );
      const rebaseArgs = input.oldBaseAnchorSha
        ? ["rebase", "--onto", nextBase, input.oldBaseAnchorSha]
        : ["rebase", nextBase];
      await mustRun(this.runner, "git", rebaseArgs, { cwd: worktreePath });
      await mustRun(
        this.runner,
        "git",
        ["push", this.config.remote, input.branch, "--force-with-lease"],
        {
          cwd: worktreePath,
        }
      );
      return nextBaseAnchorSha;
    } finally {
      await this.runner.run(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        { cwd: this.cwd }
      );
    }
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    await this.runner.run(
      "git",
      ["push", this.config.remote, "--delete", branch],
      { cwd: this.cwd }
    );
  }

  private async upsertLocalBranch(
    branch: string,
    startPoint: string
  ): Promise<void> {
    const exists = await this.localBranchExists(branch);
    await mustRun(
      this.runner,
      "git",
      exists
        ? ["branch", "-f", branch, startPoint]
        : ["branch", branch, startPoint],
      {
        cwd: this.cwd,
      }
    );
  }

  private async localBranchExists(branch: string): Promise<boolean> {
    const result = await this.runner.run(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        cwd: this.cwd,
      }
    );
    return result.exitCode === 0;
  }

  private async clearManagedWorktree(worktreePath: string): Promise<void> {
    const managedRoot = joinPath(this.cwd, ".sandcastle", "trains");
    if (!worktreePath.startsWith(`${managedRoot}/`)) {
      throw new Error(
        `Refusing to clear unmanaged worktree path: ${worktreePath}`
      );
    }

    await this.runner.run(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: this.cwd }
    );
    await this.runner.run("rm", ["-rf", worktreePath], { cwd: this.cwd });
    await ensureDir(dirname(worktreePath));
  }
}
