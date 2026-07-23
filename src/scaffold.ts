import { DEFAULT_CONFIG_PATH, defaultConfig } from "./config.js";
import { pathExists, readText, writeText } from "./fs.js";
import { joinPath } from "./path.js";

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

export async function writeScaffoldFiles(
  root: string,
  options: ScaffoldOptions
): Promise<ScaffoldResult> {
  const files: ScaffoldFileResult[] = [];
  const config = defaultConfig({
    repo: options.repo,
    targetBranch: options.targetBranch,
  });

  files.push(
    await writeManagedFile(
      root,
      DEFAULT_CONFIG_PATH,
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
    "ENV BUN_INSTALL=/usr/local/share/bun",
    "",
    "RUN apt-get update \\",
    "  && apt-get install -y --no-install-recommends git curl jq ca-certificates gh \\",
    '  && mkdir -p "${BUN_INSTALL}" /home/agent/.codex-agent-train \\',
    "  && bun add --global @openai/codex \\",
    '  && chmod -R a+rX "${BUN_INSTALL}" \\',
    '  && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent \\',
    "  && rm -rf /var/lib/apt/lists/*",
    "",
    "USER ${AGENT_UID}:${AGENT_GID}",
    "WORKDIR /workspace",
    "",
    "ENV HOME=/home/agent",
    "ENV CODEX_HOME=/home/agent/.codex-agent-train",
    "",
    'CMD ["sleep", "infinity"]',
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
