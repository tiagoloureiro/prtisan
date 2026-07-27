import { describe, expect, test } from "bun:test";

import { defaultManifest, ManifestError } from "@/manifest.js";
import { buildOpenPrGraph, type OpenPrGraph } from "@/open-pr-graph.js";
import { InMemoryArtifactStore } from "@/workflow/artifacts.js";
import { InMemoryWorkflowJournal } from "@/workflow/journal.js";
import type {
  FrozenPullRequest,
  PreparationResult,
  RestackResult,
  TrainPlan,
  WorkflowSnapshot,
} from "@/workflow/types.js";
import {
  PrtisanWorkflow,
  SetupRequiredError,
  type WorkflowEnvironment,
  type WorkflowRunResult,
} from "@/workflow/workflow.js";

import { pullRequest } from "./helpers.js";

describe("Prtisan workflow", () => {
  test("runs a newly planned train through one workflow operation", async () => {
    const environment = new FakeEnvironment(rootGraph());
    const workflow = createWorkflow(environment);

    const result = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(result).toMatchObject({
      kind: "train",
      repo: "o/r",
      cwd: "/repo",
      snapshot: {
        outcome: "completed",
        merged: [1],
      },
    });
    expect(result.planId).toStartWith("plan-");
    expect(environment.mergeCalls).toEqual([1]);
  });

  test("resumes the latest checkpointed plan for the repository", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.prepareResult.set(1, {
      kind: "waiting_external",
      blocker: {
        category: "github_checks",
        message: "PR #1 is waiting for required checks.",
        external: true,
      },
    });
    let tick = 0;
    const workflow = createWorkflow(environment, {
      now: () => new Date(1_786_000_000_000 + tick++),
    });

    const waiting = requireTrain(await workflow.run({ cwd: "/repo" }));
    environment.prepareResult.delete(1);
    const completed = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(waiting.snapshot.outcome).toBe("waiting_external");
    expect(completed.planId).toBe(waiting.planId);
    expect(completed.snapshot).toMatchObject({
      outcome: "completed",
      merged: [1],
    });
    expect(environment.mergeCalls).toEqual([1]);
  });

  test("creates fresh authority after the previous train completed", async () => {
    const environment = new FakeEnvironment(rootGraph());
    let tick = 0;
    const workflow = createWorkflow(environment, {
      now: () => new Date(1_786_100_000_000 + tick++),
    });

    const first = requireTrain(await workflow.run({ cwd: "/repo" }));
    const second = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(first.snapshot.outcome).toBe("completed");
    expect(second.snapshot.outcome).toBe("completed");
    expect(second.planId).not.toBe(first.planId);
    expect(environment.mergeCalls).toEqual([1]);
  });

  test("replans and applies when the latest checkpoint became stale", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.prepareResult.set(1, {
      kind: "waiting_external",
      blocker: {
        category: "github_checks",
        message: "PR #1 is waiting for required checks.",
        external: true,
      },
    });
    let tick = 0;
    const workflow = createWorkflow(environment, {
      now: () => new Date(1_786_200_000_000 + tick++),
    });
    const waiting = requireTrain(await workflow.run({ cwd: "/repo" }));

    const added = contractPr({ number: 9, headRefName: "added" });
    environment.add(added);
    environment.replaceGraph(
      buildOpenPrGraph(
        [
          { pr: contractPr({ number: 1, headRefName: "branch-1" }) },
          { pr: added },
        ],
        "main"
      )
    );
    environment.prepareResult.delete(1);

    const completed = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(waiting.snapshot.outcome).toBe("waiting_external");
    expect(completed.planId).not.toBe(waiting.planId);
    expect(completed.snapshot).toMatchObject({
      outcome: "completed",
      merged: [1, 9],
    });
    expect(environment.mergeCalls).toEqual([1, 9]);
  });

  test("returns an onboarding checkpoint when the manifest is missing", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.inspectFailure = new SetupRequiredError(
      ".prtisan/manifest.json is required on origin/main."
    );
    environment.setupCheckpoint = {
      cwd: "/repo",
      repo: "o/r",
      targetBranch: "main",
      setupPr: {
        number: 213,
        url: "https://github.com/o/r/pull/213",
      },
    };
    const workflow = createWorkflow(environment);

    const result = await workflow.run({ cwd: "/repo" });

    expect(result).toEqual({
      kind: "setup",
      cwd: "/repo",
      repo: "o/r",
      outcome: "waiting_external",
      targetBranch: "main",
      setupPr: {
        number: 213,
        url: "https://github.com/o/r/pull/213",
      },
      blocker: {
        category: "policy",
        external: true,
        message: "Merge setup PR #213 so .prtisan/manifest.json reaches main.",
      },
    });
    expect(environment.setupCalls).toBe(1);
    expect(environment.mergeCalls).toEqual([]);
  });

  test("does not replace an invalid repository policy with automatic setup", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.inspectFailure = new ManifestError(
      "origin/main:.prtisan/manifest.json is invalid."
    );
    const workflow = createWorkflow(environment);

    await expect(workflow.run({ cwd: "/repo" })).rejects.toThrow(
      "manifest.json is invalid"
    );
    expect(environment.setupCalls).toBe(0);
  });

  test("resumes a partially merged prefix without repeating effects", async () => {
    const environment = new FakeEnvironment(linearGraph());
    environment.prepareResult.set(2, {
      kind: "waiting_external",
      blocker: {
        category: "human_review",
        message: "PR #2 requires human approval.",
        external: true,
      },
    });
    let tick = 0;
    const workflow = createWorkflow(environment, {
      now: () => new Date(1_786_300_000_000 + tick++),
    });

    const partial = requireTrain(await workflow.run({ cwd: "/repo" }));
    environment.prepareResult.delete(2);
    const completed = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(partial.snapshot).toMatchObject({
      outcome: "partially_completed",
      merged: [1],
    });
    expect(completed.planId).toBe(partial.planId);
    expect(completed.snapshot).toMatchObject({
      outcome: "completed",
      merged: [1, 2],
    });
    expect(environment.mergeCalls).toEqual([1, 2]);
    expect(environment.restackMutations).toEqual([2]);
  });

  test("does not reset an unchanged exhausted repair attempt", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.prepareResult.set(1, {
      kind: "repair_exhausted",
      repairCandidates: 3,
      causeAttempts: { "cause-1": 2 },
      blocker: {
        category: "repair_budget",
        message: "PR #1 exhausted its repair budget.",
        external: false,
      },
    });
    let tick = 0;
    const workflow = createWorkflow(environment, {
      now: () => new Date(1_786_400_000_000 + tick++),
    });

    const first = requireTrain(await workflow.run({ cwd: "/repo" }));
    const second = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(second.planId).toBe(first.planId);
    expect(second.snapshot.outcome).toBe("repair_exhausted");
    expect(second.snapshot.attempts[0]).toMatchObject({
      repairCandidates: 3,
      causeAttempts: { "cause-1": 2 },
    });
    expect(environment.mergeCalls).toEqual([]);
  });

  test("resumes an interrupted external effect without duplicating it", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.failAfterFirstMerge = true;
    let tick = 0;
    const workflow = createWorkflow(environment, {
      now: () => new Date(1_786_500_000_000 + tick++),
    });

    const interrupted = requireTrain(await workflow.run({ cwd: "/repo" }));
    const resumed = requireTrain(await workflow.run({ cwd: "/repo" }));

    expect(interrupted.snapshot.outcome).toBe("infrastructure_failed");
    expect(resumed.planId).toBe(interrupted.planId);
    expect(resumed.snapshot).toMatchObject({
      outcome: "completed",
      merged: [1],
    });
    expect(environment.mergeCalls).toEqual([1]);
  });

  test("plans and idempotently integrates a draft linear stack", async () => {
    const environment = new FakeEnvironment(linearGraph());
    const workflow = createWorkflow(environment);
    const plan = await workflow.plan({ cwd: "/repo" });

    expect(plan.topologicalOrder).toEqual([1, 2]);
    expect(plan.pullRequests[1]?.parent).toBe(1);
    expect(plan.pullRequests[0]?.contract.kind).toBe("pr_body");

    const completed = await workflow.apply(plan.id);
    expect(completed.outcome).toBe("completed");
    expect(completed.merged).toEqual([1, 2]);
    expect(environment.promotions).toEqual([1]);
    expect(environment.mergeCalls).toEqual([1, 2]);
    expect(environment.restackCalls).toEqual([1]);

    const resumed = await workflow.apply(plan.id);
    expect(resumed.outcome).toBe("completed");
    expect(environment.mergeCalls).toEqual([1, 2]);
  });

  test("retains a safely merged prefix when a child reaches an external gate", async () => {
    const environment = new FakeEnvironment(linearGraph());
    environment.prepareResult.set(2, {
      kind: "waiting_external",
      blocker: {
        category: "human_review",
        message: "PR #2 requires human approval.",
        external: true,
      },
    });
    const workflow = createWorkflow(environment);
    const plan = await workflow.plan({ cwd: "/repo" });

    const result = await workflow.apply(plan.id);

    expect(result.outcome).toBe("partially_completed");
    expect(result.merged).toEqual([1]);
    expect(result.blocker).toMatchObject({
      category: "human_review",
      external: true,
    });
    expect(result.nextAction).toContain(`prtisan apply ${plan.id}`);
  });

  test("recovers an effect that merged remotely before the journal completion", async () => {
    const environment = new FakeEnvironment(rootGraph());
    environment.failAfterFirstMerge = true;
    const workflow = createWorkflow(environment);
    const plan = await workflow.plan({ cwd: "/repo" });

    const interrupted = await workflow.apply(plan.id);
    expect(interrupted.outcome).toBe("infrastructure_failed");
    expect(environment.mergeCalls).toEqual([1]);

    const resumed = await workflow.apply(plan.id);
    expect(resumed.outcome).toBe("completed");
    expect(resumed.merged).toEqual([1]);
    expect(environment.mergeCalls).toEqual([1]);
  });

  test("recovers draft promotion and restack effects without duplicate mutations", async () => {
    const environment = new FakeEnvironment(linearGraph());
    environment.failAfterFirstPromotion = true;
    const workflow = createWorkflow(environment);
    const plan = await workflow.plan({ cwd: "/repo" });

    expect((await workflow.apply(plan.id)).outcome).toBe(
      "infrastructure_failed"
    );
    environment.failAfterFirstRestack = true;
    expect((await workflow.apply(plan.id)).outcome).toBe("partially_completed");

    const resumed = await workflow.apply(plan.id);
    expect(resumed.outcome).toBe("completed");
    expect(environment.promotions).toEqual([1]);
    expect(environment.restackMutations).toEqual([2]);
    expect(environment.mergeCalls).toEqual([1, 2]);
  });

  test("rejects multi-parent joins before persisting an executable plan", async () => {
    const graph = buildOpenPrGraph(
      [
        { pr: contractPr({ number: 1, headRefName: "one" }) },
        { pr: contractPr({ number: 2, headRefName: "two" }) },
        {
          pr: contractPr({
            number: 3,
            headRefName: "three",
            baseRefName: "one",
            closingIssuesReferences: [{ number: 30 }],
          }),
          issue: {
            number: 30,
            title: "Join",
            body: "Join both changes",
            state: "OPEN",
            url: "https://github.com/o/r/issues/30",
            labels: [],
            blockedBy: [{ number: 20 }],
            blocking: [],
            subIssues: [],
          },
        },
        {
          pr: contractPr({
            number: 20,
            headRefName: "dependency-via-issue",
            closingIssuesReferences: [{ number: 20 }],
          }),
          issue: {
            number: 20,
            title: "Second parent",
            body: "Second parent",
            state: "OPEN",
            url: "https://github.com/o/r/issues/20",
            labels: [],
            blockedBy: [],
            blocking: [],
            subIssues: [],
          },
        },
      ],
      "main"
    );
    const workflow = createWorkflow(new FakeEnvironment(graph));

    await expect(workflow.plan({ cwd: "/repo" })).rejects.toThrow(
      "multiple open parents"
    );
  });

  test("marks a plan stale when the whole open train gains a PR", async () => {
    const environment = new FakeEnvironment(rootGraph());
    const workflow = createWorkflow(environment);
    const plan = await workflow.plan({ cwd: "/repo" });
    environment.add(contractPr({ number: 9 }));

    const result = await workflow.apply(plan.id);

    expect(result.outcome).toBe("stale");
    expect(result.blocker?.message).toContain("PR #9");
    expect(environment.mergeCalls).toEqual([]);
  });
});

