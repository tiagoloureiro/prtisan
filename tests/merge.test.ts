import { describe, expect, test } from "bun:test";

import type { AgentRunner } from "@/agent.js";
import { executeMerge } from "@/commands/merge.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient } from "@/github.js";
import { VALIDATION_REVIEW_MARKER } from "@/review.js";
import type {
  AgentRunOutcome,
  PullRequest,
  PullRequestCheckEvidence,
} from "@/types.js";

import { pullRequest, testConfig } from "./helpers.js";

describe("merge command", () => {
  test("marks draft PRs ready before validation and merge", async () => {
    const draft = validatedPullRequest({ number: 4, isDraft: true });
    const ready = pullRequest({ ...draft, isDraft: false });
    const calls: string[] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[draft], [ready], []], calls),
        git: gitClient(calls),
      }
    );

    expect(calls.slice(0, 4)).toEqual(["list", "ready:4", "list", "merge:4"]);
  });

  test("validates only the current PR when validation is missing", async () => {
    const missing = pullRequest({ number: 117 });
    const validated = validatedPullRequest({ number: 117 });
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[missing], [validated], []]),
        git: gitClient(),
        validatePullRequests: async (pullNumbers) => {
          validatedPulls.push([...pullNumbers]);
        },
      }
    );

    expect(validatedPulls).toEqual([[117]]);
  });

  test("revalidates stale validation markers before merging", async () => {
    const stale = pullRequest({
      number: 12,
      headRefOid: "current-head",
      latestReviews: [validationReview("old-head")],
    });
    const fresh = validatedPullRequest({
      number: 12,
      headRefOid: "current-head",
    });
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[stale], [fresh], []]),
        git: gitClient(),
        validatePullRequests: async (pullNumbers) => {
          validatedPulls.push([...pullNumbers]);
        },
      }
    );

    expect(validatedPulls).toEqual([[12]]);
  });

  test("stops when validation repair still leaves blocking findings", async () => {
    const blocked = validatedPullRequest({
      number: 33,
      validation: { blockingFindings: 2 },
    });
    const validatedPulls: number[][] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[blocked], [blocked]]),
          git: gitClient(),
          validatePullRequests: async (pullNumbers) => {
            validatedPulls.push([...pullNumbers]);
          },
        }
      )
    ).rejects.toThrow("PR #33 has 2 blocking agent validation finding(s).");
    expect(validatedPulls).toEqual([[33]]);
  });

  test("repairs failing GitHub Actions checks, waits, revalidates, and merges", async () => {
    const failing = validatedPullRequest({
      number: 44,
      headRefOid: "head-1",
      statusCheckRollup: [failedActionsCheck()],
    });
    const repaired = validatedPullRequest({
      number: 44,
      headRefOid: "head-2",
    });
    const calls: string[] = [];
    const ciEvidence: PullRequestCheckEvidence[][] = [];
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[failing], [repaired], []], calls, {
          checkEvidence: [
            {
              name: "check",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/101",
              runId: "101",
              logExcerpt: "test failed",
            },
          ],
          waitForChecks: repaired,
        }),
        git: gitClient(calls),
        agent: agentRunner({
          repairCiFailure: async (input) => {
            ciEvidence.push([...input.checkEvidence]);
            return outcome({ branch: input.branch, commits: ["fix-ci"] });
          },
        }),
        validatePullRequests: async (pullNumbers) => {
          validatedPulls.push([...pullNumbers]);
        },
      }
    );

    expect(ciEvidence[0]?.[0]).toMatchObject({
      name: "check",
      logExcerpt: "test failed",
    });
    expect(calls).toContain("push:branch-44");
    expect(calls).toContain("wait-checks:44");
    expect(validatedPulls).toEqual([[44]]);
    expect(calls).toContain("merge:44");
  });

  test("posts a PR comment when CI repair cannot make checks green", async () => {
    const failing = validatedPullRequest({
      number: 45,
      statusCheckRollup: [failedActionsCheck()],
    });
    const comments: string[] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[failing]], [], {
            comments,
            checkEvidence: [
              {
                name: "check",
                status: "COMPLETED",
                conclusion: "FAILURE",
                detailsUrl: "https://github.com/o/r/actions/runs/101",
              },
            ],
          }),
          git: gitClient(),
          agent: agentRunner({
            repairCiFailure: async (input) =>
              outcome({ branch: input.branch, commits: [] }),
          }),
        }
      )
    ).rejects.toThrow("CI repair produced no commits");

    expect(comments[0]).toContain("Agent train could not make CI green");
    expect(comments[0]).toContain("check: FAILURE");
  });

  test("keeps required review as a hard stop without running repair", async () => {
    const reviewRequired = validatedPullRequest({
      number: 55,
      reviewDecision: "REVIEW_REQUIRED",
    });
    const repairCalls: string[] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[reviewRequired]]),
          git: gitClient(),
          agent: agentRunner({
            repairCiFailure: async (input) => {
              repairCalls.push("ci");
              return outcome({ branch: input.branch, commits: [] });
            },
            repairMergeState: async (input) => {
              repairCalls.push("merge-state");
              return outcome({ branch: input.branch, commits: [] });
            },
          }),
        }
      )
    ).rejects.toThrow("PR #55 is still waiting for required review approval.");
    expect(repairCalls).toEqual([]);
  });

  test("repairs merge-state blockers until the PR becomes mergeable", async () => {
    const dirty = validatedPullRequest({
      number: 66,
      mergeStateStatus: "DIRTY",
    });
    const mergeable = validatedPullRequest({ number: 66 });
    const mergeStates: string[] = [];
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[dirty], [mergeable], []], [], {
          waitForChecks: mergeable,
        }),
        git: gitClient(),
        agent: agentRunner({
          repairMergeState: async (input) => {
            mergeStates.push(input.mergeState);
            return outcome({ branch: input.branch, commits: ["fix-merge"] });
          },
        }),
        validatePullRequests: async (pullNumbers) => {
          validatedPulls.push([...pullNumbers]);
        },
      }
    );

    expect(mergeStates).toEqual(["DIRTY"]);
    expect(validatedPulls).toEqual([[66]]);
  });

  test("allows a fresh CI repair after merge-state repair changes the PR head", async () => {
    const ciFailHead1 = validatedPullRequest({
      number: 46,
      headRefOid: "head-1",
      statusCheckRollup: [failedActionsCheck()],
    });
    const dirtyHead2 = validatedPullRequest({
      number: 46,
      headRefOid: "head-2",
      mergeStateStatus: "DIRTY",
    });
    const ciFailHead3 = validatedPullRequest({
      number: 46,
      headRefOid: "head-3",
      statusCheckRollup: [failedActionsCheck()],
    });
    const greenHead4 = validatedPullRequest({
      number: 46,
      headRefOid: "head-4",
    });
    const calls: string[] = [];
    const repairKinds: string[] = [];
    const comments: string[] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence(
          [[ciFailHead1], [dirtyHead2], [ciFailHead3], [greenHead4], []],
          calls,
          {
            comments,
            checkEvidence: [
              {
                name: "check",
                status: "COMPLETED",
                conclusion: "FAILURE",
                detailsUrl: "https://github.com/o/r/actions/runs/101",
                runId: "101",
                logExcerpt: "test failed",
              },
            ],
            waitForChecks: [dirtyHead2, ciFailHead3, greenHead4],
          }
        ),
        git: gitClient(calls),
        agent: agentRunner({
          repairCiFailure: async (input) => {
            repairKinds.push(`ci:${input.prNumber}`);
            return outcome({ branch: input.branch, commits: ["fix-ci"] });
          },
          repairMergeState: async (input) => {
            repairKinds.push(`merge-state:${input.prNumber}`);
            return outcome({ branch: input.branch, commits: ["fix-merge"] });
          },
        }),
        validatePullRequests: async () => {},
      }
    );

    expect(repairKinds).toEqual(["ci:46", "merge-state:46", "ci:46"]);
    expect(comments).toEqual([]);
    expect(calls).toContain("merge:46");
  });

  test("stops merge-state repair when the agent produces no commits", async () => {
    const unknown = validatedPullRequest({
      number: 77,
      mergeStateStatus: "UNKNOWN",
    });

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[unknown]]),
          git: gitClient(),
          agent: agentRunner({
            repairMergeState: async (input) =>
              outcome({ branch: input.branch, commits: [] }),
          }),
        }
      )
    ).rejects.toThrow("merge-state repair produced no commits");
  });

  test("caps merge-state repair at three attempts", async () => {
    const blocked = validatedPullRequest({
      number: 88,
      mergeStateStatus: "BLOCKED",
    });
    const repairAttempts: number[] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[blocked], [blocked], [blocked], [blocked]]),
          git: gitClient(),
          agent: agentRunner({
            repairMergeState: async (input) => {
              repairAttempts.push(input.prNumber);
              return outcome({ branch: input.branch, commits: ["still"] });
            },
          }),
          validatePullRequests: async () => {},
        }
      )
    ).rejects.toThrow("after 3 merge-state repair attempt(s)");

    expect(repairAttempts).toHaveLength(3);
  });
});

