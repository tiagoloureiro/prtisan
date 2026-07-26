import { describe, expect, test } from "bun:test";

import type { AgentRunner } from "@/agent.js";
import { executeMerge } from "@/commands/merge.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient } from "@/github.js";
import { InMemoryRepairAttemptStore } from "@/repair-attempt-store.js";
import { VALIDATION_REVIEW_MARKER } from "@/review.js";
import type {
  PreparedRuntime,
  RuntimeProvider,
  VerificationRunner,
} from "@/runtime.js";
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
        validatePullRequests: validationSequence([ready]),
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
        validatePullRequests: validationSequence([validated], validatedPulls),
      }
    );

    expect(validatedPulls).toEqual([[117]]);
  });

  test("restacks a frontier PR from a closed base branch onto the target before validation", async () => {
    const staleBase = pullRequest({
      number: 117,
      headRefName: "feature",
      baseRefName: "merged-base",
      baseRefOid: "old-base-sha",
    });
    const retargeted = pullRequest({
      ...staleBase,
      baseRefName: "main",
      baseRefOid: "main-sha",
      headRefOid: "rebased-head",
    });
    const validated = validatedPullRequest({
      ...retargeted,
      headRefOid: "rebased-head",
    });
    const calls: string[] = [];
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence(
          [[staleBase], [retargeted], [validated], []],
          calls
        ),
        git: gitClient(calls),
        runtime: passingRuntime,
        verification: passingVerification,
        validatePullRequests: validationSequence([validated], validatedPulls),
      }
    );

    expect(calls).toContain("recreate:feature:main:old-base-sha");
    expect(calls).toContain("edit-base:117:main");
    expect(validatedPulls).toEqual([[117]]);
  });

  test("revalidates stale validation markers before merging", async () => {
    const stale = pullRequest({
      number: 12,
      headRefOid: "current-head",
      latestReviews: [validationReview("old-head", "base-sha")],
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
        validatePullRequests: validationSequence([fresh], validatedPulls),
      }
    );

    expect(validatedPulls).toEqual([[12]]);
  });

  test("rechecks complete validation context before trusting a recent marker", async () => {
    const validated = reviewOnlyValidatedPullRequest({ number: 118 });
    const calls: string[] = [];
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[validated], []], calls),
        git: gitClient(calls),
        validatePullRequests: validationSequence([validated], validatedPulls),
      }
    );

    expect(validatedPulls).toEqual([[118]]);
    expect(calls).toContain("merge:118");
  });

  test("treats an already-blocked validation as a human stop", async () => {
    const blocked = validatedPullRequest({
      number: 33,
      validation: { blockingFindings: 2 },
    });
    const validatedPulls: number[][] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[blocked]]),
          git: gitClient(),
          validatePullRequests: validationSequence([blocked], validatedPulls),
        }
      )
    ).rejects.toThrow("PR #33 has 2 blocking agent validation finding(s).");
    expect(validatedPulls).toEqual([]);
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
          getPullRequests: [failing, repaired],
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
            return outcome({ branch: input.branch, commits: ["head-2"] });
          },
        }),
        runtime: passingRuntime,
        verification: passingVerification,
        validatePullRequests: validationSequence(
          [failing, repaired],
          validatedPulls
        ),
      }
    );

    expect(ciEvidence[0]?.[0]).toMatchObject({
      name: "check",
      logExcerpt: "test failed",
    });
    expect(calls).toContain("push-verified:branch-44:head-2:head-1");
    expect(calls).toContain("wait-checks:44");
    expect(validatedPulls).toEqual([[44], [44]]);
    expect(calls).toContain("merge:44");
  });

  test("persists CI repair fingerprints across merge invocations", async () => {
    const failing = validatedPullRequest({
      number: 49,
      headRefOid: "head-1",
      statusCheckRollup: [failedActionsCheck()],
    });
    const attempts = new InMemoryRepairAttemptStore();
    const repairCalls: string[] = [];
    const evidence: PullRequestCheckEvidence[] = [
      {
        name: "check",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/o/r/actions/runs/101",
        runId: "101",
        logExcerpt: "test failed",
      },
    ];
    const deps = () => ({
      github: githubSequence([[failing]], [], {
        checkEvidence: evidence,
      }),
      git: gitClient(),
      agent: agentRunner({
        repairCiFailure: async (input) => {
          repairCalls.push(input.branch);
          return outcome({ branch: input.branch, commits: [] });
        },
      }),
      runtime: passingRuntime,
      verification: passingVerification,
      repairAttempts: attempts,
      validatePullRequests: validationSequence([failing]),
    });

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-one" },
        deps()
      )
    ).rejects.toThrow("CI repair produced no commits");
    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-two" },
        deps()
      )
    ).rejects.toThrow("already consumed its single repair attempt");

    expect(repairCalls).toHaveLength(1);
  });

  test("does not launch CI repair when failure evidence has no logs", async () => {
    const failing = validatedPullRequest({
      number: 45,
      statusCheckRollup: [failedActionsCheck()],
    });
    const comments: string[] = [];
    const repairCalls: string[] = [];

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
          validatePullRequests: validationSequence([failing]),
          agent: agentRunner({
            repairCiFailure: async (input) => {
              repairCalls.push(input.branch);
              return outcome({ branch: input.branch, commits: [] });
            },
          }),
        }
      )
    ).rejects.toThrow("none is an actionable completed code failure with logs");

    expect(repairCalls).toEqual([]);
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
          validatePullRequests: validationSequence([reviewRequired]),
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
      headRefOid: "head-1",
      mergeStateStatus: "DIRTY",
    });
    const mergeable = validatedPullRequest({
      number: 66,
      headRefOid: "head-2",
    });
    const mergeStates: string[] = [];
    const validatedPulls: number[][] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[dirty], [mergeable], []], [], {
          getPullRequests: [dirty, mergeable],
          waitForChecks: mergeable,
        }),
        git: gitClient(),
        agent: agentRunner({
          repairMergeState: async (input) => {
            mergeStates.push(input.mergeState);
            return outcome({ branch: input.branch, commits: ["head-2"] });
          },
        }),
        runtime: passingRuntime,
        verification: passingVerification,
        validatePullRequests: validationSequence(
          [dirty, mergeable],
          validatedPulls
        ),
      }
    );

    expect(mergeStates).toEqual(["DIRTY"]);
    expect(validatedPulls).toEqual([[66], [66]]);
  });

  test("rebases BEHIND deterministically, verifies, and publishes by exact lease", async () => {
    const behind = validatedPullRequest({
      number: 67,
      headRefOid: "head-1",
      mergeStateStatus: "BEHIND",
    });
    const rebased = validatedPullRequest({
      number: 67,
      headRefOid: "rebased-head",
    });
    const calls: string[] = [];
    const verifiedRefs: string[] = [];

    await executeMerge(
      { cwd: "/repo", config: testConfig(), runId: "merge-test" },
      {
        github: githubSequence([[behind], [rebased], []], calls, {
          getPullRequests: [behind, rebased],
          waitForChecks: rebased,
        }),
        git: gitClient(calls),
        runtime: passingRuntime,
        verification: {
          verify: async (input) => {
            verifiedRefs.push(input.ref);
            return { status: "passed", commands: [] };
          },
        },
        validatePullRequests: validationSequence([behind, rebased]),
      }
    );

    expect(verifiedRefs).toEqual(["rebased-head"]);
    expect(calls).toContain("rebase:branch-67:main:base-sha");
    expect(calls).toContain("push-verified:branch-67:rebased-head:head-1");
    expect(calls).toContain("merge:67");
  });

  test("does not publish a deterministic rebase when verification fails", async () => {
    const behind = validatedPullRequest({
      number: 68,
      headRefOid: "head-1",
      mergeStateStatus: "BEHIND",
    });
    const calls: string[] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[behind]], calls),
          git: gitClient(calls),
          runtime: passingRuntime,
          validatePullRequests: validationSequence([behind]),
          verification: {
            verify: async () => ({
              status: "failed",
              commands: [
                {
                  name: "Project check",
                  command: "pnpm check",
                  exitCode: 1,
                  durationMs: 1,
                  timedOut: false,
                  output: "failed",
                },
              ],
            }),
          },
        }
      )
    ).rejects.toThrow("deterministic branch update failed host verification");

    expect(calls.some((call) => call.startsWith("push-verified:"))).toBe(false);
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
            getPullRequests: [
              ciFailHead1,
              dirtyHead2,
              dirtyHead2,
              ciFailHead3,
              ciFailHead3,
              greenHead4,
            ],
            checkEvidenceSequence: [
              [
                {
                  name: "check",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/o/r/actions/runs/101",
                  runId: "101",
                  logExcerpt: "test failed",
                },
              ],
              [
                {
                  name: "lint",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  detailsUrl: "https://github.com/o/r/actions/runs/102",
                  runId: "102",
                  logExcerpt: "lint failed",
                },
              ],
            ],
            waitForChecks: [dirtyHead2, ciFailHead3, greenHead4],
          }
        ),
        git: gitClient(calls),
        agent: agentRunner({
          repairCiFailure: async (input) => {
            repairKinds.push(`ci:${input.prNumber}`);
            return outcome({
              branch: input.branch,
              commits: [repairKinds.length === 1 ? "head-2" : "head-4"],
            });
          },
          repairMergeState: async (input) => {
            repairKinds.push(`merge-state:${input.prNumber}`);
            return outcome({ branch: input.branch, commits: ["head-3"] });
          },
        }),
        runtime: passingRuntime,
        verification: passingVerification,
        validatePullRequests: validationSequence([
          ciFailHead1,
          dirtyHead2,
          ciFailHead3,
          greenHead4,
        ]),
      }
    );

    expect(repairKinds).toEqual(["ci:46", "merge-state:46", "ci:46"]);
    expect(comments).toEqual([]);
    expect(calls).toContain("merge:46");
  });

  test("refreshes UNKNOWN once without launching a repair agent", async () => {
    const unknown = validatedPullRequest({
      number: 77,
      mergeStateStatus: "UNKNOWN",
    });

    const repairCalls: string[] = [];
    const delays: number[] = [];
    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[unknown]]),
          git: gitClient(),
          validatePullRequests: validationSequence([unknown]),
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
          agent: agentRunner({
            repairMergeState: async (input) => {
              repairCalls.push(input.branch);
              return outcome({ branch: input.branch, commits: [] });
            },
          }),
        }
      )
    ).rejects.toThrow("remained UNKNOWN after bounded refresh");
    expect(repairCalls).toEqual([]);
    expect(delays).toEqual([2_000, 5_000, 10_000]);
  });

  test("derives BLOCKED as a concrete hard stop without agent repair", async () => {
    const blocked = validatedPullRequest({
      number: 88,
      mergeStateStatus: "BLOCKED",
    });
    const repairAttempts: number[] = [];

    await expect(
      executeMerge(
        { cwd: "/repo", config: testConfig(), runId: "merge-test" },
        {
          github: githubSequence([[blocked]]),
          git: gitClient(),
          agent: agentRunner({
            repairMergeState: async (input) => {
              repairAttempts.push(input.prNumber);
              return outcome({ branch: input.branch, commits: ["head-88"] });
            },
          }),
          validatePullRequests: validationSequence([blocked]),
        }
      )
    ).rejects.toThrow("PR #88 is not mergeable yet (BLOCKED).");

    expect(repairAttempts).toHaveLength(0);
  });
});