class FakeEnvironment implements WorkflowEnvironment {
  readonly promotions: number[] = [];
  readonly mergeCalls: number[] = [];
  readonly restackCalls: number[] = [];
  readonly restackMutations: number[] = [];
  readonly summaries: { number: number; outcome: string }[] = [];
  readonly prepareResult = new Map<
    number,
    Omit<PreparationResult, "pullRequest">
  >();
  failAfterFirstMerge = false;
  failAfterFirstPromotion = false;
  failAfterFirstRestack = false;
  inspectFailure?: Error;
  setupCheckpoint?: {
    readonly cwd: string;
    readonly repo: string;
    readonly targetBranch: string;
    readonly setupPr: {
      readonly number: number;
      readonly url: string;
    };
  };
  setupCalls = 0;
  private didFailAfterMerge = false;
  private didFailAfterPromotion = false;
  private didFailAfterRestack = false;
  private readonly pullRequests = new Map<
    number,
    ReturnType<typeof pullRequest>
  >();

  constructor(private graph: OpenPrGraph) {
    for (const node of graph.nodes.values()) {
      this.pullRequests.set(node.pr.number, { ...node.pr });
    }
  }

  add(pr: ReturnType<typeof pullRequest>): void {
    this.pullRequests.set(pr.number, pr);
  }

