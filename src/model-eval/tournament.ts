import { CODEX_RATE_CARD } from "@/codex-rate-card.js";
import { AGENT_ROLES, type AgentRole } from "@/types.js";

import { mean, median, pairedBootstrap, percentile } from "./statistics.js";
import type {
  EvaluationCase,
  EvaluationObservation,
  EvaluationProfile,
  ProfileRecommendation,
} from "./types.js";

export const BASELINE_PROFILE: EvaluationProfile = {
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
};

export const SCREENING_PROFILES: readonly EvaluationProfile[] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-mini",
].flatMap((model) =>
  (["low", "medium"] as const).map((reasoningEffort) => ({
    model,
    reasoningEffort,
  }))
);

export interface EvaluationJob {
  readonly caseId: string;
  readonly role: AgentRole;
  readonly profile: EvaluationProfile;
  readonly replicate: number;
  readonly stage: "screening" | "holdout" | "rerun" | "high_effort_rescue";
}

export interface Qualification {
  readonly qualifies: boolean;
  readonly reasons: readonly string[];
  readonly qualityInterval?: ReturnType<typeof pairedBootstrap>;
  readonly pairedMedianDurationDeltaMs?: number;
  readonly candidateP95DurationMs?: number;
  readonly baselineP95DurationMs?: number;
  readonly medianCredits?: number;
}

export function profileKey(profile: EvaluationProfile): string {
  return `${profile.model}:${profile.reasoningEffort}`;
}

export function selectScreeningAdvancers(
  observations: readonly EvaluationObservation[],
  role: AgentRole
): readonly EvaluationProfile[] {
  const summaries = summarizeProfiles(
    observations.filter(
      (observation) =>
        observation.role === role && observation.split === "screening"
    )
  );
  const baseline = summaries.find(
    (summary) => profileKey(summary.profile) === profileKey(BASELINE_PROFILE)
  );
  const baselineCredits = baseline?.medianCredits;
  if (baselineCredits === undefined) return [BASELINE_PROFILE];

  const cheaper = summaries.filter(
    (summary) =>
      profileKey(summary.profile) !== profileKey(BASELINE_PROFILE) &&
      summary.hardFailures === 0 &&
      summary.completed > 0 &&
      summary.malformed === 0 &&
      summary.medianCredits !== undefined &&
      summary.medianCredits < baselineCredits
  );
  const nonDominated = cheaper.filter(
    (candidate) =>
      !cheaper.some(
        (other) =>
          profileKey(other.profile) !== profileKey(candidate.profile) &&
          other.meanQuality >= candidate.meanQuality &&
          (other.medianCredits as number) <=
            (candidate.medianCredits as number) &&
          (other.medianDurationMs ?? Number.POSITIVE_INFINITY) <=
            (candidate.medianDurationMs ?? Number.POSITIVE_INFINITY) &&
          (other.meanQuality > candidate.meanQuality ||
            (other.medianCredits as number) <
              (candidate.medianCredits as number) ||
            (other.medianDurationMs ?? Number.POSITIVE_INFINITY) <
              (candidate.medianDurationMs ?? Number.POSITIVE_INFINITY))
      )
  );
  return [
    BASELINE_PROFILE,
    ...nonDominated
      .sort(
        (left, right) =>
          (left.medianCredits as number) - (right.medianCredits as number) ||
          (left.medianDurationMs ?? Number.POSITIVE_INFINITY) -
            (right.medianDurationMs ?? Number.POSITIVE_INFINITY)
      )
      .slice(0, 3)
      .map((summary) => summary.profile),
  ];
}