function validationReview(
  headRefOid: string,
  input: {
    readonly blockingFindings?: number;
    readonly advisoryFindings?: number;
    readonly specSkipped?: boolean;
  } = {}
): PullRequest["latestReviews"][number] {
  return {
    state: input.blockingFindings ? "CHANGES_REQUESTED" : "COMMENTED",
    body: `<!-- ${VALIDATION_REVIEW_MARKER} ${JSON.stringify({
      headRefOid,
      blockingFindings: input.blockingFindings ?? 0,
      advisoryFindings: input.advisoryFindings ?? 0,
      specSkipped: input.specSkipped ?? true,
    })} -->`,
  };
}

function validatedPullRequest(
  input: Partial<PullRequest> & {
    readonly validation?: {
      readonly blockingFindings?: number;
      readonly advisoryFindings?: number;
    };
  }
): PullRequest {
  const pr = pullRequest(input);
  return {
    ...pr,
    latestReviews: [
      validationReview(pr.headRefOid, {
        blockingFindings: input.validation?.blockingFindings,
        advisoryFindings: input.validation?.advisoryFindings,
      }),
    ],
  };
}

function failedActionsCheck(): unknown {
  return {
    __typename: "CheckRun",
    name: "check",
    status: "COMPLETED",
    conclusion: "FAILURE",
    detailsUrl: "https://github.com/o/r/actions/runs/101/job/202",
    workflowName: "CI",
  };
}