  replaceGraph(graph: OpenPrGraph): void {
    this.graph = graph;
  }

  async inspect() {
    if (this.inspectFailure) throw this.inspectFailure;
    const manifest = defaultManifest({
      commands: [{ name: "Check", command: "bun test", timeoutMs: 60_000 }],
    });
    return {
      cwd: "/repo",
      repo: "o/r",
      targetBranch: "main",
      graph: this.graph,
      manifest: {
        manifest,
        contents: JSON.stringify(manifest),
        digest: "manifest-digest",
        ref: "base:.prtisan/manifest.json",
      },
      requiredChecks: ["check"],
      policyDigest: async () => "policy-digest",
    };
  }

  async setup() {
    this.setupCalls += 1;
    if (!this.setupCheckpoint) {
      throw new Error("Fake setup checkpoint was not configured.");
    }
    return this.setupCheckpoint;
  }

  async listOpenPullRequests(): Promise<
    readonly ReturnType<typeof pullRequest>[]
  > {
    return [...this.pullRequests.values()].filter((pr) => pr.state === "OPEN");
  }

  async getPullRequest(
    _plan: TrainPlan,
    pullNumber: number
  ): Promise<ReturnType<typeof pullRequest>> {
    const pr = this.pullRequests.get(pullNumber);
    if (!pr) throw new Error(`Missing PR #${pullNumber}`);
    return pr;
  }

