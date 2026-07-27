import { calculateCreditCost, CODEX_RATE_CARD } from "@/codex-rate-card.js";
import { AGENT_ROLES } from "@/types.js";

import { mean, median, percentile } from "./statistics.js";
import {
  BASELINE_PROFILE,
  profileKey,
  qualifyAgainstBaseline,
  recommendProfiles,
} from "./tournament.js";
import type { EvaluationObservation, EvaluationProfile } from "./types.js";

const FORBIDDEN_KEYS =
  /(?:^|_)(?:prompt|source|path|finding|output|patch|gold|task|execution)(?:$|_)/i;

export function assertPrivacyMinimal(value: unknown, location = "root"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertPrivacyMinimal(item, `${location}[${index}]`)
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new Error(
        `Private evaluation field ${location}.${key} is forbidden.`
      );
    }
    assertPrivacyMinimal(child, `${location}.${key}`);
  }
}

export function repriceObservations(
  observations: readonly EvaluationObservation[]
): readonly EvaluationObservation[] {
  return observations.map((observation) => ({
    ...observation,
    credits: observation.usage
      ? calculateCreditCost(observation.profile.model, observation.usage)
          ?.credits
      : undefined,
  }));
}

export function buildRedactedReport(input: {
  readonly runId: string;
  readonly corpusDigest: string;
  readonly observations: readonly EvaluationObservation[];
  readonly generatedAt?: string;
  readonly minimumPairs?: number;
  readonly creditCap?: number;
}) {
  const observations = repriceObservations(input.observations);
  const billable = observations.filter(
    (observation) =>
      observation.terminalOutcome !== "infrastructure_failed" ||
      observation.agentDurationMs !== undefined
  );
  const creditValues = billable.flatMap((observation) =>
    observation.credits === undefined ? [] : [observation.credits]
  );
  const unavailableCreditSamples = billable.length - creditValues.length;
  const totalCredits =
    unavailableCreditSamples === 0 ? sum(creditValues) : null;
  const recommendations = recommendProfiles(observations, {
    minimumPairs: input.minimumPairs,
  });
  const report = {
    schemaVersion: 1,
    runId: input.runId,
    corpusDigest: input.corpusDigest,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rateCard: {
      id: CODEX_RATE_CARD.id,
      url: CODEX_RATE_CARD.source,
      accessedAt: CODEX_RATE_CARD.accessedAt,
    },
    totals: {
      samples: observations.length,
      completedSamples: observations.filter(
        (observation) => observation.terminalOutcome === "completed"
      ).length,
      credits: {
        total: totalCredits,
        unavailableSamples: unavailableCreditSamples,
      },
      unavoidableOvershootCredits:
        totalCredits === null
          ? null
          : Math.max(0, totalCredits - (input.creditCap ?? 5_000)),
      tokenMix: {
        unavailableSamples: billable.filter(
          (observation) => observation.usage === undefined
        ).length,
        uncachedInput: sum(
          observations.flatMap((observation) =>
            observation.usage
              ? [
                  observation.usage.inputTokens +
                    observation.usage.cacheCreationInputTokens,
                ]
              : []
          )
        ),
        cachedInput: sum(
          observations.flatMap((observation) =>
            observation.usage ? [observation.usage.cacheReadInputTokens] : []
          )
        ),
        outputTokens: sum(
          observations.flatMap((observation) =>
            observation.usage ? [observation.usage.outputTokens] : []
          )
        ),
      },
    },
    roles: AGENT_ROLES.map((role) => {
      const roleObservations = observations.filter(
        (observation) => observation.role === role
      );
      const profiles = uniqueProfiles(
        roleObservations.map((observation) => observation.profile)
      );
      const recommendation = recommendations.find(
        (candidate) => candidate.role === role
      );
      return {
        role,
        recommendation,
        candidates: profiles.map((profile) => {
          const records = roleObservations.filter(
            (observation) =>
              profileKey(observation.profile) === profileKey(profile)
          );
          const completed = records.filter(
            (observation) => observation.terminalOutcome === "completed"
          );
          const billedRecords = records.filter(
            (observation) =>
              observation.terminalOutcome !== "infrastructure_failed" ||
              observation.agentDurationMs !== undefined
          );
          const qualification =
            profileKey(profile) === profileKey(BASELINE_PROFILE)
              ? undefined
              : qualifyAgainstBaseline(observations, role, profile, {
                  minimumPairs: input.minimumPairs,
                });
          return {
            profile,
            sampleCount: records.length,
            completedCount: completed.length,
            rejected: qualification ? !qualification.qualifies : false,
            rejectionReasons: qualification?.reasons ?? [],
            quality: {
              mean:
                completed.length === 0
                  ? undefined
                  : mean(
                      completed.map(
                        (observation) => observation.score?.quality ?? 0
                      )
                    ),
              deltaVsSol: qualification?.qualityInterval?.estimate,
              confidence95: qualification?.qualityInterval
                ? {
                    lower: qualification.qualityInterval.lower,
                    upper: qualification.qualityInterval.upper,
                    bootstrapSamples: qualification.qualityInterval.samples,
                  }
                : undefined,
              hardFailures: completed.reduce(
                (total, observation) =>
                  total + (observation.score?.hardFailures.length ?? 0),
                0
              ),
              malformed: completed.filter(
                (observation) => observation.score?.malformed
              ).length,
            },
            credits: summarizeAvailable(
              billedRecords.map((observation) => observation.credits)
            ),
            agentLatencyMs: summarize(
              completed.flatMap((observation) =>
                observation.agentDurationMs === undefined
                  ? []
                  : [observation.agentDurationMs]
              )
            ),
            endToEndLatencyMs: summarize(
              completed.map((observation) => observation.endToEndDurationMs)
            ),
            tokenMix: {
              unavailableSamples: billedRecords.filter(
                (observation) => observation.usage === undefined
              ).length,
              uncachedInput: sum(
                billedRecords.flatMap((observation) =>
                  observation.usage
                    ? [
                        observation.usage.inputTokens +
                          observation.usage.cacheCreationInputTokens,
                      ]
                    : []
                )
              ),
              cachedInput: sum(
                billedRecords.flatMap((observation) =>
                  observation.usage
                    ? [observation.usage.cacheReadInputTokens]
                    : []
                )
              ),
              outputTokens: sum(
                billedRecords.flatMap((observation) =>
                  observation.usage ? [observation.usage.outputTokens] : []
                )
              ),
            },
          };
        }),
      };
    }),
  };
  assertPrivacyMinimal(report);
  return report;
}