export function qualifyAgainstBaseline(
  observations: readonly EvaluationObservation[],
  role: AgentRole,
  candidate: EvaluationProfile,
  options: { readonly minimumPairs?: number } = {}
): Qualification {
  const minimumPairs = options.minimumPairs ?? 20;
  const allRelevant = observations.filter(
    (observation) =>
      observation.role === role && observation.split === "holdout"
  );
  const relevant = allRelevant.filter(
    (observation) =>
      observation.terminalOutcome === "completed" &&
      !observation.excludedFromQuality
  );
  const candidateRecords = recordsByPair(
    relevant.filter(
      (observation) => profileKey(observation.profile) === profileKey(candidate)
    )
  );
  const baselineRecords = recordsByPair(
    relevant.filter(
      (observation) =>
        profileKey(observation.profile) === profileKey(BASELINE_PROFILE)
    )
  );
  const pairKeys = [...candidateRecords.keys()].filter((key) =>
    baselineRecords.has(key)
  );
  const reasons: string[] = [];
  if (pairKeys.length < minimumPairs) {
    reasons.push(
      `inconclusive: ${pairKeys.length}/${minimumPairs} paired holdout samples`
    );
  }
  const candidates = pairKeys.flatMap((key) => {
    const value = candidateRecords.get(key);
    return value ? [value] : [];
  });
  const allCandidateCompleted = allRelevant.filter(
    (observation) =>
      profileKey(observation.profile) === profileKey(candidate) &&
      observation.terminalOutcome === "completed"
  );
  if (
    allCandidateCompleted.some(
      (observation) =>
        (observation.score?.hardFailures.length ?? 0) > 0 ||
        observation.score?.malformed
    )
  ) {
    reasons.push("hard invariant or structured-output failure");
  }
  if (
    allRelevant.some(
      (observation) =>
        profileKey(observation.profile) === profileKey(candidate) &&
        observation.terminalOutcome === "execution_failed"
    )
  ) {
    reasons.push("non-completed holdout attempt");
  }

  const scoredPairs = pairKeys.flatMap((key) => {
    const candidateRecord = candidateRecords.get(key);
    const baselineRecord = baselineRecords.get(key);
    return candidateRecord?.score && baselineRecord?.score
      ? [
          {
            candidate: candidateRecord.score.quality,
            baseline: baselineRecord.score.quality,
          },
        ]
      : [];
  });
  const qualityInterval =
    scoredPairs.length > 0
      ? pairedBootstrap(scoredPairs, { samples: 10_000 })
      : undefined;
  if (!qualityInterval || qualityInterval.lower < -2) {
    reasons.push("quality lower confidence bound is below -2 points");
  }

  const durationPairs = pairKeys.flatMap((key) => {
    const candidateDuration = candidateRecords.get(key)?.agentDurationMs;
    const baselineDuration = baselineRecords.get(key)?.agentDurationMs;
    return candidateDuration !== undefined && baselineDuration !== undefined
      ? [{ candidate: candidateDuration, baseline: baselineDuration }]
      : [];
  });
  const pairedMedianDurationDeltaMs = median(
    durationPairs.map((pair) => pair.candidate - pair.baseline)
  );
  const candidateP95DurationMs = percentile(
    durationPairs.map((pair) => pair.candidate),
    0.95
  );
  const baselineP95DurationMs = percentile(
    durationPairs.map((pair) => pair.baseline),
    0.95
  );
  if (
    pairedMedianDurationDeltaMs === undefined ||
    pairedMedianDurationDeltaMs > 0
  ) {
    reasons.push("paired median agent duration is slower than Sol");
  }
  if (
    candidateP95DurationMs === undefined ||
    baselineP95DurationMs === undefined ||
    candidateP95DurationMs > baselineP95DurationMs * 1.1
  ) {
    reasons.push("p95 agent duration is more than 10% slower than Sol");
  }
  const medianCredits = median(
    candidates.flatMap((observation) =>
      observation.credits === undefined ? [] : [observation.credits]
    )
  );
  if (medianCredits === undefined) {
    reasons.push("credit cost is unavailable");
  }
  return {
    qualifies: reasons.length === 0,
    reasons,
    qualityInterval,
    pairedMedianDurationDeltaMs,
    candidateP95DurationMs,
    baselineP95DurationMs,
    medianCredits,
  };
}

export function recommendProfiles(
  observations: readonly EvaluationObservation[],
  options: { readonly minimumPairs?: number } = {}
): readonly ProfileRecommendation[] {
  return AGENT_ROLES.map((role) => {
    const tested = uniqueProfiles(
      observations
        .filter(
          (observation) =>
            observation.role === role && observation.split === "holdout"
        )
        .map((observation) => observation.profile)
    );
    const qualifying = tested.flatMap((profile) => {
      if (profileKey(profile) === profileKey(BASELINE_PROFILE)) return [];
      const qualification = qualifyAgainstBaseline(
        observations,
        role,
        profile,
        options
      );
      return qualification.qualifies ? [{ profile, qualification }] : [];
    });
    const winner = qualifying.sort(
      (left, right) =>
        (left.qualification.medianCredits ?? Number.POSITIVE_INFINITY) -
          (right.qualification.medianCredits ?? Number.POSITIVE_INFINITY) ||
        medianAgentDuration(observations, role, left.profile) -
          medianAgentDuration(observations, role, right.profile)
    )[0];
    const profile = winner?.profile ?? BASELINE_PROFILE;
    const relevant = observations.filter(
      (observation) =>
        observation.role === role &&
        observation.split === "holdout" &&
        profileKey(observation.profile) === profileKey(profile)
    );
    return {
      role,
      profile,
      retainedBaseline: !winner,
      rationale: winner
        ? "Lowest median-credit profile passing every quality and latency gate."
        : "Sol-medium retained because no cheaper profile produced conclusive qualifying evidence.",
      sampleCount: relevant.filter(
        (observation) => observation.terminalOutcome === "completed"
      ).length,
      medianCredits: median(
        relevant.flatMap((observation) =>
          observation.credits === undefined ? [] : [observation.credits]
        )
      ),
      medianAgentDurationMs: median(
        relevant.flatMap((observation) =>
          observation.agentDurationMs === undefined
            ? []
            : [observation.agentDurationMs]
        )
      ),
    };
  });
}

