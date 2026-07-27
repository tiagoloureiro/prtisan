import { executeInit, initSummary } from "./commands/init.js";
import { BunCommandRunner } from "./exec.js";
import { GitHubClient } from "./github.js";
import { prtisanPaths } from "./prtisan-paths.js";
import {
  assertSetupPlanFresh,
  createSetupPlan,
  SetupPlanStore,
} from "./setup-plan.js";
import { FileArtifactStore } from "./workflow/artifacts.js";
import { SqliteWorkflowJournal } from "./workflow/journal.js";
import { ProductionWorkflowEnvironment } from "./workflow/production.js";
import {
  PrtisanWorkflow,
  type WorkflowRunResult,
} from "./workflow/workflow.js";

interface ParsedArgs {
  readonly command?: "run" | "init" | "plan" | "apply" | "status" | "export";
  readonly action?: "plan" | "apply";
  readonly id?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly help: boolean;
}

type Command = NonNullable<ParsedArgs["command"]>;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
    return { help: true };
  }
  if (
    !["run", "init", "plan", "apply", "status", "export"].includes(rawCommand)
  ) {
    throw new Error(`Unknown command: ${rawCommand}`);
  }
  const command = rawCommand as Command;
  let action: ParsedArgs["action"];
  let id: string | undefined;
  let index = 0;
  if (command === "init") {
    const rawAction = rest[index++];
    if (rawAction !== "plan" && rawAction !== "apply") {
      throw new Error("init requires plan or apply <plan-id>.");
    }
    action = rawAction;
    if (action === "apply") id = requireValue(rest, index++, "init apply");
  } else if (command !== "plan" && command !== "run") {
    id = requireValue(rest, index++, command);
  }

  let cwd: string | undefined;
  let json = false;
  let help = false;
  while (index < rest.length) {
    const value = rest[index++] as string;
    if (value === "--cwd") {
      cwd = requireValue(rest, index++, "--cwd");
    } else if (value === "--json") {
      if (command !== "run") {
        throw new Error("--json is only supported by run.");
      }
      json = true;
    } else if (value === "--help" || value === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return {
    command,
    action,
    id,
    cwd,
    ...(json ? { json: true } : {}),
    help,
  };
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.command || parsed.help) {
    printHelp();
    return 0;
  }

  const cwd = parsed.cwd ?? Bun.env.PWD ?? ".";
  const paths = prtisanPaths();
  const runner = new BunCommandRunner();
  if (parsed.command === "init") {
    const store = await SetupPlanStore.open(paths.journal);
    try {
      if (parsed.action === "plan") {
        const plan = await createSetupPlan({ cwd, runner });
        store.save(plan);
        printJson(plan);
        return 0;
      }
      const plan = store.load(parsed.id as string);
      if (!plan) throw new Error(`Unknown Prtisan setup plan: ${parsed.id}.`);
      await assertSetupPlanFresh(plan, runner);
      const result = await executeInit(
        {
          cwd: plan.cwd,
          repo: plan.repo,
          targetBranch: plan.targetBranch,
          branch: plan.branch,
          manifest: plan.proposedManifest,
          force: plan.upgrade,
        },
        {
          runner,
          github: new GitHubClient(runner, plan.cwd),
          log: console.error,
        }
      );
      printJson(initSummary(result));
      return 0;
    } finally {
      store.close();
    }
  }

  const journal = await SqliteWorkflowJournal.open(paths.journal);
  try {
    const workflow = new PrtisanWorkflow(
      journal,
      new FileArtifactStore(paths.artifacts),
      new ProductionWorkflowEnvironment(runner)
    );
    if (parsed.command === "run") {
      const result = await workflow.run({ cwd });
      console.log(formatRunResult(result, parsed.json));
      return runExitCode(result);
    }
    if (parsed.command === "plan") {
      printJson(await workflow.plan({ cwd }));
      return 0;
    }
    if (parsed.command === "apply") {
      printJson(await workflow.apply(parsed.id as string));
      return 0;
    }
    if (parsed.command === "status") {
      printJson(await workflow.status(parsed.id as string));
      return 0;
    }
    printJson(await workflow.export(parsed.id as string));
    return 0;
  } finally {
    journal.close();
  }
}

export function formatRunResult(
  result: WorkflowRunResult,
  json = false
): string {
  const resumeCommand = `prtisan run --cwd ${shellQuote(result.cwd)}`;
  if (json) {
    return JSON.stringify({ ...result, resumeCommand }, null, 2);
  }

  if (result.kind === "setup") {
    return [
      `Prtisan · ${result.repo}`,
      `State: ${result.outcome}`,
      `Setup: #${result.setupPr.number} ${result.setupPr.url}`,
      `Blocker: ${result.blocker.message}`,
      `Resume: ${resumeCommand}`,
    ].join("\n");
  }

  if (result.kind === "busy") {
    return [
      `Prtisan · ${result.repo}`,
      `Plan: ${result.planId}`,
      `State: ${result.outcome}`,
      `Active run: PID ${result.activeRun.pid} (started ${result.activeRun.startedAt})`,
      `Blocker: ${result.blocker.message}`,
      `Resume: ${resumeCommand}`,
    ].join("\n");
  }

  const lines = [
    `Prtisan · ${result.repo}`,
    `Plan: ${result.planId}`,
    `State: ${result.snapshot.outcome}`,
    `Merged: ${
      result.snapshot.merged.length > 0
        ? result.snapshot.merged.map((number) => `#${number}`).join(", ")
        : "none"
    }`,
  ];
  if (result.snapshot.blocker) {
    lines.push(`Blocker: ${result.snapshot.blocker.message}`);
  } else {
    lines.push(`Next: ${result.snapshot.nextAction}`);
  }
  if (result.snapshot.outcome !== "completed") {
    lines.push(`Resume: ${resumeCommand}`);
  }
  return lines.join("\n");
}

export function runExitCode(result: WorkflowRunResult): number {
  if (result.kind === "setup" || result.kind === "busy") return 2;
  if (result.snapshot.outcome === "completed") return 0;
  if (
    result.snapshot.outcome === "infrastructure_failed" ||
    result.snapshot.outcome === "invalid_plan"
  ) {
    return 1;
  }
  return 2;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function requireValue(
  values: readonly string[],
  index: number,
  context: string
): string {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${context} requires a value.`);
  }
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`prtisan

Usage:
  prtisan run [--cwd <repo>] [--json]
  prtisan init plan [--cwd <repo>]
  prtisan init apply <plan-id>
  prtisan plan [--cwd <repo>]
  prtisan apply <plan-id>
  prtisan status <plan-id>
  prtisan export <plan-id>
`);
}