export function formatRedactedReportMarkdown(
  report: ReturnType<typeof buildRedactedReport>
): string {
  const lines = [
    "# Model-routing benchmark",
    "",
    `Run: \`${report.runId}\``,
    "",
    `Corpus digest: \`${report.corpusDigest}\``,
    "",
    `Rate card: [${report.rateCard.id}](${report.rateCard.url})`,
    "",
    `Completed samples: ${report.totals.completedSamples}/${report.totals.samples}`,
    "",
    `Total credits: ${
      report.totals.credits.total === null
        ? `unavailable (${report.totals.credits.unavailableSamples} samples missing usage or pricing)`
        : report.totals.credits.total.toFixed(3)
    }`,
    "",
    "| Agent role | Recommended profile | Evidence |",
    "| --- | --- | --- |",
    ...report.roles.map((role) => {
      const recommendation = role.recommendation;
      const profile = recommendation?.profile;
      return `| ${role.role} | ${
        profile ? `${profile.model} / ${profile.reasoningEffort}` : "Sol-medium"
      } | ${recommendation?.rationale ?? "No result"} |`;
    }),
    "",
    "This is a redacted aggregate report. It contains no prompts, source, findings, model output, or patches.",
    "",
  ];
  return lines.join("\n");
}

function summarize(values: readonly number[]) {
  return {
    total: sum(values),
    median: median(values),
    p95: percentile(values, 0.95),
  };
}

function summarizeAvailable(values: readonly (number | undefined)[]) {
  const available = values.filter(
    (value): value is number => value !== undefined
  );
  return {
    total: available.length === values.length ? sum(available) : null,
    median: median(available),
    p95: percentile(available, 0.95),
    unavailableSamples: values.length - available.length,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
