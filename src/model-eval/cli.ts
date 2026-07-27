#!/usr/bin/env bun
import { chmod } from "node:fs/promises";

import { writeJson, writeText } from "@/fs.js";
import { joinPath } from "@/path.js";
import { prtisanPaths } from "@/prtisan-paths.js";

import {
  assertCorpusPinsCurrent,
  loadAndValidateCorpus,
  PrivateEvaluationArtifactStore,
} from "./corpus.js";
import { buildRedactedReport, formatRedactedReportMarkdown } from "./report.js";
import { LiveModelEvaluationRunner } from "./runner.js";
import { ModelEvaluationStore } from "./store.js";
import { planNextEvaluation } from "./tournament.js";

interface EvalArgs {
  readonly command: "validate-corpus" | "run" | "report";
  readonly corpus: string;
  readonly database: string;
  readonly output?: string;
  readonly cap: number;
}

export async function modelEvalMain(
  argv: readonly string[] = Bun.argv.slice(2)
): Promise<number> {
  const parsed = parseEvalArgs(argv);
  const validated = await loadAndValidateCorpus(parsed.corpus);
  await assertCorpusPinsCurrent(validated.corpus);
  if (parsed.command === "validate-corpus") {
    console.log(
      JSON.stringify(
        {
          valid: true,
          cases: validated.caseCount,
          digest: validated.digest,
        },
        null,
        2
      )
    );
    return 0;
  }

  const store = await ModelEvaluationStore.open(parsed.database);
  try {
    if (parsed.command === "run") {
      const run = store.createOrResume(validated.digest, parsed.cap);
      const artifacts = new PrivateEvaluationArtifactStore(
        joinPath(prtisanPaths().dataRoot, "model-evaluation", "raw")
      );
      const runner = new LiveModelEvaluationRunner(undefined, artifacts);
      while (true) {
        const observations = store.observations(run.id);
        const knownSpentCredits = observations.reduce(
          (total, observation) => total + (observation.credits ?? 0),
          0
        );
        const unavailableCreditSamples = observations.filter(
          (observation) =>
            (observation.terminalOutcome !== "infrastructure_failed" ||
              observation.agentDurationMs !== undefined) &&
            observation.credits === undefined
        ).length;
        const budgetedSpentCredits =
          knownSpentCredits + unavailableCreditSamples * 15;
        const next = planNextEvaluation({
          cases: validated.corpus.cases,
          observations,
          spentCredits: budgetedSpentCredits,
          creditCap: run.creditCap,
        });
        if (next.kind === "complete") {
          console.log(
            JSON.stringify({
              runId: run.id,
              status: "complete",
              samples: observations.length,
              spentCredits:
                unavailableCreditSamples === 0 ? knownSpentCredits : null,
              unavailableCreditSamples,
              unavoidableOvershootCredits: next.overshootCredits,
            })
          );
          return 0;
        }
        if (next.kind === "budget_exhausted") {
          console.log(
            JSON.stringify({
              runId: run.id,
              status: "budget_exhausted",
              samples: observations.length,
              spentCredits:
                unavailableCreditSamples === 0 ? knownSpentCredits : null,
              unavailableCreditSamples,
              remainingCredits: next.remainingCredits,
              requiredReserveCredits: next.reserveCredits,
            })
          );
          return 2;
        }
        const evaluationCase = validated.corpus.cases.find(
          (candidate) => candidate.id === next.job.caseId
        );
        if (!evaluationCase) {
          throw new Error(`Unknown evaluation case: ${next.job.caseId}.`);
        }
        console.error(
          `[${next.job.stage}] ${evaluationCase.id} ${next.job.profile.model}/${next.job.profile.reasoningEffort} replicate ${next.job.replicate}`
        );
        const observation = await runner.execute({
          runId: run.id,
          evaluationCase,
          profile: next.job.profile,
          replicate: next.job.replicate,
        });
        store.saveObservation(observation);
      }
    }

    const run = store.latestRun(validated.digest);
    if (!run) {
      throw new Error(
        `No model-evaluation run exists for corpus ${validated.digest}.`
      );
    }
    const report = buildRedactedReport({
      runId: run.id,
      corpusDigest: validated.digest,
      observations: store.observations(run.id),
      creditCap: run.creditCap,
    });
    if (!parsed.output) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    await writeJson(parsed.output, report);
    await writeText(
      markdownPath(parsed.output),
      formatRedactedReportMarkdown(report)
    );
    if (isPrivateDataPath(parsed.output)) {
      await chmod(parsed.output, 0o600);
      await chmod(markdownPath(parsed.output), 0o600);
    }
    console.log(
      JSON.stringify({
        runId: run.id,
        report: parsed.output,
        markdown: markdownPath(parsed.output),
      })
    );
    return 0;
  } finally {
    store.close();
  }
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const command = argv[0];
  if (
    command !== "validate-corpus" &&
    command !== "run" &&
    command !== "report"
  ) {
    throw new Error(
      "Usage: bun run eval:models <validate-corpus|run|report> [--corpus <path>] [--database <path>] [--output <path>] [--cap <credits>]"
    );
  }
  const paths = prtisanPaths();
  let corpus = joinPath(paths.dataRoot, "model-evaluation", "corpus.json");
  let database = joinPath(paths.stateRoot, "model-evaluation", "runs.sqlite");
  let output: string | undefined;
  let cap = 5_000;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      option !== "--corpus" &&
      option !== "--database" &&
      option !== "--output" &&
      option !== "--cap"
    ) {
      throw new Error(`Unknown model-evaluation option: ${option}.`);
    }
    if (!value) throw new Error(`${option} requires a value.`);
    index += 1;
    if (option === "--corpus") corpus = value;
    if (option === "--database") database = value;
    if (option === "--output") output = value;
    if (option === "--cap") {
      cap = Number(value);
      if (!Number.isFinite(cap) || cap <= 0) {
        throw new Error("--cap must be a positive credit amount.");
      }
    }
  }
  if (command !== "report" && output) {
    throw new Error("--output is only supported by report.");
  }
  return { command, corpus, database, output, cap };
}

function markdownPath(path: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -5)}.md` : `${path}.md`;
}

function isPrivateDataPath(path: string): boolean {
  return path.startsWith(prtisanPaths().dataRoot);
}

if (import.meta.main) {
  try {
    process.exit(await modelEvalMain());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
