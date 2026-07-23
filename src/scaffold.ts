import { pathExists, readText, writeText } from "./fs.js";
import { joinPath } from "./path.js";
import type { AgentTrainConfig } from "./types.js";

export interface ScaffoldOptions {
  readonly repo: string;
  readonly targetBranch: string;
  readonly force?: boolean;
}

export interface ScaffoldFileResult {
  readonly path: string;
  readonly status: "created" | "updated" | "unchanged" | "skipped";
}

export interface ScaffoldResult {
  readonly files: readonly ScaffoldFileResult[];
}

const GITIGNORE_RULES = [
  ".sandcastle/.env",
  ".sandcastle/codex-home/",
  ".sandcastle/runs/",
  ".sandcastle/worktrees/",
  ".sandcastle/logs/",
  ".sandcastle/patches/",
];

export function defaultScaffoldConfig(input: {
  readonly repo: string;
  readonly targetBranch: string;
}): AgentTrainConfig {
  return {
    repo: input.repo,
    targetBranch: input.targetBranch,
    remote: "origin",
    models: {
      repair: "gpt-5.6-terra",
      review: "gpt-5.6-luna",
    },
    reasoning: {
      repair: "medium",
      review: "low",
    },
    concurrency: {
      validate: 4,
      github: 4,
    },
    docker: {
      imageName: "sandcastle:agent-train",
      codexHome: ".sandcastle/codex-home",
      cpus: 2,
      mounts: [],
    },
    retention: {
      ttlDays: 14,
      maxLogBytes: 10 * 1024 * 1024,
      keepSessions: true,
    },
  };
}

export async function writeScaffoldFiles(
  root: string,
  options: ScaffoldOptions
): Promise<ScaffoldResult> {
  const files: ScaffoldFileResult[] = [];
  const config = defaultScaffoldConfig({
    repo: options.repo,
    targetBranch: options.targetBranch,
  });

  files.push(
    await writeManagedFile(
      root,
      ".sandcastle/agent-train.config.json",
      `${JSON.stringify(config, null, 2)}\n`,
      options
    )
  );
  files.push(
    await writeManagedFile(
      root,
      ".sandcastle/Dockerfile",
      dockerfileContents(),
      options
    )
  );
  files.push(await mergeGitignore(root));

  return { files };
}

export function summarizeScaffold(
  result: ScaffoldResult
): Record<string, number> {
  return result.files.reduce<Record<string, number>>((summary, file) => {
    summary[file.status] = (summary[file.status] ?? 0) + 1;
    return summary;
  }, {});
}

function dockerfileContents(): string {
  return [
    "FROM oven/bun:1.2.22-debian",
    "",
    "ARG AGENT_UID=1000",
    "ARG AGENT_GID=1000",
    "",
    "RUN apt-get update \\",
    "  && apt-get install -y --no-install-recommends git curl jq ca-certificates gh \\",
    "  && bun add --global @openai/codex \\",
    '  && groupadd --gid "${AGENT_GID}" agent \\',
    '  && useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --create-home --shell /bin/bash agent \\',
    "  && rm -rf /var/lib/apt/lists/*",
    "",
    "USER agent",
    "WORKDIR /workspace",
    "",
    "ENV CODEX_HOME=/home/agent/.codex-agent-train",
    "",
  ].join("\n");
}

async function writeManagedFile(
  root: string,
  relativePath: string,
  contents: string,
  options: ScaffoldOptions
): Promise<ScaffoldFileResult> {
  const path = joinPath(root, relativePath);
  if (await pathExists(path)) {
    const existing = await readText(path);
    if (existing === contents) {
      return { path: relativePath, status: "unchanged" };
    }
    if (!options.force) {
      return { path: relativePath, status: "skipped" };
    }

    await writeText(path, contents);
    return { path: relativePath, status: "updated" };
  }

  await writeText(path, contents);
  return { path: relativePath, status: "created" };
}

async function mergeGitignore(root: string): Promise<ScaffoldFileResult> {
  const relativePath = ".gitignore";
  const path = joinPath(root, relativePath);
  const existing = (await pathExists(path)) ? await readText(path) : "";
  const existingLines = new Set(
    existing.split("\n").map((line) => line.trim())
  );
  const missingRules = GITIGNORE_RULES.filter(
    (rule) => !existingLines.has(rule)
  );

  if (missingRules.length === 0) {
    return { path: relativePath, status: "unchanged" };
  }

  const prefix =
    existing.trim().length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await writeText(
    path,
    `${existing}${prefix}# Agent PR Train\n${missingRules.join("\n")}\n`
  );
  return {
    path: relativePath,
    status: existing.length === 0 ? "created" : "updated",
  };
}
