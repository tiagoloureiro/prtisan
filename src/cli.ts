import { SandcastleCodexRunner } from "./agent.js";
import { executeInit, initSummary } from "./commands/init.js";
import { executeMerge } from "./commands/merge.js";
import { executeValidate } from "./commands/validate.js";
import { loadConfig } from "./config.js";
import { BunCommandRunner } from "./exec.js";
import { GitClient } from "./git.js";
import { GitHubClient } from "./github.js";
import { assertRuntimeReady } from "./preflight.js";
import { pruneRuntimeArtifacts } from "./retention.js";
import { runTui } from "./tui/index.js";

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.command || parsed.help) {
    printHelp();
    return parsed.command ? 0 : 1;
  }
  if (!["init", "validate", "merge", "tui"].includes(parsed.command)) {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  const cwd = parsed.options.cwd ?? Bun.env.PWD ?? ".";

  if (parsed.command === "tui") {
    return runTui({
      cwd,
      configPath: parsed.options.config,
      repo: parsed.options.repo,
      targetBranch: parsed.options.targetBranch,
      repair: parsed.options.repair,
      validateAffected: parsed.options.validateAffected,
    });
  }

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

  const config = await loadConfig(cwd, parsed.options.config, {
    repo: parsed.options.repo,
    targetBranch: parsed.options.targetBranch,
  });
  const git = new GitClient(runner, cwd, config);
  const agent = new SandcastleCodexRunner();

  await assertRuntimeReady({ cwd, config, runner, github, log: console.error });
  await pruneRuntimeArtifacts({ cwd, config, runner }).catch((error) => {
    console.error(
      `Retention pruning skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  if (parsed.command === "validate") {
    const result = await executeValidate(
      {
        cwd,
        config,
        repair: parsed.options.repair,
      },
      { github, git, agent, log: console.error }
    );
    console.log(JSON.stringify(validationSummary(result), null, 2));
    return 0;
  }

  if (parsed.command === "merge") {
    const validatePullRequests = async (pullNumbers: readonly number[]) => {
      await executeValidate(
        {
          cwd,
          config,
          pullNumbers,
          repair: true,
        },
        { github, git, agent, log: console.error }
      );
    };

    const result = await executeMerge(
      {
        cwd,
        config,
        validateAffected: parsed.options.validateAffected,
      },
      { github, git, agent, validatePullRequests, log: console.error }
    );
    console.log(JSON.stringify(mergeSummary(result), null, 2));
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
  force?: boolean;
  repair?: boolean;
  validateAffected?: boolean;
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
  result: Awaited<ReturnType<typeof executeValidate>>
): unknown {
  return {
    repo: result.repo,
    checkedAt: result.checkedAt,
    pullRequests: result.pullRequests,
    issues: result.issues,
  };
}

function mergeSummary(
  result: Awaited<ReturnType<typeof executeMerge>>
): unknown {
  return {
    repo: result.repo,
    merged: result.merged,
  };
}

function printHelp(): void {
  console.log(`agent-train

Usage:
  agent-train init [--cwd <repo>] [--repo OWNER/REPO] [--target-branch <branch>] [--branch <branch>] [--remote <name>] [--force]
  agent-train validate [--cwd <repo>] [--repo OWNER/REPO] [--config <path>] [--no-repair]
  agent-train merge [--cwd <repo>] [--repo OWNER/REPO] [--config <path>] [--no-validate-affected]
  agent-train tui [--cwd <repo>] [--repo OWNER/REPO] [--config <path>] [--target-branch <branch>]
`);
}