function validationReview(
  headRefOid: string,
  baseRefOid: string,
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
      baseRefOid,
      blockingFindings: input.blockingFindings ?? 0,
      advisoryFindings: input.advisoryFindings ?? 0,
      specSkipped: input.specSkipped ?? true,
      schemaVersion: 2,
      snapshotKey: `snapshot-${headRefOid}`,
      policyDigest: "policy",
      issueContextDigest: "issues",
      runtimeFingerprint: "runtime",
      outcome: input.blockingFindings ? "blocked" : "passed",
    })} -->`,
  };
}

function reviewOnlyValidatedPullRequest(
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
    reviews: [
      validationReview(pr.headRefOid, pr.baseRefOid, {
        blockingFindings: input.validation?.blockingFindings,
        advisoryFindings: input.validation?.advisoryFindings,
      }),
    ],
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
      validationReview(pr.headRefOid, pr.baseRefOid, {
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

function validationSequence(
  pulls: readonly PullRequest[],
  calls?: number[][]
): (pullNumbers: readonly number[]) => Promise<{
  readonly pullRequests: readonly {
    readonly pr: { readonly number: number; readonly headRefOid: string };
    readonly status: "validated";
    readonly outcome: { readonly kind: "passed" };
  }[];
}> {
  let index = 0;
  return async (pullNumbers) => {
    calls?.push([...pullNumbers]);
    const pull = pulls[Math.min(index, pulls.length - 1)];
    index += 1;
    if (!pull) throw new Error("Missing validation result fixture.");
    return {
      pullRequests: pullNumbers.map((number) => ({
        pr: {
          number,
          headRefOid: pull.headRefOid,
        },
        status: "validated",
        outcome: { kind: "passed" },
      })),
    };
  };
}

function githubSequence(
  pulls: readonly (readonly PullRequest[])[],
  calls: string[] = [],
  options: {
    readonly checkEvidence?: readonly PullRequestCheckEvidence[];
    readonly checkEvidenceSequence?: readonly (readonly PullRequestCheckEvidence[])[];
    readonly comments?: string[];
    readonly getPullRequests?: readonly PullRequest[];
    readonly waitForChecks?: PullRequest | readonly PullRequest[];
  } = {}
): GitHubClient {
  let listCalls = 0;
  let getCalls = 0;
  let waitCalls = 0;
  let evidenceCalls = 0;
  const lastNonEmptyPull =
    [...pulls].reverse().find((items) => items.length > 0)?.[0] ??
    pullRequest({});
  let currentPull =
    pulls.find((items) => items.length > 0)?.[0] ?? lastNonEmptyPull;
  return {
    listOpenPullRequests: async () => {
      calls.push("list");
      const index = Math.min(listCalls, pulls.length - 1);
      listCalls += 1;
      const result = [...(pulls[index] ?? [])];
      if (result[0]) currentPull = result[0];
      return result;
    },
    getPullRequest: async (_repo: string, pullNumber: number) => {
      calls.push(`get:${pullNumber}`);
      if (options.getPullRequests) {
        const index = Math.min(getCalls, options.getPullRequests.length - 1);
        getCalls += 1;
        return options.getPullRequests[index] ?? lastNonEmptyPull;
      }
      return currentPull;
    },
    markPullRequestReady: async (_repo: string, pullNumber: number) => {
      calls.push(`ready:${pullNumber}`);
    },
    editPullRequestBase: async (
      _repo: string,
      pullNumber: number,
      baseBranch: string
    ) => {
      calls.push(`edit-base:${pullNumber}:${baseBranch}`);
    },
    getPullRequestCheckEvidence: async () => {
      if (options.checkEvidenceSequence) {
        const index = Math.min(
          evidenceCalls,
          options.checkEvidenceSequence.length - 1
        );
        evidenceCalls += 1;
        return [...(options.checkEvidenceSequence[index] ?? [])];
      }
      return [...(options.checkEvidence ?? [])];
    },
    waitForPullRequestChecks: async (_repo: string, pullNumber: number) => {
      calls.push(`wait-checks:${pullNumber}`);
      if (Array.isArray(options.waitForChecks)) {
        const index = Math.min(waitCalls, options.waitForChecks.length - 1);
        waitCalls += 1;
        const result = options.waitForChecks[index] ?? pullRequest({});
        currentPull = result;
        return result;
      }
      const result =
        (options.waitForChecks as PullRequest | undefined) ??
        pulls.at(-1)?.[0] ??
        pullRequest({});
      currentPull = result;
      return result;
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
    prepareBranchAt: async (branch: string, startPoint: string) => {
      calls.push(`prepare-at:${branch}:${startPoint}`);
    },
    pushVerifiedCommit: async (input: {
      readonly branch: string;
      readonly commit: string;
      readonly expectedRemoteSha: string;
    }) => {
      calls.push(
        `push-verified:${input.branch}:${input.commit}:${input.expectedRemoteSha}`
      );
    },
    deleteLocalBranch: async (branch: string) => {
      calls.push(`delete-local:${branch}`);
    },
    pushBranch: async (branch: string) => {
      calls.push(`push:${branch}`);
    },
    deleteRemoteBranch: async (branch: string) => {
      calls.push(`delete:${branch}`);
    },
    rebaseBranchOntoBase: async (input: {
      readonly branch: string;
      readonly baseBranch: string;
      readonly oldBaseAnchorSha?: string;
    }) => {
      calls.push(
        `rebase:${input.branch}:${input.baseBranch}:${input.oldBaseAnchorSha ?? ""}`
      );
      return "next-base-sha";
    },
    recreateBranchFromBaseDiff: async (input: {
      readonly branch: string;
      readonly baseBranch: string;
      readonly diffBaseRef: string;
    }) => {
      calls.push(
        `recreate:${input.branch}:${input.baseBranch}:${input.diffBaseRef}`
      );
      return "next-base-sha";
    },
    createBranchCommitFromBaseDiff: async (input: {
      readonly branch: string;
      readonly baseBranch: string;
      readonly diffBaseRef: string;
    }) => {
      calls.push(
        `recreate:${input.branch}:${input.baseBranch}:${input.diffBaseRef}`
      );
      return {
        commit: "rebased-head",
        nextBaseAnchorSha: "next-base-sha",
        expectedRemoteSha: "old-head",
      };
    },
    createRebasedCommit: async (input: {
      readonly branch: string;
      readonly baseBranch: string;
      readonly oldBaseAnchorSha?: string;
    }) => {
      calls.push(
        `rebase:${input.branch}:${input.baseBranch}:${input.oldBaseAnchorSha ?? ""}`
      );
      return {
        commit: "rebased-head",
        nextBaseAnchorSha: "next-base-sha",
        expectedRemoteSha: "old-head",
      };
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
    structuredOutput: {
      changedPaths: ["src/a.ts"],
      addressedFindingIds: [],
      summary: "",
      limitations: [],
    },
  };
}

const preparedRuntime: PreparedRuntime = {
  imageName: "test-runtime",
  fingerprint: "test-runtime-fingerprint",
  profile: {
    kind: "image",
    verification: [],
    probes: [],
    fingerprint: "test-runtime-profile",
  },
  verification: [],
  probes: [],
};

const passingRuntime: RuntimeProvider = {
  prepare: async () => preparedRuntime,
};

const passingVerification: VerificationRunner = {
  verify: async () => ({ status: "passed", commands: [] }),
};
