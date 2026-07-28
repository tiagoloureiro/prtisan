import { createInterface } from "node:readline/promises";

import {
  CLEANUP_CATEGORIES,
  type CleanupCategory,
  type CleanupPreview,
  type CleanupResult,
} from "./cleanup.js";
import type { Project } from "./control/types.js";
import { WorkerClient } from "./worker/client.js";
import { runWorkerServer } from "./worker/server.js";
import type { CodexLoginRemediation } from "./workflow/types.js";
import type { WorkflowRunResult } from "./workflow/workflow.js";

interface ParsedArgs {
  readonly command?:
    "run" | "init" | "plan" | "apply" | "status" | "export" | "tui" | "cleanup";
  readonly action?: "plan" | "apply";
  readonly id?: string;
  readonly cwd?: string;
  readonly json?: boolean;
  readonly all?: boolean;
  readonly only?: readonly CleanupCategory[];
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly help: boolean;
}

type Command = NonNullable<ParsedArgs["command"]>;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
    return { help: true };
  }
  if (
    ![
      "run",
      "init",
      "plan",
      "apply",
      "status",
      "export",
      "tui",
      "cleanup",
    ].includes(rawCommand)
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
  } else if (
    command !== "plan" &&
    command !== "run" &&
    command !== "tui" &&
    command !== "cleanup"
  ) {
    id = requireValue(rest, index++, command);
  }

  let cwd: string | undefined;
  let json = false;
  let all = false;
  const only: CleanupCategory[] = [];
  let dryRun = false;
  let yes = false;
  let help = false;
  while (index < rest.length) {
    const value = rest[index++] as string;
    if (value === "--cwd") {
      cwd = requireValue(rest, index++, "--cwd");
    } else if (value === "--json") {
      if (command !== "run" && command !== "cleanup") {
        throw new Error("--json is only supported by run and cleanup.");
      }
      json = true;
    } else if (value === "--all") {
      if (command !== "cleanup") throw new Error("--all requires cleanup.");
      all = true;
    } else if (value === "--only") {
      if (command !== "cleanup") throw new Error("--only requires cleanup.");
      const category = requireValue(rest, index++, "--only");
      if (!CLEANUP_CATEGORIES.includes(category as CleanupCategory)) {
        throw new Error(`Unknown cleanup category: ${category}.`);
      }
      only.push(category as CleanupCategory);
    } else if (value === "--dry-run") {
      if (command !== "cleanup") throw new Error("--dry-run requires cleanup.");
      dryRun = true;
    } else if (value === "--yes") {
      if (command !== "cleanup") throw new Error("--yes requires cleanup.");
      yes = true;
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
    ...(all ? { all: true } : {}),
    ...(only.length > 0 ? { only } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(yes ? { yes: true } : {}),
    help,
  };
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  if (argv[0] === "__worker") {
    await runWorkerServer();
    return 0;
  }
  const parsed = parseCliArgs(argv);
  if (!parsed.command || parsed.help) {
    printHelp();
    return 0;
  }

  const cwd = parsed.cwd ?? Bun.env.PWD ?? ".";
  if (parsed.command === "tui") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("prtisan tui requires an interactive terminal.");
    }
    const { runTui } = await import("./tui.js");
    await runTui({ cwd });
    return 0;
  }
  const worker = new WorkerClient();
  if (parsed.command === "cleanup") {
    try {
      return await executeCleanupCommand(worker, {
        cwd,
        all: parsed.all ?? false,
        categories: parsed.only,
        dryRun: parsed.dryRun ?? false,
        yes: parsed.yes ?? false,
        json: parsed.json ?? false,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      });
    } finally {
      worker.close();
    }
  }

  if (parsed.command === "init") {
    try {
      const result =
        parsed.action === "plan"
          ? await worker.request("setup.plan", { cwd })
          : await worker.request("setup.apply", { id: parsed.id });
      printJson(result);
      return 0;
    } finally {
      worker.close();
    }
  }

  try {
    if (parsed.command === "run") {
      const result = await runWithAuthentication(
        () =>
          worker.request<WorkflowRunResult>("workflow.run", {
            cwd,
          }),
        {
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          json: parsed.json ?? false,
          login: runCodexLogin,
          log: console.error,
        }
      );
      console.log(formatRunResult(result, parsed.json));
      return runExitCode(result);
    }
    if (parsed.command === "plan") {
      printJson(await worker.request("workflow.plan", { cwd }));
      return 0;
    }
    if (parsed.command === "apply") {
      printJson(await worker.request("workflow.apply", { id: parsed.id }));
      return 0;
    }
    if (parsed.command === "status") {
      printJson(await worker.request("workflow.status", { id: parsed.id }));
      return 0;
    }
    printJson(await worker.request("workflow.export", { id: parsed.id }));
    return 0;
  } finally {
    worker.close();
  }
}