  async promoteDraft(
    _plan: TrainPlan,
    pullNumber: number
  ): Promise<ReturnType<typeof pullRequest>> {
    const pr = await this.getPullRequest(_plan, pullNumber);
    if (!pr.isDraft) return pr;
    this.promotions.push(pullNumber);
    const ready = { ...pr, isDraft: false };
    this.pullRequests.set(pullNumber, ready);
    if (this.failAfterFirstPromotion && !this.didFailAfterPromotion) {
      this.didFailAfterPromotion = true;
      throw new Error("process stopped after GitHub promoted the draft");
    }
    return ready;
  }

  async prepare(
    plan: TrainPlan,
    frozen: { readonly number: number },
    attempt: { readonly repairCandidates: number }
  ): Promise<PreparationResult> {
    const pr = await this.getPullRequest(plan, frozen.number);
    const selected = this.prepareResult.get(frozen.number);
    return {
      kind: selected?.kind ?? "ready",
      pullRequest: pr,
      repairCandidates: selected?.repairCandidates ?? attempt.repairCandidates,
      causeAttempts: selected?.causeAttempts ?? {},
      blocker: selected?.blocker,
    };
  }

  async merge(
    plan: TrainPlan,
    frozen: { readonly number: number }
  ): Promise<ReturnType<typeof pullRequest>> {
    const current = await this.getPullRequest(plan, frozen.number);
    if (current.state === "MERGED") return current;
    this.mergeCalls.push(frozen.number);
    const merged = { ...current, state: "MERGED" };
    this.pullRequests.set(frozen.number, merged);
    if (this.failAfterFirstMerge && !this.didFailAfterMerge) {
      this.didFailAfterMerge = true;
      throw new Error("process stopped after GitHub accepted the merge");
    }
    return merged;
  }

