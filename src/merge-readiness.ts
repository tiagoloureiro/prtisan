import type { AgentRunner } from "./agent.js";
import type { GitClient } from "./git.js";
import {
  actionablePullRequestCheckEvidence,
  ciFailureEvidenceSignature,
  ciFailureFingerprint,
  type GitHubClient,
  pullRequestCheckStatus,
  pullRequestReadinessBlockers,
} from "./github.js";
import {
  loadOpenPrGraph,
  type OpenPrGraph,
  type OpenPrNode,
} from "./open-pr-graph.js";
import {
  InMemoryRepairAttemptStore,
  type RepairAttemptStore,
} from "./repair-attempt-store.js";
import type { RuntimeProvider, VerificationRunner } from "./runtime.js";
import type {
  AgentRunOutcome,
  AgentTrainConfig,
  PullRequest,
  PullRequestCheckEvidence,
} from "./types.js";

export interface MergeReadinessInput {
  readonly cwd: string;
  readonly config: AgentTrainConfig;
  readonly graph: OpenPrGraph;
  readonly prNumber: number;
  readonly runId: string;
}

export interface MergeReadinessDeps {
  readonly github: GitHubClient;
  readonly git: GitClient;
  readonly agent?: AgentRunner;
  readonly runtime?: RuntimeProvider;
  readonly verification?: VerificationRunner;
  readonly repairAttempts?: RepairAttemptStore;
  readonly validatePullRequests?: (
    pullNumbers: readonly number[]
  ) => Promise<PullRequestValidationGateResult>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface PullRequestValidationGateResult {
  readonly pullRequests: readonly {
    readonly pr: {
      readonly number: number;
      readonly headRefOid: string;
    };
    readonly status: "validated" | "validation_failed";
    readonly outcome?: {
      readonly kind: string;
      readonly reason?: string;
    };
  }[];
}

export interface ReadyPullRequest {
  readonly graph: OpenPrGraph;
  readonly node: OpenPrNode;
}

const CHECK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const CHECK_WAIT_INTERVAL_MS = 15_000;
const POST_REPAIR_HEAD_REFRESH_ATTEMPTS = 10;
const POST_REPAIR_HEAD_REFRESH_INTERVAL_MS = 2_000;
const MERGE_STATE_REPAIR_LIMIT = 1;
const UNKNOWN_REFRESH_BACKOFF_MS = [2_000, 5_000, 10_000] as const;
const REPAIRABLE_MERGE_STATES = new Set(["BEHIND", "DIRTY", "UNKNOWN"]);

export async function preparePullRequestForMerge(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps
): Promise<ReadyPullRequest> {
  let currentGraph = input.graph;
  const repairAttempts =
    deps.repairAttempts ?? new InMemoryRepairAttemptStore();
  let mergeStateRepairAttempts = 0;
  const validationAttempts = new Set<string>();

  while (true) {
    let node = currentGraph.nodes.get(input.prNumber);
    if (!node) {
      currentGraph = await loadCurrentGraph(input, deps);
      node = currentGraph.nodes.get(input.prNumber);
      if (!node) {
        throw new Error(`PR #${input.prNumber} is no longer open.`);
      }
    }

    if (node.pr.isDraft) {
      deps.log?.(`Marking PR #${node.pr.number} ready for review`);
      await deps.github.markPullRequestReady(input.config.repo, node.pr.number);
      currentGraph = await loadCurrentGraph(input, deps);
      continue;
    }

    if (
      node.blockers.length === 0 &&
      node.pr.baseRefName !== input.config.targetBranch
    ) {
      currentGraph = await restackFrontierOntoTarget(input, deps, node);
      continue;
    }

    const validationKey = `${node.pr.baseRefOid}:${node.pr.headRefOid}`;
    if (
      validationNeedsCoordinatorCheck(node) &&
      !validationAttempts.has(validationKey)
    ) {
      validationAttempts.add(validationKey);
      currentGraph =
        (await validateCurrentPullRequest(input, deps, node)) ?? currentGraph;
      continue;
    }
    if (validationNeedsRepair(node)) {
      if (validationAttempts.has(validationKey)) {
        throw new Error(
          formatReadinessBlockers(node.pr.number, [
            ...validationBlockers(node),
            `Validation already ran once for snapshot ${shortSha(node.pr.baseRefOid)}..${shortSha(node.pr.headRefOid)}.`,
          ])
        );
      }
    }

    const reviewBlocker = requiredReviewBlocker(node.pr);
    if (reviewBlocker) {
      throw new Error(reviewBlocker);
    }

    const checks = pullRequestCheckStatus(node.pr);
    if (checks.pending.length > 0) {
      deps.log?.(`Waiting for PR #${node.pr.number} checks to settle`);
      await deps.github.waitForPullRequestChecks(
        input.config.repo,
        node.pr.number,
        CHECK_WAIT_TIMEOUT_MS,
        CHECK_WAIT_INTERVAL_MS
      );
      currentGraph = await loadCurrentGraph(input, deps);
      continue;
    }

    if (checks.failed.length > 0) {
      const allEvidence = await deps.github.getPullRequestCheckEvidence(
        input.config.repo,
        node.pr
      );
      const evidence = actionablePullRequestCheckEvidence(allEvidence, {
        maxLogChars: input.config.validation.maxCheckLogChars,
        maxTotalChars: input.config.validation.maxCheckEvidenceChars,
      });
      if (evidence.length === 0) {
        await postUnresolvedCiRepairComment(input, deps, node.pr, allEvidence);
        throw new Error(
          `PR #${node.pr.number} has failing checks, but none is an actionable completed code failure with logs.`
        );
      }
      const fingerprint = ciFailureFingerprint(node.pr.headRefOid, evidence);
      const evidenceSignature = ciFailureEvidenceSignature(evidence);
      currentGraph = await repairCiFailure(
        input,
        deps,
        node,
        evidence,
        fingerprint,
        evidenceSignature,
        repairAttempts
      );
      continue;
    }

    const mergeState = repairableMergeState(node.pr);
    if (mergeState) {
      if (mergeState === "UNKNOWN") {
        currentGraph = await refreshUnknownMergeState(input, deps, node);
        const refreshed = currentGraph.nodes.get(node.pr.number);
        if (refreshed?.pr.mergeStateStatus?.toUpperCase() === "UNKNOWN") {
          throw new Error(
            `PR #${node.pr.number} remained UNKNOWN after bounded refresh.`
          );
        }
        continue;
      }
      if (mergeStateRepairAttempts >= MERGE_STATE_REPAIR_LIMIT) {
        throw new Error(
          `PR #${node.pr.number} is still not mergeable (${mergeState}) after ${MERGE_STATE_REPAIR_LIMIT} merge-state repair attempt(s).`
        );
      }

      mergeStateRepairAttempts += 1;
      currentGraph = await repairMergeState(
        input,
        deps,
        node,
        mergeState,
        mergeStateRepairAttempts
      );
      continue;
    }

    assertReadyToMerge(node);
    return { graph: currentGraph, node };
  }
}

async function restackFrontierOntoTarget(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode
): Promise<OpenPrGraph> {
  deps.log?.(
    `Restacking PR #${node.pr.number} from ${node.pr.baseRefName} onto ${input.config.targetBranch}`
  );
  const diffBaseRef = node.pr.baseRefOid || node.pr.baseRefName;
  const prepared = await deps.git.createBranchCommitFromBaseDiff({
    runId: input.runId,
    label: `restack-pr-${node.pr.number}-to-target`,
    branch: node.pr.headRefName,
    baseBranch: input.config.targetBranch,
    diffBaseRef,
    commitMessage: `Restack PR #${node.pr.number} onto ${input.config.targetBranch}`,
  });
  await verifyDeterministicCommit(
    input,
    deps,
    node.pr,
    prepared.commit,
    `restack-pr-${node.pr.number}`
  );
  await assertPullRequestHead(deps, input.config.repo, node.pr);
  await deps.git.pushVerifiedCommit({
    branch: node.pr.headRefName,
    commit: prepared.commit,
    expectedRemoteSha: node.pr.headRefOid,
  });
  await deps.github.editPullRequestBase(
    input.config.repo,
    node.pr.number,
    input.config.targetBranch
  );
  deps.log?.(
    `Retargeted PR #${node.pr.number} from ${node.pr.baseRefName} to ${input.config.targetBranch} at ${prepared.nextBaseAnchorSha}`
  );
  return loadCurrentGraph(input, deps);
}

async function validateCurrentPullRequest(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode
): Promise<OpenPrGraph | undefined> {
  if (!deps.validatePullRequests) {
    throw new Error(
      `PR #${node.pr.number} needs agent-train validation, but merge was not configured with a validation runner.`
    );
  }

  deps.log?.(`Validating PR #${node.pr.number} before merge`);
  const result = await deps.validatePullRequests([node.pr.number]);
  const validation = result.pullRequests.find(
    (item) => item.pr.number === node.pr.number
  );
  if (!validation || validation.status !== "validated") {
    const reason =
      validation?.outcome?.reason ??
      validation?.outcome?.kind ??
      "validation did not return a successful result";
    throw new Error(
      `PR #${node.pr.number} failed authoritative validation before merge: ${reason}.`
    );
  }
  if (
    (node.validation.state === "passed" ||
      node.validation.state === "commented") &&
    validation.pr.headRefOid === node.pr.headRefOid
  ) {
    return undefined;
  }
  const graph = await loadCurrentGraph(input, deps);
  const refreshed = graph.nodes.get(node.pr.number);
  if (!refreshed) return graph;

  return graph;
}

async function repairCiFailure(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode,
  evidence: readonly PullRequestCheckEvidence[],
  fingerprint: string,
  evidenceSignature: string,
  repairAttempts: RepairAttemptStore
): Promise<OpenPrGraph> {
  const agent = requireAgent(deps);
  const { runtime, verification } = await prepareRepairEnvironment(
    input,
    deps,
    node.pr
  );
  const repairBranch = `agent-train/repair/ci-${node.pr.number}-${safeRunId(
    input.runId
  )}`;
  await deps.git.prepareBranchAt(repairBranch, node.pr.headRefOid);

  try {
    if (
      !(await repairAttempts.claim(`ci:fingerprint:${fingerprint}`)) ||
      !(await repairAttempts.claim(`ci:evidence:${evidenceSignature}`))
    ) {
      await postUnresolvedCiRepairComment(input, deps, node.pr, evidence);
      throw new Error(
        `PR #${node.pr.number} CI failure already consumed its single repair attempt.`
      );
    }
    deps.log?.(`Repairing failing CI for PR #${node.pr.number}`);
    const outcome = await agent.repair({
      kind: "ci-failure",
      cwd: input.cwd,
      config: input.config,
      runId: input.runId,
      issue: node.issue,
      relatedIssues: node.relatedIssues,
      prNumber: node.pr.number,
      branch: repairBranch,
      baseBranch: node.pr.headRefName,
      checkEvidence: evidence,
      runtime,
    });

    if (outcome.commits.length === 0) {
      await postUnresolvedCiRepairComment(
        input,
        deps,
        node.pr,
        evidence,
        outcome
      );
      throw new Error(
        `PR #${node.pr.number} still has ${pullRequestCheckStatus(node.pr).failed.length} failing status check(s); CI repair produced no commits.`
      );
    }
    if (!validChangedPathsReport(outcome.structuredOutput)) {
      throw new Error(
        `PR #${node.pr.number} CI repair did not return a valid changedPaths report.`
      );
    }

    const repairedCommit = outcome.commits.at(-1) as string;
    const repairedRuntime = await requireRuntime(deps, node.pr.number).prepare({
      cwd: input.cwd,
      ref: repairedCommit,
      config: input.config,
    });
    const verificationResult = await verification.verify({
      cwd: input.cwd,
      runId: input.runId,
      label: `ci-pr-${node.pr.number}`,
      ref: repairedCommit,
      config: input.config,
      runtime: repairedRuntime,
    });
    if (verificationResult.status !== "passed") {
      throw new Error(
        `PR #${node.pr.number} CI repair failed host verification: ${verificationSummary(
          verificationResult
        )}`
      );
    }

    const current = await deps.github.getPullRequest(
      input.config.repo,
      node.pr.number
    );
    if (current.headRefOid !== node.pr.headRefOid) {
      throw new Error(
        `PR #${node.pr.number} changed while CI repair was running; verified commit was not pushed.`
      );
    }
    await deps.git.pushVerifiedCommit({
      branch: node.pr.headRefName,
      commit: repairedCommit,
      expectedRemoteSha: node.pr.headRefOid,
    });
    await waitForPullRequestHead(input, deps, node.pr.number, repairedCommit);
    const checked = await deps.github.waitForPullRequestChecks(
      input.config.repo,
      node.pr.number,
      CHECK_WAIT_TIMEOUT_MS,
      CHECK_WAIT_INTERVAL_MS
    );
    const checkedStatus = pullRequestCheckStatus(checked);
    if (checkedStatus.failed.length > 0) {
      await postUnresolvedCiRepairComment(
        input,
        deps,
        checked,
        await deps.github.getPullRequestCheckEvidence(
          input.config.repo,
          checked
        ),
        outcome
      );
      throw new Error(
        `PR #${node.pr.number} still has ${checkedStatus.failed.length} failing status check(s) after CI repair.`
      );
    }

    return loadCurrentGraph(input, deps);
  } finally {
    await deps.git.deleteLocalBranch(repairBranch);
  }
}

async function waitForPullRequestHead(
  input: Pick<MergeReadinessInput, "config">,
  deps: Pick<MergeReadinessDeps, "github" | "log">,
  pullNumber: number,
  expectedHeadRefOid: string | undefined
): Promise<PullRequest> {
  let pr = await deps.github.getPullRequest(input.config.repo, pullNumber);
  if (
    !expectedHeadRefOid ||
    headMatchesExpected(pr.headRefOid, expectedHeadRefOid)
  ) {
    return pr;
  }

  for (
    let attempt = 1;
    attempt < POST_REPAIR_HEAD_REFRESH_ATTEMPTS;
    attempt++
  ) {
    deps.log?.(
      `Waiting for PR #${pullNumber} head to update from ${shortSha(
        pr.headRefOid
      )} to ${shortSha(expectedHeadRefOid)}`
    );
    await Bun.sleep(POST_REPAIR_HEAD_REFRESH_INTERVAL_MS);
    pr = await deps.github.getPullRequest(input.config.repo, pullNumber);
    if (headMatchesExpected(pr.headRefOid, expectedHeadRefOid)) return pr;
  }

  throw new Error(
    `PR #${pullNumber} still reports head ${shortSha(
      pr.headRefOid
    )} after repair pushed ${shortSha(expectedHeadRefOid)}.`
  );
}

async function repairMergeState(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode,
  mergeState: string,
  attempt: number
): Promise<OpenPrGraph> {
  if (mergeState === "BEHIND") {
    deps.log?.(`Rebasing PR #${node.pr.number} onto ${node.pr.baseRefName}`);
    const prepared = await deps.git.createRebasedCommit({
      runId: input.runId,
      label: `merge-behind-${node.pr.number}`,
      branch: node.pr.headRefName,
      baseBranch: node.pr.baseRefName,
      oldBaseAnchorSha: node.pr.baseRefOid,
    });
    await verifyDeterministicCommit(
      input,
      deps,
      node.pr,
      prepared.commit,
      `behind-pr-${node.pr.number}`
    );
    await assertPullRequestHead(deps, input.config.repo, node.pr);
    await deps.git.pushVerifiedCommit({
      branch: node.pr.headRefName,
      commit: prepared.commit,
      expectedRemoteSha: node.pr.headRefOid,
    });
    await waitForPullRequestHead(input, deps, node.pr.number, prepared.commit);
    await deps.github.waitForPullRequestChecks(
      input.config.repo,
      node.pr.number,
      CHECK_WAIT_TIMEOUT_MS,
      CHECK_WAIT_INTERVAL_MS
    );
    return loadCurrentGraph(input, deps);
  }

  const agent = requireAgent(deps);
  const { runtime, verification } = await prepareRepairEnvironment(
    input,
    deps,
    node.pr
  );
  const repairBranch = `agent-train/repair/merge-${node.pr.number}-${safeRunId(
    input.runId
  )}`;
  await deps.git.prepareBranchAt(repairBranch, node.pr.headRefOid);

  try {
    deps.log?.(
      `Repairing merge state ${mergeState} for PR #${node.pr.number} (attempt ${attempt}/${MERGE_STATE_REPAIR_LIMIT})`
    );
    const outcome = await agent.repair({
      kind: "merge-state",
      cwd: input.cwd,
      config: input.config,
      runId: input.runId,
      issue: node.issue,
      relatedIssues: node.relatedIssues,
      prNumber: node.pr.number,
      branch: repairBranch,
      baseBranch: node.pr.headRefName,
      mergeState,
      blockers: pullRequestReadinessBlockers(node.pr),
      runtime,
    });

    if (outcome.commits.length === 0) {
      throw new Error(
        `PR #${node.pr.number} is still not mergeable (${mergeState}); merge-state repair produced no commits.`
      );
    }
    if (!validChangedPathsReport(outcome.structuredOutput)) {
      throw new Error(
        `PR #${node.pr.number} merge-state repair did not return a valid changedPaths report.`
      );
    }
    const repairedCommit = outcome.commits.at(-1) as string;
    const repairedRuntime = await requireRuntime(deps, node.pr.number).prepare({
      cwd: input.cwd,
      ref: repairedCommit,
      config: input.config,
    });
    const verificationResult = await verification.verify({
      cwd: input.cwd,
      runId: input.runId,
      label: `merge-pr-${node.pr.number}`,
      ref: repairedCommit,
      config: input.config,
      runtime: repairedRuntime,
    });
    if (verificationResult.status !== "passed") {
      throw new Error(
        `PR #${node.pr.number} merge-state repair failed host verification: ${verificationSummary(
          verificationResult
        )}`
      );
    }
    const current = await deps.github.getPullRequest(
      input.config.repo,
      node.pr.number
    );
    if (current.headRefOid !== node.pr.headRefOid) {
      throw new Error(
        `PR #${node.pr.number} changed during merge-state repair; verified commit was not pushed.`
      );
    }
    await deps.git.pushVerifiedCommit({
      branch: node.pr.headRefName,
      commit: repairedCommit,
      expectedRemoteSha: node.pr.headRefOid,
    });
    await waitForPullRequestHead(input, deps, node.pr.number, repairedCommit);
    await deps.github.waitForPullRequestChecks(
      input.config.repo,
      node.pr.number,
      CHECK_WAIT_TIMEOUT_MS,
      CHECK_WAIT_INTERVAL_MS
    );
    return loadCurrentGraph(input, deps);
  } finally {
    await deps.git.deleteLocalBranch(repairBranch);
  }
}

async function refreshUnknownMergeState(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode
): Promise<OpenPrGraph> {
  deps.log?.(`Refreshing unknown merge state for PR #${node.pr.number}`);
  let graph = await loadCurrentGraph(input, deps);
  const sleep = deps.sleep ?? Bun.sleep;
  for (const delay of UNKNOWN_REFRESH_BACKOFF_MS) {
    const refreshed = graph.nodes.get(node.pr.number);
    if (refreshed?.pr.mergeStateStatus?.toUpperCase() !== "UNKNOWN") {
      return graph;
    }
    await sleep(delay);
    graph = await loadCurrentGraph(input, deps);
  }
  return graph;
}

async function verifyDeterministicCommit(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  pr: PullRequest,
  commit: string,
  label: string
): Promise<void> {
  const { runtime, verification } = await prepareRepairEnvironment(
    input,
    deps,
    pr,
    commit
  );
  const result = await verification.verify({
    cwd: input.cwd,
    runId: input.runId,
    label,
    ref: commit,
    config: input.config,
    runtime,
  });
  if (result.status !== "passed") {
    throw new Error(
      `PR #${pr.number} deterministic branch update failed host verification: ${verificationSummary(
        result
      )}`
    );
  }
}

async function assertPullRequestHead(
  deps: Pick<MergeReadinessDeps, "github">,
  repo: string,
  expected: PullRequest
): Promise<void> {
  const current = await deps.github.getPullRequest(repo, expected.number);
  if (
    current.headRefOid !== expected.headRefOid ||
    current.baseRefOid !== expected.baseRefOid
  ) {
    throw new Error(
      `PR #${expected.number} changed during deterministic branch preparation; nothing was pushed.`
    );
  }
}

async function loadCurrentGraph(
  input: Pick<MergeReadinessInput, "config">,
  deps: Pick<MergeReadinessDeps, "github">
): Promise<OpenPrGraph> {
  return loadOpenPrGraph({
    github: deps.github,
    repo: input.config.repo,
    targetBranch: input.config.targetBranch,
    concurrency: input.config.concurrency.github,
  });
}

function assertReadyToMerge(node: OpenPrNode): void {
  const blockers = validationBlockers(node);

  blockers.push(...pullRequestReadinessBlockers(node.pr));

  if (blockers.length > 1) {
    throw new Error(formatReadinessBlockers(node.pr.number, blockers));
  }
  if (blockers.length === 1) {
    throw new Error(blockers[0] as string);
  }
}

function validationNeedsRepair(node: OpenPrNode): boolean {
  return ["missing", "stale"].includes(node.validation.state);
}

function validationNeedsCoordinatorCheck(node: OpenPrNode): boolean {
  return ["missing", "stale", "passed", "commented"].includes(
    node.validation.state
  );
}

function validationBlockers(node: OpenPrNode): string[] {
  const validation = node.validation;
  if (validation.state === "missing") {
    return [`PR #${node.pr.number} has no agent-train validation review yet.`];
  }
  if (validation.state === "stale") {
    return [
      `PR #${node.pr.number} has no current agent-train validation review for head ${shortSha(node.pr.headRefOid)}.`,
    ];
  }
  if (validation.state === "blocked") {
    return [
      `PR #${node.pr.number} has ${validation.blockingFindings} blocking agent validation finding(s).`,
    ];
  }
  if (
    validation.state === "infra_failed" ||
    validation.state === "budget_exhausted" ||
    validation.state === "needs_human"
  ) {
    return [
      `PR #${node.pr.number} validation stopped with ${validation.state}; resolve the recorded cause before merging.`,
    ];
  }
  return [];
}

function requiredReviewBlocker(pr: PullRequest): string | undefined {
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return `PR #${pr.number} has requested changes.`;
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return `PR #${pr.number} is still waiting for required review approval.`;
  }
  return undefined;
}