export function planNextEvaluation(input: {
  readonly cases: readonly EvaluationCase[];
  readonly observations: readonly EvaluationObservation[];
  readonly spentCredits: number;
  readonly creditCap?: number;
}):
  | { readonly kind: "job"; readonly job: EvaluationJob }
  | {
      readonly kind: "budget_exhausted";
      readonly remainingCredits: number;
      readonly reserveCredits: number;
    }
  | { readonly kind: "complete"; readonly overshootCredits: number } {
  const creditCap = input.creditCap ?? 5_000;
  const completedKeys = new Set(
    input.observations.map((observation) =>
      observationKey(
        observation.caseId,
        observation.profile,
        observation.replicate
      )
    )
  );
  let next: EvaluationJob | undefined;
  for (const role of AGENT_ROLES) {
    const roleCases = input.cases.filter(
      (evaluationCase) => evaluationCase.role === role
    );
    next ??= firstMissingJob(
      roleCases.filter(
        (evaluationCase) => evaluationCase.split === "screening"
      ),
      SCREENING_PROFILES,
      0,
      "screening",
      completedKeys
    );
    if (next) break;

    const advancers = selectScreeningAdvancers(input.observations, role);
    const holdout = roleCases.filter(
      (evaluationCase) => evaluationCase.split === "holdout"
    );
    next ??= firstMissingJob(holdout, advancers, 0, "holdout", completedKeys);
    if (next) break;

    const finalist = cheapestPreliminaryCandidate(
      input.observations,
      role,
      advancers
    );
    const rerunProfiles = finalist
      ? [BASELINE_PROFILE, finalist]
      : [BASELINE_PROFILE];
    next ??= firstMissingJob(holdout, rerunProfiles, 1, "rerun", completedKeys);
    if (next) break;

    if (
      finalist &&
      !qualifyAgainstBaseline(input.observations, role, finalist).qualifies
    ) {
      const alternatives = advancers.filter(
        (profile) =>
          profileKey(profile) !== profileKey(BASELINE_PROFILE) &&
          profileKey(profile) !== profileKey(finalist)
      );
      for (const alternative of alternatives) {
        const alternativeJob = firstMissingJob(
          holdout,
          [alternative],
          1,
          "rerun",
          completedKeys
        );
        if (alternativeJob) {
          next = alternativeJob;
          break;
        }
        if (
          qualifyAgainstBaseline(input.observations, role, alternative)
            .qualifies
        ) {
          break;
        }
      }
      if (next) break;
    }

    const anyQualified = advancers.some(
      (profile) =>
        profileKey(profile) !== profileKey(BASELINE_PROFILE) &&
        qualifyAgainstBaseline(input.observations, role, profile).qualifies
    );
    if (!anyQualified) {
      const rescue = highEffortRescueProfiles(input.observations, role);
      next ??= firstMissingJob(
        roleCases.filter(
          (evaluationCase) => evaluationCase.split === "screening"
        ),
        rescue,
        0,
        "high_effort_rescue",
        completedKeys
      );
      if (next) break;
      next ??= firstMissingJob(
        holdout,
        rescue,
        0,
        "high_effort_rescue",
        completedKeys
      );
      if (next) break;
      next ??= firstMissingJob(
        holdout,
        rescue,
        1,
        "high_effort_rescue",
        completedKeys
      );
      if (next) break;
    }
  }
  if (!next) {
    return {
      kind: "complete",
      overshootCredits: Math.max(0, input.spentCredits - creditCap),
    };
  }
  const remainingCredits = creditCap - input.spentCredits;
  const reserveCredits = conservativeReserve(input.observations, next.role);
  if (remainingCredits < reserveCredits) {
    return { kind: "budget_exhausted", remainingCredits, reserveCredits };
  }
  return { kind: "job", job: next };
}

