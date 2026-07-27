import { chmod, stat } from "node:fs/promises";

import { ensureDir, readJson, readText, writeJson } from "@/fs.js";
import { dirname, joinPath } from "@/path.js";
import { AGENT_ROLES } from "@/types.js";
import { stableDigest } from "@/validation-hardening.js";

import {
  EVALUATION_REPOSITORIES,
  type ModelEvaluationCorpus,
  ModelEvaluationCorpusSchema,
} from "./types.js";

export interface CorpusValidationResult {
  readonly corpus: ModelEvaluationCorpus;
  readonly digest: string;
  readonly caseCount: number;
}

export async function loadAndValidateCorpus(
  path: string
): Promise<CorpusValidationResult> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `The combined model-evaluation corpus must have 0600 permissions; ${path} has ${mode.toString(8)}.`
    );
  }
  const parsed = ModelEvaluationCorpusSchema.safeParse(
    await readJson<unknown>(path)
  );
  if (!parsed.success) {
    throw new Error(
      `Invalid model-evaluation corpus: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }
  validateCorpusShape(parsed.data);
  return {
    corpus: parsed.data,
    digest: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex"),
    caseCount: parsed.data.cases.length,
  };
}

export function validateCorpusShape(corpus: ModelEvaluationCorpus): void {
  if (
    new Date(corpus.goldFrozenAt).getTime() >
    new Date(corpus.frozenAt).getTime()
  ) {
    throw new Error("Gold labels must be frozen before the corpus is frozen.");
  }
  const ids = new Set<string>();
  for (const evaluationCase of corpus.cases) {
    if (ids.has(evaluationCase.id)) {
      throw new Error(`Duplicate evaluation case id: ${evaluationCase.id}.`);
    }
    ids.add(evaluationCase.id);
    assertGoldMatchesRole(evaluationCase.role, evaluationCase.gold.kind);
    if (
      evaluationCase.source.kind === "seeded" &&
      !evaluationCase.source.patchDigest
    ) {
      throw new Error(
        `Seeded case ${evaluationCase.id} requires a frozen patch digest.`
      );
    }
    if (
      evaluationCase.gold.kind === "mutation" &&
      !evaluationCase.execution.mutationChecks
    ) {
      throw new Error(
        `Mutation case ${evaluationCase.id} requires deterministic mutation checks.`
      );
    }
    validateCasePatterns(evaluationCase);
    validateCaseIds(evaluationCase);
  }

  for (const role of AGENT_ROLES) {
    for (const repository of EVALUATION_REPOSITORIES) {
      const cases = corpus.cases.filter(
        (evaluationCase) =>
          evaluationCase.role === role &&
          evaluationCase.repository === repository
      );
      const screening = cases.filter(
        (evaluationCase) => evaluationCase.split === "screening"
      ).length;
      const holdout = cases.filter(
        (evaluationCase) => evaluationCase.split === "holdout"
      ).length;
      if (cases.length !== 3 || screening !== 1 || holdout !== 2) {
        throw new Error(
          `${role}/${repository} must contain exactly one screening and two holdout cases; found ${screening} screening and ${holdout} holdout.`
        );
      }
    }
  }
  if (corpus.cases.length !== 105) {
    throw new Error(
      `The frozen corpus must contain 105 cases; found ${corpus.cases.length}.`
    );
  }
}

export async function assertCorpusPinsCurrent(
  corpus: ModelEvaluationCorpus,
  sourceRoot = joinPath(import.meta.dir, "..", "..")
): Promise<void> {
  const current = await currentCorpusPins(corpus, sourceRoot);
  const stale = Object.entries(current).filter(
    ([key, value]) => corpus.pins[key as keyof typeof corpus.pins] !== value
  );
  if (stale.length > 0) {
    throw new Error(
      `The frozen corpus pins do not match the current evaluator: ${stale
        .map(([key, value]) => `${key} (current ${value})`)
        .join(
          ", "
        )}. Re-author and freeze gold before revealing candidate output.`
    );
  }
}

export async function currentCorpusPins(
  corpus: ModelEvaluationCorpus,
  sourceRoot = joinPath(import.meta.dir, "..", "..")
): Promise<ModelEvaluationCorpus["pins"]> {
  const [
    prompts,
    skill,
    agent,
    runtime,
    scaffold,
    packageJson,
    scoring,
    tournament,
    evaluationTypes,
  ] = await Promise.all([
    readText(joinPath(sourceRoot, "src", "prompts.ts")),
    readText(joinPath(sourceRoot, "src", "vendor", "code-review", "SKILL.md")),
    readText(joinPath(sourceRoot, "src", "agent.ts")),
    readText(joinPath(sourceRoot, "src", "runtime.ts")),
    readText(joinPath(sourceRoot, "src", "scaffold.ts")),
    readText(joinPath(sourceRoot, "package.json")),
    readText(joinPath(sourceRoot, "src", "model-eval", "scoring.ts")),
    readText(joinPath(sourceRoot, "src", "model-eval", "tournament.ts")),
    readText(joinPath(sourceRoot, "src", "model-eval", "types.ts")),
  ]);
  return {
    promptDigest: stableDigest(prompts),
    toolDigest: stableDigest({
      scaffold,
      packageJson,
      scoring,
      tournament,
      evaluationTypes,
    }),
    dockerImage: stableDigest(
      corpus.cases.map((evaluationCase) => ({
        id: evaluationCase.id,
        imageName: dockerImageName(evaluationCase.execution.config),
      }))
    ),
    codeReviewSkillDigest: stableDigest(skill),
    runtimeDigest: stableDigest({ agent, runtime }),
    verificationDigest: stableDigest(
      corpus.cases.map((evaluationCase) => ({
        id: evaluationCase.id,
        runtime: evaluationCase.execution.config.runtime,
        mutationChecks: evaluationCase.execution.mutationChecks,
      }))
    ),
  };
}

export class PrivateEvaluationArtifactStore {
  constructor(private readonly root: string) {}

  async write(
    runId: string,
    caseId: string,
    profileKey: string,
    value: unknown
  ): Promise<string> {
    const path = joinPath(
      this.root,
      runId,
      caseId,
      `${profileKey.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}.json`
    );
    await ensureDir(dirname(path));
    await Promise.all(
      [
        this.root,
        joinPath(this.root, runId),
        joinPath(this.root, runId, caseId),
      ].map((directory) => chmod(directory, 0o700))
    );
    await writeJson(path, value);
    await chmod(path, 0o600);
    return path;
  }
}

function assertGoldMatchesRole(role: string, goldKind: string): void {
  const expected =
    role === "standardsReview" || role === "specReview"
      ? "review"
      : role === "repairVerification"
        ? "repairVerification"
        : "mutation";
  if (goldKind !== expected) {
    throw new Error(
      `Role ${role} requires ${expected} gold, received ${goldKind}.`
    );
  }
}

function dockerImageName(config: Readonly<Record<string, unknown>>): unknown {
  const docker =
    typeof config.docker === "object" && config.docker !== null
      ? (config.docker as Record<string, unknown>)
      : undefined;
  return docker?.imageName;
}

function validateCasePatterns(
  evaluationCase: ModelEvaluationCorpus["cases"][number]
): void {
  const findings =
    evaluationCase.gold.kind === "review"
      ? evaluationCase.gold.findings
      : evaluationCase.gold.kind === "repairVerification"
        ? evaluationCase.gold.newBlockers
        : [];
  const patterns = findings.flatMap((finding) => [
    finding.matcher.titlePattern,
    finding.matcher.bodyPattern,
    finding.matcher.rulePattern,
    finding.matcher.evidencePattern,
  ]);
  patterns.push(
    ...(evaluationCase.execution.mutationChecks?.allowedPathPatterns ?? [])
  );
  for (const pattern of patterns) {
    if (!pattern) continue;
    try {
      new RegExp(pattern, "iu");
    } catch (error) {
      throw new Error(
        `Case ${evaluationCase.id} has an invalid deterministic matcher ${pattern}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }
}

function validateCaseIds(
  evaluationCase: ModelEvaluationCorpus["cases"][number]
): void {
  const ids =
    evaluationCase.gold.kind === "review"
      ? evaluationCase.gold.findings.map((finding) => finding.id)
      : evaluationCase.gold.kind === "repairVerification"
        ? [
            ...evaluationCase.gold.originalFindingIds,
            ...evaluationCase.gold.newBlockers.map((finding) => finding.id),
          ]
        : [];
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      `Case ${evaluationCase.id} has duplicate gold finding ids.`
    );
  }
}