function repairableMergeState(pr: PullRequest): string | undefined {
  const mergeState = pr.mergeStateStatus?.toUpperCase();
  if (!mergeState || !REPAIRABLE_MERGE_STATES.has(mergeState)) {
    return undefined;
  }
  return mergeState;
}

function requireAgent(deps: MergeReadinessDeps): AgentRunner {
  if (!deps.agent) {
    throw new Error(
      "PR repair is required, but merge was not configured with an agent runner."
    );
  }
  return deps.agent;
}

async function prepareRepairEnvironment(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  pr: PullRequest,
  ref = pr.headRefOid
): Promise<{
  readonly runtime: Awaited<ReturnType<RuntimeProvider["prepare"]>>;
  readonly verification: VerificationRunner;
}> {
  if (!deps.runtime || !deps.verification) {
    throw new Error(
      `PR #${pr.number} repair requires an authoritative target runtime and host verification runner.`
    );
  }
  const runtime = await deps.runtime.prepare({
    cwd: input.cwd,
    ref,
    config: input.config,
  });
  return { runtime, verification: deps.verification };
}

function requireRuntime(
  deps: MergeReadinessDeps,
  prNumber: number
): RuntimeProvider {
  if (!deps.runtime) {
    throw new Error(
      `PR #${prNumber} repair requires an authoritative target runtime.`
    );
  }
  return deps.runtime;
}