function summarizeProfiles(observations: readonly EvaluationObservation[]) {
  return uniqueProfiles(
    observations.map((observation) => observation.profile)
  ).map((profile) => {
    const matching = observations.filter(
      (observation) => profileKey(observation.profile) === profileKey(profile)
    );
    const completed = matching.filter(
      (observation) => observation.terminalOutcome === "completed"
    );
    return {
      profile,
      completed: completed.length,
      hardFailures: completed.reduce(
        (total, observation) =>
          total + (observation.score?.hardFailures.length ?? 0),
        0
      ),
      malformed: completed.filter((observation) => observation.score?.malformed)
        .length,
      meanQuality:
        completed.length === 0
          ? Number.NEGATIVE_INFINITY
          : mean(
              completed.map((observation) => observation.score?.quality ?? 0)
            ),
      medianCredits: median(
        completed.flatMap((observation) =>
          observation.credits === undefined ? [] : [observation.credits]
        )
      ),
      medianDurationMs: median(
        completed.flatMap((observation) =>
          observation.agentDurationMs === undefined
            ? []
            : [observation.agentDurationMs]
        )
      ),
    };
  });
}

function recordsByPair(
  observations: readonly EvaluationObservation[]
): ReadonlyMap<string, EvaluationObservation> {
  return new Map(
    observations.map((observation) => [
      `${observation.caseId}:${observation.replicate}`,
      observation,
    ])
  );
}

function uniqueProfiles(
  profiles: readonly EvaluationProfile[]
): EvaluationProfile[] {
  return [
    ...new Map(
      profiles.map((profile) => [profileKey(profile), profile])
    ).values(),
  ];
}

function medianAgentDuration(
  observations: readonly EvaluationObservation[],
  role: AgentRole,
  profile: EvaluationProfile
): number {
  return (
    median(
      observations.flatMap((observation) =>
        observation.role === role &&
        profileKey(observation.profile) === profileKey(profile) &&
        observation.agentDurationMs !== undefined
          ? [observation.agentDurationMs]
          : []
      )
    ) ?? Number.POSITIVE_INFINITY
  );
}

function firstMissingJob(
  cases: readonly EvaluationCase[],
  profiles: readonly EvaluationProfile[],
  replicate: number,
  stage: EvaluationJob["stage"],
  completed: ReadonlySet<string>
): EvaluationJob | undefined {
  for (const profile of profiles) {
    for (const evaluationCase of cases) {
      if (
        !completed.has(observationKey(evaluationCase.id, profile, replicate))
      ) {
        return {
          caseId: evaluationCase.id,
          role: evaluationCase.role,
          profile,
          replicate,
          stage,
        };
      }
    }
  }
  return undefined;
}

function observationKey(
  caseId: string,
  profile: EvaluationProfile,
  replicate: number
): string {
  return `${caseId}:${profileKey(profile)}:${replicate}`;
}

function cheapestPreliminaryCandidate(
  observations: readonly EvaluationObservation[],
  role: AgentRole,
  profiles: readonly EvaluationProfile[]
): EvaluationProfile | undefined {
  return summarizeProfiles(
    observations.filter(
      (observation) =>
        observation.role === role && observation.split === "holdout"
    )
  )
    .filter(
      (summary) =>
        profiles.some(
          (profile) => profileKey(profile) === profileKey(summary.profile)
        ) &&
        profileKey(summary.profile) !== profileKey(BASELINE_PROFILE) &&
        summary.completed > 0 &&
        summary.hardFailures === 0 &&
        summary.malformed === 0 &&
        summary.medianCredits !== undefined
    )
    .sort(
      (left, right) =>
        (left.medianCredits as number) - (right.medianCredits as number)
    )[0]?.profile;
}

function highEffortRescueProfiles(
  observations: readonly EvaluationObservation[],
  role: AgentRole
): readonly EvaluationProfile[] {
  return summarizeProfiles(
    observations.filter(
      (observation) =>
        observation.role === role &&
        observation.split === "screening" &&
        observation.profile.reasoningEffort === "medium" &&
        observation.profile.model !== BASELINE_PROFILE.model
    )
  )
    .filter((summary) => summary.hardFailures === 0)
    .sort((left, right) => right.meanQuality - left.meanQuality)
    .slice(0, 2)
    .map((summary) => ({
      model: summary.profile.model,
      reasoningEffort: "high",
    }));
}

function conservativeReserve(
  observations: readonly EvaluationObservation[],
  role: AgentRole
): number {
  const roleCredits = observations.flatMap((observation) =>
    observation.role === role && observation.credits !== undefined
      ? [observation.credits]
      : []
  );
  const globalCredits = observations.flatMap((observation) =>
    observation.credits === undefined ? [] : [observation.credits]
  );
  return (
    percentile(roleCredits, 0.99) ??
    percentile(globalCredits, 0.99) ??
    highestPublishedOutputReserve()
  );
}

function highestPublishedOutputReserve(): number {
  const highest = Math.max(
    ...Object.values(CODEX_RATE_CARD.rates).map(
      (rates) => rates.outputCreditsPerMillion
    )
  );
  return highest * 0.02;
}