export async function executeCleanupCommand(
  worker: WorkerClient,
  input: {
    readonly cwd: string;
    readonly all: boolean;
    readonly categories?: readonly CleanupCategory[];
    readonly dryRun: boolean;
    readonly yes: boolean;
    readonly json: boolean;
    readonly interactive: boolean;
  }
): Promise<number> {
  let projectId: string | undefined;
  if (!input.all) {
    const project = await worker.request<Project>("project.add", {
      cwd: input.cwd,
    });
    projectId = project.id;
  }
  const preview = await worker.request<CleanupPreview>("cleanup.preview", {
    ...(projectId ? { projectId } : {}),
    all: input.all,
    categories: input.categories,
  });
  if (input.json && input.dryRun) {
    printJson(preview);
    return 0;
  }
  if (!input.json) console.log(formatCleanupPreview(preview));
  if (input.dryRun) return 0;
  if (!input.yes) {
    if (!input.interactive) {
      throw new Error("Non-interactive cleanup requires --yes or --dry-run.");
    }
    const confirmed = await confirmCleanup();
    if (!confirmed) {
      if (!input.json) console.log("Cleanup cancelled; nothing was removed.");
      return 0;
    }
  }
  const result = await worker.request<CleanupResult>("cleanup.execute", {
    authorizationId: preview.authorizationId,
    candidateIds: preview.candidates
      .filter((candidate) => candidate.action === "remove")
      .map((candidate) => candidate.id),
  });
  if (input.json) printJson(result);
  else console.log(formatCleanupResult(result));
  return result.failed.length > 0 ? 1 : 0;
}

export function formatCleanupPreview(preview: CleanupPreview): string {
  const removable = preview.candidates.filter(
    (candidate) => candidate.action === "remove"
  );
  const skipped = preview.candidates.filter(
    (candidate) => candidate.action === "skip"
  );
  const lines = [
    `Prtisan cleanup · ${preview.scope.kind === "all" ? "all Projects" : preview.scope.projectId}`,
    `Categories: ${preview.categories.join(", ")}`,
    `Will remove: ${removable.length}`,
    `Will preserve: ${skipped.length}`,
  ];
  for (const candidate of removable) {
    lines.push(`  remove ${candidate.category}: ${candidate.description}`);
  }
  for (const candidate of skipped) {
    lines.push(
      `  preserve ${candidate.category}: ${candidate.description} (${candidate.reason ?? "not reclaimable"})`
    );
  }
  return lines.join("\n");
}

export function formatCleanupResult(result: CleanupResult): string {
  return [
    `Removed: ${result.removed.length}`,
    `Preserved: ${result.skipped.length}`,
    `Failed: ${result.failed.length}`,
    ...result.failed.map(
      (failure) => `  ${failure.candidate.description}: ${failure.error}`
    ),
  ].join("\n");
}

async function confirmCleanup(): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question("Remove these resources? [y/N] ");
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
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

  if (result.kind === "authentication") {
    return [
      `Prtisan · ${result.repo}`,
      `State: ${result.outcome}`,
      `Blocker: ${result.blocker.message}`,
      `Authenticate: ${result.authentication.command}`,
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
  if (
    result.kind === "setup" ||
    result.kind === "busy" ||
    result.kind === "authentication"
  ) {
    return 2;
  }
  if (result.snapshot.outcome === "completed") return 0;
  if (
    result.snapshot.outcome === "infrastructure_failed" ||
    result.snapshot.outcome === "invalid_plan"
  ) {
    return 1;
  }
  return 2;
}

export async function runWithAuthentication(
  run: () => Promise<WorkflowRunResult>,
  options: {
    readonly interactive: boolean;
    readonly json: boolean;
    readonly login: (codexHome: string) => Promise<number>;
    readonly log?: (message: string) => void;
  }
): Promise<WorkflowRunResult> {
  const initial = await run();
  const remediation = codexLoginRemediation(initial);
  if (!remediation || !options.interactive || options.json) return initial;

  options.log?.(
    `Codex authentication is required. Starting login for ${remediation.codexHome}.`
  );
  const exitCode = await options.login(remediation.codexHome);
  if (exitCode !== 0) return initial;
  return run();
}

interface InteractiveLoginProcess {
  readonly exited: Promise<number>;
}

interface InteractiveLoginOptions {
  readonly env: Record<string, string | undefined>;
  readonly stdin: "inherit";
  readonly stdout: "inherit";
  readonly stderr: "inherit";
}

type InteractiveLoginSpawner = (
  command: string[],
  options: InteractiveLoginOptions
) => InteractiveLoginProcess;

export async function runCodexLogin(
  codexHome: string,
  spawn: InteractiveLoginSpawner = (command, options) =>
    Bun.spawn(command, options)
): Promise<number> {
  const process = spawn(["codex", "login", "--device-auth"], {
    env: { ...Bun.env, CODEX_HOME: codexHome },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return process.exited;
}

function codexLoginRemediation(
  result: WorkflowRunResult
): CodexLoginRemediation | undefined {
  if (result.kind === "authentication") return result.authentication;
  if (result.kind !== "train") return undefined;
  const remediation = result.snapshot.blocker?.remediation;
  return remediation?.kind === "codex_login" ? remediation : undefined;
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
  prtisan tui [--cwd <repo>]
  prtisan cleanup [--cwd <repo> | --all] [--only <category>] [--dry-run] [--yes] [--json]
`);
}
