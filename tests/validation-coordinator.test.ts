import { describe, expect, test } from "bun:test";

import {
  AgentAuthenticationError,
  AgentInfrastructureError,
  AgentOutputError,
  type AgentReviewTask,
  type AgentRunner,
} from "@/agent.js";
import type { GitClient } from "@/git.js";
import type { GitHubClient, PullRequestReviewInput } from "@/github.js";
import type {
  PreparedRuntime,
  RuntimeProvider,
  VerificationRunner,
} from "@/runtime.js";
import type {
  Issue,
  PullRequest,
  ReviewFinding,
  VerificationResult,
} from "@/types.js";
import {
  authorizeFindings,
  ValidationCoordinator,
  type ValidationRequest,
} from "@/validation-coordinator.js";

import { issue, pullRequest, testConfig } from "./helpers.js";

const standardsFinding: ReviewFinding = {
  axis: "standards",
  severity: "advisory",
  title: "Docker check can skip",
  body: "The check skips after a startup failure.",
  rule: "CI checks must fail closed",
  evidence: "first observation",
  path: ".github/workflows/ci.yml",
};

const specFinding: ReviewFinding = {
  axis: "spec",
  severity: "blocking",
  title: "Cancelled CI starts repair",
  body: "Cancelled checks are sent to the repair agent.",
  rule: "Cancelled CI must never launch repair",
  evidence: "cancelled run 101",
  path: "src/github.ts",
};