async function postUnresolvedCiRepairComment(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  pr: PullRequest,
  evidence: readonly PullRequestCheckEvidence[],
  outcome?: AgentRunOutcome
): Promise<void> {
  const failed = pullRequestCheckStatus(pr).failed;
  await deps.github.createPullRequestComment(
    input.config.repo,
    pr.number,
    unresolvedCiRepairComment({
      failedChecks: evidence.length > 0 ? evidence : failed,
      outcome,
    })
  );
}

function unresolvedCiRepairComment(input: {
  readonly failedChecks: readonly PullRequestCheckEvidence[];
  readonly outcome?: AgentRunOutcome;
}): string {
  const lines = [
    "Agent train could not make CI green for this PR.",
    "",
    "Failed checks:",
    ...input.failedChecks.map(
      (check) =>
        `- ${check.name}: ${check.conclusion ?? check.status}${
          check.detailsUrl ? ` (${check.detailsUrl})` : ""
        }`
    ),
  ];

  if (input.outcome?.commits.length) {
    lines.push("", `Repair commits: ${input.outcome.commits.join(", ")}`);
  } else {
    lines.push("", "Repair commits: none");
  }
  return lines.join("\n");
}

function validChangedPathsReport(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const changedPaths = (value as Record<string, unknown>).changedPaths;
  return (
    Array.isArray(changedPaths) &&
    changedPaths.every((path) => typeof path === "string")
  );
}

function verificationSummary(
  result: Awaited<ReturnType<VerificationRunner["verify"]>>
): string {
  const failed = result.commands.find((command) => command.exitCode !== 0);
  return failed
    ? `${failed.name} exited ${failed.exitCode}: ${failed.output}`
    : result.status;
}

function safeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48);
}

function formatReadinessBlockers(
  prNumber: number,
  blockers: readonly string[]
): string {
  if (blockers.length === 1) return blockers[0] as string;
  return [
    `PR #${prNumber} is not ready to merge:`,
    ...blockers.map((blocker) => `- ${blocker}`),
  ].join("\n");
}

function headMatchesExpected(
  headRefOid: string,
  expectedHeadRefOid: string
): boolean {
  return (
    headRefOid === expectedHeadRefOid ||
    headRefOid.startsWith(expectedHeadRefOid)
  );
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}