function githubSequence(
  pulls: readonly (readonly PullRequest[])[],
  calls: string[] = [],
  options: {
    readonly checkEvidence?: readonly PullRequestCheckEvidence[];
    readonly comments?: string[];
    readonly waitForChecks?: PullRequest | readonly PullRequest[];
  } = {}
): GitHubClient {
  let listCalls = 0;
  let waitCalls = 0;
  return {
    listOpenPullRequests: async () => {
      calls.push("list");
      const index = Math.min(listCalls, pulls.length - 1);
      listCalls += 1;
      return [...(pulls[index] ?? [])];
    },
    markPullRequestReady: async (_repo: string, pullNumber: number) => {
      calls.push(`ready:${pullNumber}`);
    },
    getPullRequestCheckEvidence: async () => [...(options.checkEvidence ?? [])],
    waitForPullRequestChecks: async (_repo: string, pullNumber: number) => {
      calls.push(`wait-checks:${pullNumber}`);
      if (Array.isArray(options.waitForChecks)) {
        const index = Math.min(waitCalls, options.waitForChecks.length - 1);
        waitCalls += 1;
        return options.waitForChecks[index] ?? pullRequest({});
      }
      return options.waitForChecks ?? pulls.at(-1)?.[0] ?? pullRequest({});
    },
    createPullRequestComment: async (
      _repo: string,
      pullNumber: number,
      body: string
    ) => {
      calls.push(`comment:${pullNumber}`);
      options.comments?.push(body);
    },
    mergePullRequest: async (_repo: string, pullNumber: number) => {
      calls.push(`merge:${pullNumber}`);
    },
    waitForPullRequestMerged: async (_repo: string, pullNumber: number) => {
      calls.push(`merged:${pullNumber}`);
      return pullRequest({
        number: pullNumber,
        state: "MERGED",
      });
    },
  } as unknown as GitHubClient;
}

function gitClient(calls: string[] = []): GitClient {
  return {
    pushBranch: async (branch: string) => {
      calls.push(`push:${branch}`);
    },
    deleteRemoteBranch: async (branch: string) => {
      calls.push(`delete:${branch}`);
    },
  } as unknown as GitClient;
}

function agentRunner(
  input: {
    readonly repairCiFailure?: (
      input: Extract<
        Parameters<AgentRunner["repair"]>[0],
        { kind: "ci-failure" }
      >
    ) => Promise<AgentRunOutcome>;
    readonly repairMergeState?: (
      input: Extract<
        Parameters<AgentRunner["repair"]>[0],
        { kind: "merge-state" }
      >
    ) => Promise<AgentRunOutcome>;
  } = {}
): AgentRunner {
  return {
    review: async (reviewInput) => ({
      axis: reviewInput.kind === "pull-request" ? reviewInput.axis : "spec",
      summary: "",
      findings: [],
    }),
    repair: async (repairInput) => {
      if (repairInput.kind === "ci-failure" && input.repairCiFailure) {
        return input.repairCiFailure(repairInput);
      }
      if (repairInput.kind === "merge-state" && input.repairMergeState) {
        return input.repairMergeState(repairInput);
      }
      return outcome({ branch: repairInput.branch, commits: [] });
    },
  };
}

function outcome(input: {
  readonly branch: string;
  readonly commits: readonly string[];
}): AgentRunOutcome {
  return {
    branch: input.branch,
    commits: input.commits,
    stdout: "",
  };
}
