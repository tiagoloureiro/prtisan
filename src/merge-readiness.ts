import type { AgentRunner } from "./agent.js";
import type { GitClient } from "./git.js";
import {
  type GitHubClient,
  pullRequestCheckStatus,
  pullRequestReadinessBlockers,
} from "./github.js";
import {
  loadOpenPrGraph,
  type OpenPrGraph,
  type OpenPrNode,
} from "./open-pr-graph.js";
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
  readonly validatePullRequests?: (
    pullNumbers: readonly number[]
  ) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface ReadyPullRequest {
  readonly graph: OpenPrGraph;
  readonly node: OpenPrNode;
}

const CHECK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const CHECK_WAIT_INTERVAL_MS = 15_000;
const POST_REPAIR_HEAD_REFRESH_ATTEMPTS = 10;
const POST_REPAIR_HEAD_REFRESH_INTERVAL_MS = 2_000;
const MERGE_STATE_REPAIR_LIMIT = 3;
const VALIDATION_REPAIR_LIMIT_PER_HEAD = 6;
const REPAIRABLE_MERGE_STATES = new Set([
  "BEHIND",
  "BLOCKED",
  "DIRTY",
  "UNKNOWN",
]);

export async function preparePullRequestForMerge(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps
): Promise<ReadyPullRequest> {
  let currentGraph = input.graph;
  let ciRepairAttemptedHeadRefOid: string | undefined;
  let mergeStateRepairAttempts = 0;
  const validationRepairAttemptsByHead = new Map<string, number>();

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

    if (validationNeedsRepair(node)) {
      const validationRepairAttempts =
        validationRepairAttemptsByHead.get(node.pr.headRefOid) ?? 0;
      if (validationRepairAttempts >= VALIDATION_REPAIR_LIMIT_PER_HEAD) {
        throw new Error(
          formatReadinessBlockers(node.pr.number, [
            ...validationBlockers(node),
            `Validation repair reached ${VALIDATION_REPAIR_LIMIT_PER_HEAD} attempt(s) for head ${shortSha(node.pr.headRefOid)}.`,
          ])
        );
      }
      validationRepairAttemptsByHead.set(
        node.pr.headRefOid,
        validationRepairAttempts + 1
      );
      currentGraph = await validateCurrentPullRequest(input, deps, node);
      continue;
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
      if (ciRepairAttemptedHeadRefOid === node.pr.headRefOid) {
        await postUnresolvedCiRepairComment(
          input,
          deps,
          node.pr,
          await deps.github.getPullRequestCheckEvidence(
            input.config.repo,
            node.pr
          )
        );
        throw new Error(
          `PR #${node.pr.number} still has ${checks.failed.length} failing status check(s) after CI repair.`
        );
      }

      ciRepairAttemptedHeadRefOid = node.pr.headRefOid;
      currentGraph = await repairCiFailure(input, deps, node);
      continue;
    }

    const mergeState = repairableMergeState(node.pr);
    if (mergeState) {
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
  const nextBaseAnchorSha = await deps.git.recreateBranchFromBaseDiff({
    runId: input.runId,
    label: `restack-pr-${node.pr.number}-to-target`,
    branch: node.pr.headRefName,
    baseBranch: input.config.targetBranch,
    diffBaseRef,
    commitMessage: `Restack PR #${node.pr.number} onto ${input.config.targetBranch}`,
  });
  await deps.github.editPullRequestBase(
    input.config.repo,
    node.pr.number,
    input.config.targetBranch
  );
  deps.log?.(
    `Retargeted PR #${node.pr.number} from ${node.pr.baseRefName} to ${input.config.targetBranch} at ${nextBaseAnchorSha}`
  );
  return loadCurrentGraph(input, deps);
}

async function validateCurrentPullRequest(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode
): Promise<OpenPrGraph> {
  if (!deps.validatePullRequests) {
    throw new Error(
      `PR #${node.pr.number} needs agent-train validation, but merge was not configured with a validation runner.`
    );
  }

  deps.log?.(`Validating PR #${node.pr.number} before merge`);
  await deps.validatePullRequests([node.pr.number]);
  const graph = await loadCurrentGraph(input, deps);
  const refreshed = graph.nodes.get(node.pr.number);
  if (!refreshed) return graph;

  return graph;
}

async function repairCiFailure(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode
): Promise<OpenPrGraph> {
  const agent = requireAgent(deps);
  const evidence = await deps.github.getPullRequestCheckEvidence(
    input.config.repo,
    node.pr
  );

  deps.log?.(`Repairing failing CI for PR #${node.pr.number}`);
  const outcome = await agent.repair({
    kind: "ci-failure",
    cwd: input.cwd,
    config: input.config,
    runId: input.runId,
    issue: node.issue,
    relatedIssues: node.relatedIssues,
    prNumber: node.pr.number,
    branch: node.pr.headRefName,
    baseBranch: node.pr.baseRefName,
    checkEvidence: evidence,
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

  await deps.git.pushBranch(node.pr.headRefName);
  await waitForPullRequestHead(
    input,
    deps,
    node.pr.number,
    outcome.commits.at(-1)
  );
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
      await deps.github.getPullRequestCheckEvidence(input.config.repo, checked),
      outcome
    );
    throw new Error(
      `PR #${node.pr.number} still has ${checkedStatus.failed.length} failing status check(s) after CI repair.`
    );
  }

  return validateCurrentPullRequest(input, deps, node);
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
  const agent = requireAgent(deps);

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
    branch: node.pr.headRefName,
    baseBranch: node.pr.baseRefName,
    mergeState,
    blockers: pullRequestReadinessBlockers(node.pr),
  });

  if (outcome.commits.length === 0) {
    throw new Error(
      `PR #${node.pr.number} is still not mergeable (${mergeState}); merge-state repair produced no commits.`
    );
  }

  await deps.git.pushBranch(node.pr.headRefName);
  await waitForPullRequestHead(
    input,
    deps,
    node.pr.number,
    outcome.commits.at(-1)
  );
  await deps.github.waitForPullRequestChecks(
    input.config.repo,
    node.pr.number,
    CHECK_WAIT_TIMEOUT_MS,
    CHECK_WAIT_INTERVAL_MS
  );
  return validateCurrentPullRequest(input, deps, node);
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
  return ["missing", "stale", "blocked"].includes(node.validation.state);
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
  if (input.outcome?.logFilePath) {
    lines.push(`Repair log: ${input.outcome.logFilePath}`);
  }
  if (input.outcome?.sessionId) {
    lines.push(`Repair session: ${input.outcome.sessionId}`);
  }

  return lines.join("\n");
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
