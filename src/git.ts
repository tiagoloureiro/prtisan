import type { CommandRunner } from "./exec.js";
import { mustRun } from "./exec.js";
import { ensureDir } from "./fs.js";
import { dirname, joinPath, normalizePath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export class GitClient {
  private repoRootPath?: string;

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

  async recreateBranchFromBaseDiff(input: {
    readonly runId: string;
    readonly label: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly diffBaseRef: string;
    readonly commitMessage: string;
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
          "--detach",
          worktreePath,
          `${this.config.remote}/${input.baseBranch}`,
        ],
        { cwd: this.cwd }
      );

      await mustRun(this.runner, "git", ["switch", "-C", input.branch], {
        cwd: worktreePath,
      });
      const nextBaseAnchorSha = await this.revParseRemoteBranch(
        input.baseBranch
      );
      const diff = await mustRun(
        this.runner,
        "git",
        [
          "diff",
          "--binary",
          input.diffBaseRef,
          `${this.config.remote}/${input.branch}`,
        ],
        { cwd: this.cwd }
      );

      if (diff.stdout.trim().length > 0) {
        await mustRun(this.runner, "git", ["apply", "--3way", "--index", "-"], {
          cwd: worktreePath,
          input: diff.stdout,
        });
      }

      const staged = await this.runner.run(
        "git",
        ["diff", "--cached", "--quiet"],
        { cwd: worktreePath }
      );
      if (staged.exitCode !== 0) {
        await mustRun(
          this.runner,
          "git",
          ["commit", "-m", input.commitMessage],
          {
            cwd: worktreePath,
          }
        );
      }
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
    if (exists) {
      const checkedOutWorktreePath = await this.checkedOutWorktreePath(branch);
      if (checkedOutWorktreePath) {
        await this.resetCheckedOutManagedBranch(
          branch,
          startPoint,
          checkedOutWorktreePath
        );
        return;
      }
    }

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

  private async resetCheckedOutManagedBranch(
    branch: string,
    startPoint: string,
    worktreePath: string
  ): Promise<void> {
    if (!(await this.isManagedBranchWorktree(worktreePath))) {
      throw new Error(
        `Cannot prepare branch "${branch}" because it is checked out at ${worktreePath}. Switch that worktree to another branch or remove it before running agent-train.`
      );
    }

    await mustRun(this.runner, "git", ["reset", "--hard", startPoint], {
      cwd: worktreePath,
    });
    await mustRun(this.runner, "git", ["clean", "-fd"], {
      cwd: worktreePath,
    });
  }

  private async checkedOutWorktreePath(
    branch: string
  ): Promise<string | undefined> {
    const result = await mustRun(
      this.runner,
      "git",
      ["worktree", "list", "--porcelain"],
      {
        cwd: this.cwd,
      }
    );
    let worktreePath: string | undefined;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        worktreePath = normalizePath(line.slice("worktree ".length));
      } else if (line === `branch refs/heads/${branch}`) {
        return worktreePath;
      } else if (line.length === 0) {
        worktreePath = undefined;
      }
    }
    return undefined;
  }

  private async isManagedBranchWorktree(
    worktreePath: string
  ): Promise<boolean> {
    const managedRoot = joinPath(
      await this.repoRoot(),
      ".sandcastle",
      "worktrees"
    );
    const normalizedPath = normalizePath(worktreePath);
    return normalizedPath.startsWith(`${managedRoot}/`);
  }

  private async repoRoot(): Promise<string> {
    if (this.repoRootPath) return this.repoRootPath;

    const result = await mustRun(
      this.runner,
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: this.cwd,
      }
    );
    this.repoRootPath = normalizePath(result.stdout.trim());
    return this.repoRootPath;
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
    const managedRoot = joinPath(this.cwd, ".sandcastle", "runs");
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
