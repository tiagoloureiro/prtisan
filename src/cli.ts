import { SandcastleCodexRunner } from "./agent.js";
import { executeCreatePrs } from "./commands/create-prs.js";
import { executeInit, initSummary } from "./commands/init.js";
import { executeMerge } from "./commands/merge.js";
import { executeValidate } from "./commands/validate.js";
import { loadConfig } from "./config.js";
import { BunCommandRunner } from "./exec.js";
import { GitClient } from "./git.js";
import { GitHubClient } from "./github.js";
import { assertPreflight } from "./preflight.js";
import { pruneTrainArtifacts } from "./retention.js";

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.command || parsed.help) {
    printHelp();
    return parsed.command ? 0 : 1;
  }
  if (!["init", "create-prs", "validate", "merge"].includes(parsed.command)) {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  const cwd = parsed.options.cwd ?? Bun.env.PWD ?? ".";
  const runner = new BunCommandRunner();
  const github = new GitHubClient(runner, cwd);

  if (parsed.command === "init") {
    const result = await executeInit(
      {
        cwd,
        repo: parsed.options.repo,
        targetBranch: parsed.options.targetBranch,
        branch: parsed.options.branch,
        remote: parsed.options.remote,
        force: parsed.options.force,
      },
      { runner, github, log: console.error }
    );
    console.log(JSON.stringify(initSummary(result), null, 2));
    return 0;
  }

  const config = await loadConfig(cwd, parsed.options.config);
  const git = new GitClient(runner, cwd, config);
  const agent = new SandcastleCodexRunner();

  await github.assertReady();
  await git.assertReady();
  await assertPreflight({ cwd, config, runner });
  await pruneTrainArtifacts({ cwd, config, runner }).catch((error) => {
    console.error(
      `Retention pruning skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  if (parsed.command === "create-prs") {
    const state = await executeCreatePrs(
      {
        cwd,
        config,
        trainId: parsed.options.trainId,
        dryRun: parsed.options.dryRun,
      },
      { github, git, agent, log: console.error }
    );
    console.log(
      JSON.stringify(
        {
          trainId: state.trainId,
          statePath: `.sandcastle/trains/${state.trainId}/state.json`,
        },
        null,
        2
      )
    );
    return 0;
  }

  if (!parsed.options.trainId) {
    throw new Error(`--train-id is required for ${parsed.command}.`);
  }

  if (parsed.command === "validate") {
    const state = await executeValidate(
      {
        cwd,
        config,
        trainId: parsed.options.trainId,
        issueNumbers: parsed.options.issues,
        repair: parsed.options.repair,
      },
      { github, git, agent, log: console.error }
    );
    console.log(JSON.stringify(validationSummary(state), null, 2));
    return 0;
  }

  if (parsed.command === "merge") {
    const validateIssues = async (issueNumbers: readonly number[]) => {
      await executeValidate(
        {
          cwd,
          config,
          trainId: parsed.options.trainId!,
          issueNumbers,
          repair: true,
        },
        { github, git, agent, log: console.error }
      );
    };

    const state = await executeMerge(
      {
        cwd,
        config,
        trainId: parsed.options.trainId,
        validateAffected: parsed.options.validateAffected,
      },
      { github, git, validateIssues, log: console.error }
    );
    console.log(JSON.stringify(mergeSummary(state), null, 2));
    return 0;
  }

  throw new Error(`Unhandled command: ${parsed.command}`);
}

interface ParsedArgs {
  readonly command?: string;
  readonly help: boolean;
  readonly options: ParsedOptions;
}

interface ParsedOptions {
  cwd?: string;
  config?: string;
  repo?: string;
  targetBranch?: string;
  branch?: string;
  remote?: string;
  trainId?: string;
  dryRun?: boolean;
  force?: boolean;
  repair?: boolean;
  validateAffected?: boolean;
  issues?: readonly number[];
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: ParsedOptions = {
    repair: true,
    validateAffected: true,
  };
  let help = command === "--help" || command === "-h";

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--cwd") {
      options.cwd = requireValue(rest, ++index, arg);
    } else if (arg === "--config") {
      options.config = requireValue(rest, ++index, arg);
    } else if (arg === "--repo") {
      options.repo = requireValue(rest, ++index, arg);
    } else if (arg === "--target-branch") {
      options.targetBranch = requireValue(rest, ++index, arg);
    } else if (arg === "--branch") {
      options.branch = requireValue(rest, ++index, arg);
    } else if (arg === "--remote") {
      options.remote = requireValue(rest, ++index, arg);
    } else if (arg === "--train-id") {
      options.trainId = requireValue(rest, ++index, arg);
    } else if (arg === "--issues") {
      options.issues = requireValue(rest, ++index, arg)
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value));
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--no-repair") {
      options.repair = false;
    } else if (arg === "--no-validate-affected") {
      options.validateAffected = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    help,
    options,
  };
}

function requireValue(
  values: readonly string[],
  index: number,
  flag: string
): string {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function validationSummary(
  state: Awaited<ReturnType<typeof executeValidate>>
): unknown {
  return {
    trainId: state.trainId,
    issues: Object.values(state.issues).map((record) => ({
      issue: record.issue.number,
      pr: record.pr?.number,
      status: record.status,
      validation: record.validation,
    })),
  };
}

function mergeSummary(
  state: Awaited<ReturnType<typeof executeMerge>>
): unknown {
  return {
    trainId: state.trainId,
    merged: Object.values(state.issues)
      .filter((record) => record.status === "merged")
      .map((record) => ({ issue: record.issue.number, pr: record.pr?.number })),
  };
}

function printHelp(): void {
  console.log(`agent-train

Usage:
  agent-train init [--cwd <repo>] [--repo OWNER/REPO] [--target-branch <branch>] [--branch <branch>] [--remote <name>] [--force]
  agent-train create-prs [--cwd <repo>] [--config <path>] [--train-id <id>] [--dry-run]
  agent-train validate --train-id <id> [--cwd <repo>] [--issues 1,2] [--no-repair]
  agent-train merge --train-id <id> [--cwd <repo>] [--no-validate-affected]
`);
}