  async restack(
    plan: TrainPlan,
    frozen: FrozenPullRequest,
    children: readonly FrozenPullRequest[]
  ): Promise<RestackResult> {
    this.restackCalls.push(frozen.number);
    const updates = [];
    for (const child of children) {
      const current = await this.getPullRequest(plan, child.number);
      if (current.baseRefName === "main") {
        updates.push({
          number: child.number,
          headRefOid: current.headRefOid,
          baseRefOid: current.baseRefOid,
          policyDigest: child.policyDigest,
          manifestDigest: child.manifestDigest,
          manifest: child.manifest,
          requiredChecks: child.requiredChecks,
        });
        continue;
      }
      const updated = {
        ...current,
        headRefOid: `${current.headRefOid}-restacked`,
        baseRefName: "main",
        baseRefOid: `main-after-${frozen.number}`,
      };
      this.pullRequests.set(child.number, updated);
      this.restackMutations.push(child.number);
      updates.push({
        number: child.number,
        headRefOid: updated.headRefOid,
        baseRefOid: updated.baseRefOid,
        policyDigest: child.policyDigest,
        manifestDigest: child.manifestDigest,
        manifest: child.manifest,
        requiredChecks: child.requiredChecks,
      });
    }
    if (this.failAfterFirstRestack && !this.didFailAfterRestack) {
      this.didFailAfterRestack = true;
      throw new Error("process stopped after restack publication");
    }
    return { children: updates };
  }

  async updateSummary(
    _plan: TrainPlan,
    pullNumber: number,
    snapshot: WorkflowSnapshot
  ): Promise<void> {
    this.summaries.push({ number: pullNumber, outcome: snapshot.outcome });
  }
}

function createWorkflow(
  environment: WorkflowEnvironment,
  clock = { now: () => new Date("2026-07-27T00:00:00.000Z") }
): PrtisanWorkflow {
  return new PrtisanWorkflow(
    new InMemoryWorkflowJournal(),
    new InMemoryArtifactStore(),
    environment,
    clock
  );
}

function requireTrain(
  result: WorkflowRunResult
): Extract<WorkflowRunResult, { readonly kind: "train" }> {
  if (result.kind !== "train") {
    throw new Error("Expected a train result.");
  }
  return result;
}

function contractPr(
  input: Parameters<typeof pullRequest>[0]
): ReturnType<typeof pullRequest> {
  return pullRequest({
    body: [
      "## Summary",
      "",
      "Implement the planned behaviour.",
      "",
      "## Acceptance criteria",
      "",
      "- The behaviour is verified.",
    ].join("\n"),
    ...input,
  });
}

function rootGraph(): OpenPrGraph {
  return buildOpenPrGraph(
    [{ pr: contractPr({ number: 1, isDraft: true }) }],
    "main"
  );
}

function linearGraph(): OpenPrGraph {
  return buildOpenPrGraph(
    [
      {
        pr: contractPr({
          number: 1,
          isDraft: true,
          headRefName: "parent",
        }),
      },
      {
        pr: contractPr({
          number: 2,
          headRefName: "child",
          baseRefName: "parent",
          baseRefOid: "head-1",
        }),
      },
    ],
    "main"
  );
}
