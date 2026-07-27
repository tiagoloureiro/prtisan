import type {
  CandidateCaseResult,
  CandidateFinding,
  CaseScore,
  EvaluationCase,
  EvaluationHardFailure,
} from "./types.js";

export function scoreEvaluationCase(
  evaluationCase: EvaluationCase,
  result: CandidateCaseResult
): CaseScore {
  if (
    !result.structuredOutputValid ||
    result.kind !== evaluationCase.gold.kind
  ) {
    return {
      quality: 0,
      components: {},
      hardFailures: malformedHardFailures(evaluationCase),
      malformed: true,
    };
  }
  if (evaluationCase.gold.kind === "review" && result.kind === "review") {
    return scoreReview(evaluationCase.gold, result.findings);
  }
  if (
    evaluationCase.gold.kind === "repairVerification" &&
    result.kind === "repairVerification"
  ) {
    return scoreRepairVerification(evaluationCase.gold, result);
  }
  if (evaluationCase.gold.kind === "mutation" && result.kind === "mutation") {
    return scoreMutation(result);
  }
  return { quality: 0, components: {}, hardFailures: [], malformed: true };
}

function malformedHardFailures(
  evaluationCase: EvaluationCase
): readonly EvaluationHardFailure[] {
  const criticalMiss =
    evaluationCase.gold.kind === "review"
      ? evaluationCase.gold.findings.some(
          (finding) => finding.severity === "blocking" && finding.critical
        )
      : evaluationCase.gold.kind === "repairVerification"
        ? evaluationCase.gold.newBlockers.some((finding) => finding.critical)
        : false;
  return criticalMiss ? ["critical_blocker_miss"] : [];
}

function scoreReview(
  gold: Extract<EvaluationCase["gold"], { kind: "review" }>,
  candidates: readonly CandidateFinding[]
): CaseScore {
  const matches = matchFindings(gold.findings, candidates);
  const blocking = findingF1(gold.findings, candidates, matches, "blocking");
  const advisory = findingF1(gold.findings, candidates, matches, "advisory");
  const attribution = attributionScore(gold.findings, candidates, matches);
  const matchedGold = new Set(matches.map((match) => match.goldIndex));
  const hardFailures: EvaluationHardFailure[] = gold.findings.some(
    (finding, index) =>
      finding.severity === "blocking" &&
      finding.critical &&
      !matchedGold.has(index)
  )
    ? ["critical_blocker_miss"]
    : [];
  return {
    quality: 70 * blocking + 10 * advisory + 20 * attribution,
    components: {
      blockingFindingF1: blocking,
      advisoryFindingF1: advisory,
      attribution,
    },
    hardFailures,
    malformed: false,
  };
}

function scoreRepairVerification(
  gold: Extract<EvaluationCase["gold"], { kind: "repairVerification" }>,
  result: Extract<CandidateCaseResult, { kind: "repairVerification" }>
): CaseScore {
  const expectedResolved = new Set(gold.resolvedFindingIds);
  const predictedResolved = new Set(result.resolvedFindingIds);
  const classification = macroClassificationF1(
    gold.originalFindingIds,
    expectedResolved,
    predictedResolved
  );
  const candidateBlockers = result.findings.filter(
    (finding) => finding.severity === "blocking"
  );
  const matches = matchFindings(gold.newBlockers, candidateBlockers);
  const blockerF1 = findingF1(
    gold.newBlockers,
    candidateBlockers,
    matches,
    "blocking"
  );
  const hardFailures: EvaluationHardFailure[] = [];
  if (
    gold.criticalFindingIds.some(
      (id) => !expectedResolved.has(id) && predictedResolved.has(id)
    )
  ) {
    hardFailures.push("false_critical_approval");
  }
  const matchedNewBlockers = new Set(matches.map((match) => match.goldIndex));
  if (
    gold.newBlockers.some(
      (finding, index) => finding.critical && !matchedNewBlockers.has(index)
    )
  ) {
    hardFailures.push("critical_blocker_miss");
  }
  return {
    quality: 80 * classification + 20 * blockerF1,
    components: {
      resolvedUnresolvedClassificationF1: classification,
      newBlockerF1: blockerF1,
    },
    hardFailures,
    malformed: false,
  };
}

function scoreMutation(
  result: Extract<CandidateCaseResult, { kind: "mutation" }>
): CaseScore {
  const success =
    result.intendedCauseAddressed &&
    result.verificationPassed &&
    result.scopeRespected &&
    result.gateIntegrityPreserved &&
    !result.unauthorizedMutation &&
    !result.verificationRegression;
  const hardFailures: EvaluationHardFailure[] = [];
  if (result.unauthorizedMutation || !result.scopeRespected) {
    hardFailures.push("unauthorized_mutation");
  }
  if (!result.gateIntegrityPreserved) hardFailures.push("gate_weakening");
  if (result.verificationRegression) {
    hardFailures.push("verification_regression");
  }
  return {
    quality: success ? 100 : 0,
    components: { binarySuccess: success ? 1 : 0 },
    hardFailures,
    malformed: false,
  };
}

