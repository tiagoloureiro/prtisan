import {
  AgentAuthenticationError,
  AgentExecutionError,
  AgentInfrastructureError,
  AgentOutputError,
  type AgentRunner,
} from "./agent.js";
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

const CHECK_WAIT_INTERVAL_MS = 15_000;
const POST_REPAIR_HEAD_REFRESH_ATTEMPTS = 10;
const POST_REPAIR_HEAD_REFRESH_INTERVAL_MS = 2_000;
const CI_REPAIR_ATTEMPT_POLICY_VERSION = 2;
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
  let ciRepairAttempts = 0;
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
        input.config.validation.checkCompletionTimeoutMs,
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
      if (ciRepairAttempts >= input.config.validation.maxRepairRounds) {
        await postUnresolvedCiRepairComment(input, deps, node.pr, allEvidence);
        throw new Error(
          `PR #${node.pr.number} still has ${checks.failed.length} failing status check(s) after ${ciRepairAttempts} bounded CI repair round(s): ${formatCheckFailureSummary(evidence)}`
        );
      }
      ciRepairAttempts += 1;
      const fingerprint = ciFailureFingerprint(node.pr.headRefOid, evidence);
      const evidenceSignature = ciFailureEvidenceSignature(evidence);
      currentGraph = await repairCiFailure(
        input,
        deps,
        node,
        evidence,
        fingerprint,
        evidenceSignature,
        repairAttempts,
        ciRepairAttempts
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
      `PR #${node.pr.number} needs Prtisan validation, but preparation has no validation runner.`
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
    if (validation?.outcome?.kind === "infra_failed") {
      deps.log?.(
        `PR #${node.pr.number} authoritative validation infrastructure details:\n${reason}`
      );
      throw new AgentInfrastructureError(
        infrastructureValidationMessage(node.pr.number, reason)
      );
    }
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

function infrastructureValidationMessage(
  pullNumber: number,
  details: string
): string {
  if (isDiskCapacityFailure(details)) {
    return `PR #${pullNumber} authoritative validation ran out of disk capacity. Free Docker storage or expand disk capacity, then rerun Prtisan.`;
  }
  return `PR #${pullNumber} authoritative validation infrastructure failed. Resolve the recorded infrastructure cause, then rerun Prtisan.`;
}

function isDiskCapacityFailure(message: string): boolean {
  return /\bENOSPC\b|no space left|database or disk is full/i.test(message);
}

async function repairCiFailure(
  input: MergeReadinessInput,
  deps: MergeReadinessDeps,
  node: OpenPrNode,
  evidence: readonly PullRequestCheckEvidence[],
  fingerprint: string,
  evidenceSignature: string,
  repairAttempts: RepairAttemptStore,
  repairRound: number
): Promise<OpenPrGraph> {
  const agent = requireAgent(deps);
  const { runtime, verification } = await prepareRepairEnvironment(
    input,
    deps,
    node.pr
  );
  const repairBranch = `prtisan/repair/ci-${node.pr.number}-${safeRunId(
    input.runId
  )}-r${repairRound}`;
  await deps.git.prepareBranchAt(repairBranch, node.pr.headRefOid);

  try {
    const attemptScope = `${input.config.repo}:pr-${node.pr.number}`;
    const claimedAttemptKeys = await claimRepairAttemptSlot(repairAttempts, [
      `ci:v${CI_REPAIR_ATTEMPT_POLICY_VERSION}:${attemptScope}:fingerprint:${fingerprint}`,
      `ci:v${CI_REPAIR_ATTEMPT_POLICY_VERSION}:${attemptScope}:evidence:${evidenceSignature}`,
    ]);
    if (!claimedAttemptKeys) {
      await postUnresolvedCiRepairComment(input, deps, node.pr, evidence);
      throw new Error(
        `PR #${node.pr.number} CI failure exhausted two candidates for the unchanged root cause.`
      );
    }
    deps.log?.(
      `Repairing failing CI for PR #${node.pr.number} (round ${repairRound}/${input.config.validation.maxRepairRounds})`
    );
    let outcome;
    try {
      outcome = await agent.repair({
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
    } catch (error) {
      if (
        error instanceof AgentAuthenticationError ||
        error instanceof AgentInfrastructureError ||
        error instanceof AgentExecutionError ||
        error instanceof AgentOutputError
      ) {
        await releaseRepairAttemptKeys(repairAttempts, claimedAttemptKeys);
      }
      throw error;
    }

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
      await releaseRepairAttemptKeys(repairAttempts, claimedAttemptKeys);
      throw new Error(
        `PR #${node.pr.number} CI repair did not return a valid changedPaths report.`
      );
    }
    const changedPaths = reportedChangedPaths(outcome.structuredOutput);
    const gateSensitivePaths = changedPaths.filter(isGateSensitivePath);
    if (gateSensitivePaths.length > 0) {
      const originalDiff = await deps.github.getPullRequestDiff(
        input.config.repo,
        node.pr.number
      );
      if (
        !ciEditsAuthorized(
          originalDiff,
          node.issue?.title ?? "",
          node.issue?.body ?? ""
        )
      ) {
        await releaseRepairAttemptKeys(repairAttempts, claimedAttemptKeys);
        throw new Error(
          `PR #${node.pr.number} CI repair attempted gate-sensitive edits outside the linked scope: ${gateSensitivePaths.join(", ")}.`
        );
      }
      if (typeof deps.git.diffBetween === "function") {
        const repairDiff = await deps.git.diffBetween(
          node.pr.headRefOid,
          outcome.commits.at(-1) as string
        );
        if (containsGateWeakening(repairDiff)) {
          await releaseRepairAttemptKeys(repairAttempts, claimedAttemptKeys);
          throw new Error(
            `PR #${node.pr.number} CI repair attempted to weaken or skip authoritative verification.`
          );
        }
      }
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
      if (verificationResult.status === "infra_failed") {
        await releaseRepairAttemptKeys(repairAttempts, claimedAttemptKeys);
      }
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
    await deps.git.pushAdditiveCommit({
      branch: node.pr.headRefName,
      commit: repairedCommit,
      expectedRemoteSha: node.pr.headRefOid,
    });
    await waitForPullRequestHead(input, deps, node.pr.number, repairedCommit);
    const requiredCheckNames = await deps.github.getRequiredCheckNames(
      input.config.repo,
      node.pr.baseRefName
    );
    const checked = await deps.github.waitForPullRequestChecks(
      input.config.repo,
      node.pr.number,
      input.config.validation.checkCompletionTimeoutMs,
      CHECK_WAIT_INTERVAL_MS,
      {
        headRefOid: repairedCommit,
        expectedCheckNames: [
          ...new Set([
            ...requiredCheckNames,
            ...evidence.map((check) => check.name),
          ]),
        ],
        startTimeoutMs: input.config.validation.checkStartTimeoutMs,
      }
    );
    const checkedStatus = pullRequestCheckStatus(checked);
    if (checkedStatus.failed.length > 0) {
      deps.log?.(
        `PR #${node.pr.number} has ${checkedStatus.failed.length} failing status check(s) on repaired head ${shortSha(repairedCommit)}; refreshing evidence for the next bounded round`
      );
    }

    return loadCurrentGraph(input, deps);
  } finally {
    await deps.git.deleteLocalBranch(repairBranch);
  }
}

async function claimRepairAttemptKeys(
  store: RepairAttemptStore,
  keys: readonly string[]
): Promise<readonly string[] | undefined> {
  const claimed: string[] = [];
  for (const key of keys) {
    if (await store.claim(key)) {
      claimed.push(key);
      continue;
    }
    await releaseRepairAttemptKeys(store, claimed);
    return undefined;
  }
  return claimed;
}

async function claimRepairAttemptSlot(
  store: RepairAttemptStore,
  keys: readonly string[]
): Promise<readonly string[] | undefined> {
  for (let slot = 1; slot <= 2; slot += 1) {
    const claimed = await claimRepairAttemptKeys(
      store,
      keys.map((key) => `${key}:candidate-${slot}`)
    );
    if (claimed) return claimed;
  }
  return undefined;
}

async function releaseRepairAttemptKeys(
  store: RepairAttemptStore,
  keys: readonly string[]
): Promise<void> {
  await Promise.all(keys.map((key) => store.release(key)));
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
      input.config.validation.checkCompletionTimeoutMs,
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
  const repairBranch = `prtisan/repair/merge-${node.pr.number}-${safeRunId(
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
    await deps.git.pushAdditiveCommit({
      branch: node.pr.headRefName,
      commit: repairedCommit,
      expectedRemoteSha: node.pr.headRefOid,
    });
    await waitForPullRequestHead(input, deps, node.pr.number, repairedCommit);
    await deps.github.waitForPullRequestChecks(
      input.config.repo,
      node.pr.number,
      input.config.validation.checkCompletionTimeoutMs,
      CHECK_WAIT_INTERVAL_MS,
      {
        headRefOid: repairedCommit,
        expectedCheckNames: pullRequestCheckStatus(node.pr)
          .failed.concat(pullRequestCheckStatus(node.pr).successful)
          .map((check) => check.name),
        startTimeoutMs: input.config.validation.checkStartTimeoutMs,
      }
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
    return [`PR #${node.pr.number} has no current Prtisan validation result.`];
  }
  if (validation.state === "stale") {
    return [
      `PR #${node.pr.number} has no current Prtisan validation result for head ${shortSha(node.pr.headRefOid)}.`,
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
    "Prtisan could not make CI green for this PR.",
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

function formatCheckFailureSummary(
  evidence: readonly PullRequestCheckEvidence[]
): string {
  return evidence
    .map((check) => {
      const excerpt = check.logExcerpt
        ?.replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      return `${check.name} (${check.conclusion ?? check.status})${
        excerpt ? ` — ${excerpt}` : ""
      }`;
    })
    .join("; ");
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

function reportedChangedPaths(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const paths = (value as { changedPaths?: unknown }).changedPaths;
  return Array.isArray(paths)
    ? paths.filter((path): path is string => typeof path === "string")
    : [];
}

function isGateSensitivePath(path: string): boolean {
  return (
    path.startsWith(".github/workflows/") ||
    path === "package.json" ||
    /(?:^|\/)(?:scripts?|ci)\/.*\.(?:sh|bash|js|mjs|cjs|ts|py)$/.test(path)
  );
}

function ciEditsAuthorized(
  originalDiff: string,
  issueTitle: string,
  issueBody: string
): boolean {
  return (
    /^diff --git a\/(?:\.github\/workflows\/|package\.json|(?:.*\/)?(?:scripts?|ci)\/)/m.test(
      originalDiff
    ) ||
    /\b(?:ci|continuous integration|workflow|github actions)\b/i.test(
      `${issueTitle}\n${issueBody}`
    )
  );
}

function containsGateWeakening(diff: string): boolean {
  const additions = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return (
    /continue-on-error\s*:\s*true/i.test(additions) ||
    /(?:\|\|\s*true|exit\s+0)/i.test(additions) ||
    /(?:CI|GITHUB_ACTIONS).{0,160}(?:skip|skipping).{0,160}(?:docker|test|e2e|check)/is.test(
      additions
    ) ||
    /(?:docker|test|e2e|check).{0,160}(?:skip|skipping).{0,160}(?:CI|GITHUB_ACTIONS)/is.test(
      additions
    )
  );
}