describe("ValidationCoordinator", () => {
  test("downgrades subjective blockers without contract mapping and evidence", () => {
    const [finding] = authorizeFindings([
      {
        axis: "spec",
        severity: "blocking",
        title: "Maybe simplify",
        body: "A different shape may be nicer.",
      },
    ]);

    expect(finding?.severity).toBe("advisory");
  });

  test("fails preflight without consuming an agent call or publishing", async () => {
    const pr = pullRequest({ number: 117 });
    const agentCalls: string[] = [];
    const githubMutations: string[] = [];
    const gitMutations: string[] = [];
    const coordinator = new ValidationCoordinator({
      github: githubClient(pr, githubMutations),
      git: gitClient(gitMutations),
      agent: agentRunner(agentCalls),
      runtime: {
        prepare: async () => {
          throw new Error("pnpm probe failed: command not found");
        },
      },
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(pr));

    expect(result.outcome.kind).toBe("infra_failed");
    expect(agentCalls).toEqual([]);
    expect(githubMutations).toEqual([]);
    expect(gitMutations.some((call) => call.startsWith("push"))).toBe(false);
  });

  test("propagates authentication failures without recording a PR validation failure", async () => {
    const pr = pullRequest({ number: 117 });
    const coordinator = new ValidationCoordinator({
      github: githubClient(pr),
      git: gitClient([]),
      agent: {
        review: async () => {
          throw new AgentAuthenticationError("/state/prtisan/codex-home");
        },
        repair: async () => {
          throw new Error("repair must not run");
        },
      },
      runtime: passingRuntime,
      verification: passingVerification,
    });

    await expect(coordinator.validate(request(pr))).rejects.toBeInstanceOf(
      AgentAuthenticationError
    );
  });

  test("repairs all deduplicated blockers in one four-call batch", async () => {
    const original = pullRequest({
      number: 117,
      headRefName: "branch-117",
      headRefOid: "head-117",
    });
    const repaired = pullRequest({
      ...original,
      headRefOid: "repair-sha",
    });
    const primaryIssue = issue({
      number: 117,
      title: "Harden validation",
      body: "Cancelled CI must never launch repair.",
    });
    const agentCalls: string[] = [];
    const gitCalls: string[] = [];
    const reviews: PullRequestReviewInput[] = [];
    const reviewInputs: AgentReviewTask[] = [];
    let pushed = false;
    let repairedFindings: readonly ReviewFinding[] = [];
    const github = {
      ...githubClient(original),
      getPullRequest: async () => (pushed ? repaired : original),
      getIssue: async () => primaryIssue,
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        reviews.push(input);
      },
    } as unknown as GitHubClient;
    const agent: AgentRunner = {
      review: async (input) => {
        reviewInputs.push(input);
        const axis = input.kind === "pull-request" ? input.axis : "spec";
        agentCalls.push(`review:${axis}`);
        return {
          axis,
          summary: "",
          findings:
            input.kind === "pull-request" && input.headRefOid === "repair-sha"
              ? []
              : axis === "standards"
                ? [
                    standardsFinding,
                    {
                      ...standardsFinding,
                      severity: "blocking",
                      evidence: "second observation",
                    },
                  ]
                : [specFinding],
          promptChars: 1_000,
        };
      },
      repair: async (input) => {
        agentCalls.push("repair");
        if (input.kind !== "pull-request") {
          throw new Error("unexpected repair kind");
        }
        repairedFindings = input.findings;
        return {
          branch: input.branch,
          commits: ["repair-sha"],
          stdout: "",
          promptChars: 2_000,
          structuredOutput: {
            addressedFindingIds: input.findings.map(
              (finding) => finding.findingId
            ),
            changedPaths: [".github/workflows/ci.yml", "src/github.ts"],
            summary: "Fixed both blockers.",
            limitations: [],
          },
        };
      },
      verifyRepair: async (input) => {
        agentCalls.push("targeted-verifier");
        return {
          summary: "All original findings are resolved.",
          resolvedFindingIds: input.findings.map(
            (finding) => finding.findingId as string
          ),
          findings: [],
        };
      },
    };
    const git = gitClient(gitCalls, () => {
      pushed = true;
    });
    const coordinator = new ValidationCoordinator({
      github,
      git,
      agent,
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(original, primaryIssue));

    expect(result.outcome.kind).toBe("repaired");
    expect(result.outcome.metrics.agentRuns).toBe(2);
    expect(agentCalls).toEqual([
      "review:standards",
      "review:spec",
      "repair",
      "targeted-verifier",
      "review:standards",
      "review:spec",
    ]);
    expect(repairedFindings).toHaveLength(2);
    expect(
      reviewInputs
        .filter(
          (
            input
          ): input is Extract<AgentReviewTask, { kind: "pull-request" }> =>
            input.kind === "pull-request"
        )
        .every((input) => input.diff === "")
    ).toBe(true);
    expect(gitCalls).toContain("push-additive:branch-117:repair-sha:head-117");
    expect(gitCalls.some((call) => call.startsWith("delete:"))).toBe(true);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.commitId).toBe("repair-sha");
  });

  test("blocks a repair commit that fails host verification", async () => {
    const pr = pullRequest({ number: 117 });
    const agentCalls: string[] = [];
    const githubMutations: string[] = [];
    const gitCalls: string[] = [];
    const coordinator = new ValidationCoordinator({
      github: githubClient(pr, githubMutations),
      git: gitClient(gitCalls),
      agent: agentRunner(agentCalls, [specFinding], ["repair-sha"]),
      runtime: passingRuntime,
      verification: verification({
        status: "failed",
        commands: [
          {
            name: "Project check",
            command: "pnpm check",
            exitCode: 1,
            durationMs: 10,
            timedOut: false,
            output: "Docker skip/fail regression",
          },
        ],
      }),
    });

    const result = await coordinator.validate(request(pr));

    expect(result.outcome.kind).toBe("blocked");
    expect(agentCalls).toEqual(["review:standards", "repair"]);
    expect(gitCalls.some((call) => call.startsWith("push:"))).toBe(false);
    expect(gitCalls.some((call) => call.startsWith("delete:"))).toBe(true);
    expect(githubMutations).toEqual([]);
  });

  test("returns stale when the head or base changes after review", async () => {
    const original = pullRequest({ number: 117 });
    const changed = pullRequest({
      ...original,
      baseRefOid: "new-base",
    });
    let reads = 0;
    const github = {
      ...githubClient(original),
      getPullRequest: async () => {
        reads += 1;
        return reads >= 3 ? changed : original;
      },
    } as unknown as GitHubClient;
    const agentCalls: string[] = [];
    const githubMutations: string[] = [];
    const coordinator = new ValidationCoordinator({
      github: {
        ...github,
        createPullRequestReview: async () => {
          githubMutations.push("review");
        },
      } as unknown as GitHubClient,
      git: gitClient(),
      agent: agentRunner(agentCalls),
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(original));

    expect(result.outcome.kind).toBe("stale");
    expect(agentCalls).toEqual(["review:standards"]);
    expect(githubMutations).toEqual([]);
  });

  test("rechecks the snapshot immediately before review publication", async () => {
    const original = pullRequest({ number: 117 });
    const changed = pullRequest({
      ...original,
      headRefOid: "new-head",
    });
    let reads = 0;
    const mutations: string[] = [];
    const github = {
      ...githubClient(original),
      getPullRequest: async () => {
        reads += 1;
        return reads >= 4 ? changed : original;
      },
      createPullRequestReview: async () => {
        mutations.push("review");
      },
    } as unknown as GitHubClient;
    const coordinator = new ValidationCoordinator({
      github,
      git: gitClient(),
      agent: agentRunner([]),
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(original));

    expect(result.outcome.kind).toBe("stale");
    expect(mutations).toEqual([]);
  });

  test("returns stale when the primary issue is edited during review", async () => {
    const pr = pullRequest({ number: 117 });
    const primary = issue({
      number: 117,
      title: "Original",
      body: "Original requirement.",
    });
    let issueReads = 0;
    const github = {
      ...githubClient(pr),
      getIssue: async () => {
        issueReads += 1;
        return issueReads >= 2
          ? { ...primary, body: "Edited requirement." }
          : primary;
      },
    } as unknown as GitHubClient;
    const agentCalls: string[] = [];
    const coordinator = new ValidationCoordinator({
      github,
      git: gitClient(),
      agent: agentRunner(agentCalls),
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(pr, primary));

    expect(result.outcome.kind).toBe("stale");
    expect(agentCalls.toSorted()).toEqual(["review:spec", "review:standards"]);
  });

  test("coalesces concurrent validation and reuses the axis cache", async () => {
    const pr = pullRequest({ number: 117 });
    const agentCalls: string[] = [];
    const reviews: string[] = [];
    const github = githubClient(pr, reviews);
    const coordinator = new ValidationCoordinator({
      github,
      git: gitClient(),
      agent: agentRunner(agentCalls),
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const [first, second] = await Promise.all([
      coordinator.validate(request(pr)),
      coordinator.validate(request(pr)),
    ]);
    const third = await coordinator.validate(request(pr));

    expect(first.outcome.kind).toBe("passed");
    expect(second.outcome.kind).toBe("passed");
    expect(third.outcome.kind).toBe("passed");
    expect(agentCalls).toEqual(["review:standards"]);
    expect(reviews).toHaveLength(2);
    expect(third.outcome.metrics.cacheHits).toBe(1);
  });

  test("keeps repair policy separate while coalescing concurrent reviews", async () => {
    const original = pullRequest({
      number: 117,
      headRefName: "branch-117",
      headRefOid: "head-117",
    });
    const repaired = pullRequest({
      ...original,
      headRefOid: "repair-sha",
    });
    const calls: string[] = [];
    let pushed = false;
    let releaseReview: (() => void) | undefined;
    let reviewStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const github = {
      ...githubClient(original),
      getPullRequest: async () => (pushed ? repaired : original),
    } as unknown as GitHubClient;
    const agent: AgentRunner = {
      review: async (input) => {
        calls.push("review");
        reviewStarted?.();
        await reviewGate;
        return {
          axis: "standards",
          summary: "",
          findings:
            input.kind === "pull-request" && input.headRefOid === "repair-sha"
              ? []
              : [specFinding],
        };
      },
      repair: async (input) => {
        calls.push("repair");
        const findings = input.kind === "pull-request" ? input.findings : [];
        return {
          branch: input.branch,
          commits: ["repair-sha"],
          stdout: "",
          structuredOutput: {
            addressedFindingIds: findings.map((finding) => finding.findingId),
            changedPaths: ["src/github.ts"],
          },
        };
      },
      verifyRepair: async (input) => {
        calls.push("targeted-verifier");
        return {
          summary: "",
          resolvedFindingIds: input.findings.map(
            (finding) => finding.findingId as string
          ),
          findings: [],
        };
      },
    };
    const coordinator = new ValidationCoordinator({
      github,
      git: gitClient([], () => {
        pushed = true;
      }),
      agent,
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const reportOnly = coordinator.validate({
      ...request(original),
      repair: false,
    });
    await started;
    const withRepair = coordinator.validate({
      ...request(original),
      repair: true,
    });
    releaseReview?.();

    const [reported, repairedResult] = await Promise.all([
      reportOnly,
      withRepair,
    ]);

    expect(reported.outcome.kind).toBe("blocked");
    expect(repairedResult.outcome.kind).toBe("repaired");
    expect(calls).toEqual(["review", "repair", "targeted-verifier", "review"]);
  });

  test("runs bounded repair rounds with a full review after every push", async () => {
    let current = pullRequest({
      number: 117,
      headRefName: "branch-117",
      headRefOid: "head-117",
    });
    const calls: string[] = [];
    const pushed: string[] = [];
    const github = {
      ...githubClient(current),
      getPullRequest: async () => current,
    } as unknown as GitHubClient;
    const agent: AgentRunner = {
      review: async (input) => {
        const head =
          input.kind === "pull-request" ? input.headRefOid : "target-branch";
        calls.push(`review:${head}`);
        return {
          axis: "standards",
          summary: "",
          findings: head === "repair-2" ? [] : [specFinding],
        };
      },
      repair: async (input) => {
        const commit =
          current.headRefOid === "head-117" ? "repair-1" : "repair-2";
        calls.push(`repair:${commit}`);
        return {
          branch: input.branch,
          commits: [commit],
          stdout: "",
          structuredOutput: {
            addressedFindingIds:
              input.kind === "pull-request"
                ? input.findings.map((finding) => finding.findingId)
                : [],
            changedPaths: ["src/github.ts"],
            summary: "",
            limitations: [],
          },
        };
      },
      verifyRepair: async (input) => {
        calls.push("targeted-verifier");
        return {
          summary: "",
          resolvedFindingIds: input.findings.map(
            (finding) => finding.findingId as string
          ),
          findings: [],
        };
      },
    };
    const baseGit = gitClient();
    const git = {
      ...baseGit,
      pushAdditiveCommit: async (input: { readonly commit: string }) => {
        pushed.push(input.commit);
        current = { ...current, headRefOid: input.commit };
      },
    } as unknown as GitClient;
    const coordinator = new ValidationCoordinator({
      github,
      git,
      agent,
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(current));

    expect(result.outcome.kind).toBe("repaired");
    expect(pushed).toEqual(["repair-1", "repair-2"]);
    expect(calls).toEqual([
      "review:head-117",
      "repair:repair-1",
      "targeted-verifier",
      "review:repair-1",
      "repair:repair-2",
      "targeted-verifier",
      "review:repair-2",
    ]);
  });

  test("converts malformed structured agent output into needs_human", async () => {
    const pr = pullRequest({ number: 117 });
    const coordinator = new ValidationCoordinator({
      github: githubClient(pr),
      git: gitClient(),
      agent: {
        review: async () => {
          throw new AgentOutputError("Malformed review JSON after retry.");
        },
        repair: async () => {
          throw new Error("repair should not run");
        },
      },
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(pr));

    expect(result.outcome).toMatchObject({
      kind: "needs_human",
      reason: "Malformed review JSON after retry.",
    });
  });

  test("counts bootstrap failure as zero agent calls", async () => {
    const pr = pullRequest({ number: 117 });
    const coordinator = new ValidationCoordinator({
      github: githubClient(pr),
      git: gitClient(),
      agent: {
        review: async () => {
          throw new AgentInfrastructureError(
            "onSandboxReady bootstrap exited with code 127"
          );
        },
        repair: async () => {
          throw new Error("repair should not run");
        },
      },
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(pr));

    expect(result.outcome.kind).toBe("infra_failed");
    expect(result.outcome.metrics.agentRuns).toBe(0);
  });

  test("does not push when the PR changes immediately before publication", async () => {
    const original = pullRequest({ number: 117 });
    const changed = pullRequest({
      ...original,
      headRefOid: "concurrent-head",
    });
    let reads = 0;
    const github = {
      ...githubClient(original),
      getPullRequest: async () => {
        reads += 1;
        return reads >= 4 ? changed : original;
      },
    } as unknown as GitHubClient;
    const gitCalls: string[] = [];
    const coordinator = new ValidationCoordinator({
      github,
      git: gitClient(gitCalls),
      agent: agentRunner([], [specFinding], ["repair-sha"]),
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const result = await coordinator.validate(request(original));

    expect(result.outcome.kind).toBe("stale");
    expect(gitCalls.some((call) => call.startsWith("push:"))).toBe(false);
    expect(gitCalls.some((call) => call.startsWith("delete:"))).toBe(true);
  });

  test("persists needs_human so a surviving finding cannot launch another agent batch", async () => {
    let current = pullRequest({ number: 117 });
    const agentCalls: string[] = [];
    const github = {
      ...githubClient(current),
      getPullRequest: async () => current,
      createPullRequestReview: async (input: PullRequestReviewInput) => {
        current = {
          ...current,
          latestReviews: [
            {
              state:
                input.event === "REQUEST_CHANGES"
                  ? "CHANGES_REQUESTED"
                  : "COMMENTED",
              body: input.body,
            },
          ],
        };
      },
    } as unknown as GitHubClient;
    const coordinator = new ValidationCoordinator({
      github,
      git: gitClient(),
      agent: agentRunner(agentCalls, [specFinding], []),
      runtime: passingRuntime,
      verification: passingVerification,
    });

    const first = await coordinator.validate(request(current));
    const second = await coordinator.validate(request(current));

    expect(first.outcome.kind).toBe("needs_human");
    expect(second.outcome.kind).toBe("needs_human");
    expect(second.outcome.metrics.cacheHits).toBe(1);
    expect(agentCalls).toEqual(["review:standards", "repair"]);
  });
});

function request(pr: PullRequest, primaryIssue?: Issue): ValidationRequest {
  return {
    cwd: "/repo",
    config: testConfig(),
    runId: "branch-117-replay",
    prNumber: pr.number,
    issue: primaryIssue,
    relatedIssues: [],
    repair: true,
  };
}

function githubClient(pr: PullRequest, mutations: string[] = []): GitHubClient {
  return {
    getPullRequest: async () => pr,
    getPullRequestDiff: async () =>
      [
        "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
        "diff --git a/src/github.ts b/src/github.ts",
      ].join("\n"),
    createPullRequestReview: async () => {
      mutations.push("review");
    },
  } as unknown as GitHubClient;
}

function gitClient(calls: string[] = [], onPush?: () => void): GitClient {
  return {
    prepareBranchFromBase: async (branch: string, base: string) => {
      calls.push(`prepare:${branch}:${base}`);
    },
    readStandardsAtRef: async () => ["AGENTS.md\nFail closed."],
    prepareBranchAt: async (branch: string, startPoint: string) => {
      calls.push(`prepare-at:${branch}:${startPoint}`);
    },
    pushVerifiedCommit: async (input: {
      readonly branch: string;
      readonly commit: string;
      readonly expectedRemoteSha: string;
    }) => {
      calls.push(
        `push:${input.branch}:${input.commit}:${input.expectedRemoteSha}`
      );
      onPush?.();
    },
    pushAdditiveCommit: async (input: {
      readonly branch: string;
      readonly commit: string;
      readonly expectedRemoteSha: string;
    }) => {
      calls.push(
        `push-additive:${input.branch}:${input.commit}:${input.expectedRemoteSha}`
      );
      onPush?.();
    },
    deleteLocalBranch: async (branch: string) => {
      calls.push(`delete:${branch}`);
    },
  } as unknown as GitClient;
}

function agentRunner(
  calls: string[],
  findings: readonly ReviewFinding[] = [],
  commits: readonly string[] = []
): AgentRunner {
  return {
    review: async (input) => {
      const axis = input.axis;
      calls.push(`review:${axis}`);
      return { axis, summary: "", findings };
    },
    repair: async (input) => {
      calls.push("repair");
      const repairFindings =
        input.kind === "pull-request" ? input.findings : [];
      return {
        branch: input.branch,
        commits,
        stdout: "",
        structuredOutput: {
          addressedFindingIds: repairFindings.map(
            (finding) => finding.findingId
          ),
          changedPaths: ["src/github.ts"],
          summary: "",
          limitations: [],
        },
      };
    },
    verifyRepair: async (input) => {
      calls.push("targeted-verifier");
      return {
        summary: "",
        resolvedFindingIds: input.findings.map(
          (finding) => finding.findingId as string
        ),
        findings: [],
      };
    },
  };
}

const preparedRuntime: PreparedRuntime = {
  imageName: "runtime:test",
  fingerprint: "runtime-fingerprint",
  profile: {
    kind: "image",
    verification: [
      {
        name: "Project check",
        command: "pnpm check",
        timeoutMs: 60_000,
      },
    ],
    probes: [],
    fingerprint: "runtime-profile",
  },
  verification: [
    {
      name: "Project check",
      command: "pnpm check",
      timeoutMs: 60_000,
    },
  ],
  probes: [],
};

const passingRuntime: RuntimeProvider = {
  prepare: async () => preparedRuntime,
};

const passingVerification: VerificationRunner = verification({
  status: "passed",
  commands: [],
});

function verification(result: VerificationResult): VerificationRunner {
  return {
    verify: async () => result,
  };
}