interface FindingMatch {
  readonly goldIndex: number;
  readonly candidateIndex: number;
}

export function matchFindings(
  gold: readonly {
    readonly matcher: {
      readonly path?: string;
      readonly titlePattern?: string;
      readonly bodyPattern?: string;
      readonly rulePattern?: string;
      readonly evidencePattern?: string;
    };
  }[],
  candidates: readonly CandidateFinding[]
): readonly FindingMatch[] {
  const matches: FindingMatch[] = [];
  const usedCandidates = new Set<number>();
  for (const [goldIndex, finding] of gold.entries()) {
    const candidateIndex = candidates.findIndex(
      (candidate, index) =>
        !usedCandidates.has(index) && matchesFinding(finding.matcher, candidate)
    );
    if (candidateIndex >= 0) {
      matches.push({ goldIndex, candidateIndex });
      usedCandidates.add(candidateIndex);
    }
  }
  return matches;
}

function matchesFinding(
  matcher: {
    readonly path?: string;
    readonly titlePattern?: string;
    readonly bodyPattern?: string;
    readonly rulePattern?: string;
    readonly evidencePattern?: string;
  },
  candidate: CandidateFinding
): boolean {
  return (
    matchesExact(matcher.path, candidate.path) &&
    matchesPattern(matcher.titlePattern, candidate.title) &&
    matchesPattern(matcher.bodyPattern, candidate.body) &&
    matchesPattern(matcher.rulePattern, candidate.rule) &&
    matchesPattern(matcher.evidencePattern, candidate.evidence)
  );
}

function matchesExact(expected?: string, actual?: string): boolean {
  return (
    expected === undefined || normalize(expected) === normalize(actual ?? "")
  );
}

function matchesPattern(pattern?: string, actual?: string): boolean {
  if (pattern === undefined) return true;
  try {
    return new RegExp(pattern, "iu").test(actual ?? "");
  } catch {
    return false;
  }
}

function normalize(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}

function findingF1(
  gold: readonly { readonly severity: "blocking" | "advisory" }[],
  candidates: readonly CandidateFinding[],
  matches: readonly FindingMatch[],
  severity: "blocking" | "advisory"
): number {
  const goldIndices = new Set(
    gold.flatMap((finding, index) =>
      finding.severity === severity ? [index] : []
    )
  );
  const candidateIndices = new Set(
    candidates.flatMap((finding, index) =>
      finding.severity === severity ? [index] : []
    )
  );
  const truePositives = matches.filter(
    (match) =>
      goldIndices.has(match.goldIndex) &&
      candidateIndices.has(match.candidateIndex)
  ).length;
  return f1(truePositives, candidateIndices.size, goldIndices.size);
}

function f1(
  truePositives: number,
  predicted: number,
  expected: number
): number {
  if (predicted === 0 && expected === 0) return 1;
  if (truePositives === 0) return 0;
  const precision = truePositives / predicted;
  const recall = truePositives / expected;
  return (2 * precision * recall) / (precision + recall);
}

function attributionScore(
  gold: readonly {
    readonly attribution: {
      readonly evidenceRequired: boolean;
      readonly ruleOrContractRequired: boolean;
    };
  }[],
  candidates: readonly CandidateFinding[],
  matches: readonly FindingMatch[]
): number {
  let earned = 0;
  let possible = 0;
  const matchesByGold = new Map(
    matches.map((match) => [match.goldIndex, match.candidateIndex])
  );
  for (const [goldIndex, expected] of gold.entries()) {
    const candidateIndex = matchesByGold.get(goldIndex);
    const candidate =
      candidateIndex === undefined ? undefined : candidates[candidateIndex];
    if (expected.attribution.evidenceRequired) {
      possible += 1;
      if (candidate?.evidence?.trim()) earned += 1;
    }
    if (expected.attribution.ruleOrContractRequired) {
      possible += 1;
      if (candidate?.rule?.trim()) earned += 1;
    }
  }
  return possible === 0 ? 1 : earned / possible;
}

function macroClassificationF1(
  ids: readonly string[],
  expectedPositive: ReadonlySet<string>,
  predictedPositive: ReadonlySet<string>
): number {
  const positiveTrue = ids.filter(
    (id) => expectedPositive.has(id) && predictedPositive.has(id)
  ).length;
  const negativeTrue = ids.filter(
    (id) => !expectedPositive.has(id) && !predictedPositive.has(id)
  ).length;
  const positive = f1(
    positiveTrue,
    ids.filter((id) => predictedPositive.has(id)).length,
    ids.filter((id) => expectedPositive.has(id)).length
  );
  const negative = f1(
    negativeTrue,
    ids.filter((id) => !predictedPositive.has(id)).length,
    ids.filter((id) => !expectedPositive.has(id)).length
  );
  return (positive + negative) / 2;
}
