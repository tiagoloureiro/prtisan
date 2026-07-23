import { describe, expect, test } from "bun:test";
import { executeCreatePrs } from "../src/commands/create-prs.js";
import type { AgentRunner } from "../src/agent.js";
import type { AgentTrainConfig, Issue } from "../src/types.js";
import type { GitHubClient } from "../src/github.js";
import type { GitClient } from "../src/git.js";
import { issue } from "./helpers.js";

const config: AgentTrainConfig = {
  repo: "o/r",
  targetBranch: "main",
  issueQuery: "state:open",
  branchPrefix: "agent/issue-",
  trainPrefix: "train",
  remote: "origin",
  models: {
    implementation: "gpt-5.6-terra",
    repair: "gpt-5.6-terra",
    review: "gpt-5.6-luna",
  },
  reasoning: {
    implementation: "medium",
    repair: "medium",
    review: "low",
  },
  concurrency: {
    implement: 2,
    validate: 4,
    github: 4,
  },
  docker: {
    imageName: "sandcastle:agent-train",
    codexHome: ".sandcastle/codex-home",
    mounts: [],
  },
  retention: {
    ttlDays: 14,
    maxLogBytes: 1000,
    keepSessions: true,
  },
};

describe("create-prs command", () => {
  test("creates stacked PRs and synthetic base branches by dependency layer", async () => {
    const cwd = `/tmp/agent-train-create-prs-${crypto.randomUUID()}`;
    const issues: Issue[] = [
      issue({ number: 1, title: "A" }),
      issue({ number: 2, title: "B" }),
      issue({ number: 3, title: "C", blockedBy: [{ number: 1 }, { number: 2 }] }),
      issue({ number: 4, title: "D", blockedBy: [{ number: 3 }] }),
    ];
    const remoteBranches = new Set<string>(["main"]);
    const prCreates: { baseBranch: string; headBranch: string }[] = [];
    const syntheticBases: string[] = [];

    const github = {
      listIssues: async () => issues,
      getRelatedIssues: async () => [],
      createIssueComment: async () => undefined,
      createOrUpdatePullRequest: async (input: { baseBranch: string; headBranch: string }) => {
        prCreates.push(input);
        return {
          number: prCreates.length,
          url: `https://github.com/o/r/pull/${prCreates.length}`,
          title: input.headBranch,
          state: "OPEN",
          headRefName: input.headBranch,
          baseRefName: input.baseBranch,
          headRefOid: `sha-${prCreates.length}`,
        };
      },
    } as unknown as GitHubClient;

    const git = {
      prepareBranchFromBase: async () => undefined,
      pushBranch: async (branch: string) => {
        remoteBranches.add(branch);
      },
      branchExistsOnRemote: async (branch: string) => remoteBranches.has(branch),
      revParseRemoteBranch: async (branch: string) => `sha-for-${branch}`,
      createSyntheticBaseBranch: async (input: { syntheticBranch: string; blockerBranches: readonly string[] }) => {
        for (const branch of input.blockerBranches) {
          expect(remoteBranches.has(branch)).toBe(true);
        }
        syntheticBases.push(input.syntheticBranch);
        remoteBranches.add(input.syntheticBranch);
      },
    } as unknown as GitClient;

    const agent: AgentRunner = {
      implementIssue: async (input) => ({
        branch: input.branch,
        commits: [`commit-${input.issue.number}`],
        stdout: "",
      }),
      reviewPullRequest: async () => ({ axis: "spec", summary: "", findings: [] }),
      repairPullRequest: async (input) => ({ branch: input.branch, commits: [], stdout: "" }),
    };

    const state = await executeCreatePrs(
      {
        cwd,
        config,
        trainId: "20260723-test",
      },
      {
        github,
        git,
        agent,
      },
    );

    expect(syntheticBases).toEqual(["train/20260723-test/base/3"]);
    const basesByHead = new Map(prCreates.map((pr) => [pr.headBranch, pr.baseBranch]));
    expect(basesByHead.get("agent/issue-1-a")).toBe("main");
    expect(basesByHead.get("agent/issue-2-b")).toBe("main");
    expect(basesByHead.get("agent/issue-3-c")).toBe("train/20260723-test/base/3");
    expect(basesByHead.get("agent/issue-4-d")).toBe("agent/issue-3-c");
    expect(state.issues["3"]?.baseAnchorSha).toBe("sha-for-train/20260723-test/base/3");
    expect(state.issues["4"]?.status).toBe("pr_opened");
  });
});
