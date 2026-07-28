import { pathExists, readText, writeText } from "./fs.js";
import type { PrtisanManifest } from "./manifest.js";
import {
  defaultManifest,
  PRTISAN_DOCKERFILE_PATH,
  PRTISAN_MANIFEST_PATH,
} from "./manifest.js";
import { joinPath } from "./path.js";

export interface ScaffoldOptions {
  readonly repo: string;
  readonly targetBranch: string;
  readonly force?: boolean;
  readonly manifest?: PrtisanManifest;
}

export interface ScaffoldFileResult {
  readonly path: string;
  readonly status: "created" | "updated" | "unchanged" | "skipped";
}

export interface ScaffoldResult {
  readonly files: readonly ScaffoldFileResult[];
}

interface NodeDockerRuntime {
  readonly kind: "node";
  readonly nodeVersion: string;
  readonly packageManager: "npm" | "pnpm" | "yarn";
  readonly packageManagerVersion: string;
}

interface BunDockerRuntime {
  readonly kind: "bun";
  readonly bunVersion: string;
}

type DockerRuntime = NodeDockerRuntime | BunDockerRuntime;

const MANAGED_RUNTIME_MARKER = "# prtisan:managed-runtime:v2";

export async function writeScaffoldFiles(
  root: string,
  options: ScaffoldOptions
): Promise<ScaffoldResult> {
  const files: ScaffoldFileResult[] = [];
  const config =
    options.manifest ?? (await recommendedManifest(root, options.targetBranch));

  files.push(
    await writeManagedFile(
      root,
      PRTISAN_MANIFEST_PATH,
      serializeManifest(config),
      options
    )
  );
  files.push(
    await writeManagedFile(
      root,
      PRTISAN_DOCKERFILE_PATH,
      await recommendedDockerfile(root),
      options
    )
  );

  return { files };
}

function serializeManifest(config: PrtisanManifest): string {
  const contents = JSON.stringify(config, null, 2);
  const sections = `[${config.contract.prBodySections
    .map((section) => JSON.stringify(section))
    .join(", ")}]`;
  const expandedSections = JSON.stringify(
    config.contract.prBodySections,
    null,
    2
  ).replaceAll("\n", "\n    ");

  return `${contents.replace(
    `    "prBodySections": ${expandedSections}`,
    `    "prBodySections": ${sections}`
  )}\n`;
}

export function summarizeScaffold(
  result: ScaffoldResult
): Record<string, number> {
  return result.files.reduce<Record<string, number>>((summary, file) => {
    summary[file.status] = (summary[file.status] ?? 0) + 1;
    return summary;
  }, {});
}

export function dockerfileContents(runtime?: DockerRuntime): string {
  const base =
    runtime?.kind === "node"
      ? `node:${runtime.nodeVersion}-bookworm-slim`
      : `oven/bun:${runtime?.bunVersion ?? "1.2.22"}-debian`;
  const install =
    runtime?.kind === "node"
      ? `npm install --global @openai/codex@0.145.0 ${runtime.packageManager}@${runtime.packageManagerVersion}`
      : "bun add --global @openai/codex@0.145.0";
  return [
    MANAGED_RUNTIME_MARKER,
    `FROM ${base}`,
    "",
    "ARG AGENT_UID=1000",
    "ARG AGENT_GID=1000",
    "",
    "RUN apt-get update \\",
    "  && apt-get install -y --no-install-recommends git curl jq ca-certificates gh \\",
    "  && mkdir -p /home/agent/.codex-prtisan \\",
    `  && ${install} \\`,
    '  && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent \\',
    "  && rm -rf /var/lib/apt/lists/*",
    "",
    "USER ${AGENT_UID}:${AGENT_GID}",
    "WORKDIR /workspace",
    "",
    "ENV HOME=/home/agent",
    "ENV CODEX_HOME=/home/agent/.codex-prtisan",
    "",
    'CMD ["sleep", "infinity"]',
    "",
  ].join("\n");
}

export function managedDockerfileNeedsUpgrade(contents: string): boolean {
  if (contents.includes(MANAGED_RUNTIME_MARKER)) return false;
  return [
    "FROM oven/bun:1.2.22-debian",
    "ENV BUN_INSTALL=/usr/local/share/bun",
    "bun add --global @openai/codex@0.145.0",
    "ENV CODEX_HOME=/home/agent/.codex-prtisan",
  ].every((signature) => contents.includes(signature));
}

async function recommendedDockerfile(root: string): Promise<string> {
  const packagePath = joinPath(root, "package.json");
  if (!(await pathExists(packagePath))) return dockerfileContents();
  try {
    const value = JSON.parse(await readText(packagePath)) as {
      packageManager?: unknown;
      engines?: { node?: unknown };
    };
    const declaration =
      typeof value.packageManager === "string" ? value.packageManager : "";
    const match = /^(bun|npm|pnpm|yarn)@(\d+\.\d+\.\d+)$/.exec(declaration);
    if (!match) return dockerfileContents();
    const manager = match[1] as "bun" | "npm" | "pnpm" | "yarn";
    const version = match[2] as string;
    if (manager === "bun") {
      return dockerfileContents({ kind: "bun", bunVersion: version });
    }
    return dockerfileContents({
      kind: "node",
      nodeVersion: await recommendedNodeVersion(root, value.engines?.node),
      packageManager: manager,
      packageManagerVersion: version,
    });
  } catch {
    return dockerfileContents();
  }
}

async function recommendedNodeVersion(
  root: string,
  engine: unknown
): Promise<string> {
  for (const relativePath of [".node-version", ".nvmrc"]) {
    const path = joinPath(root, relativePath);
    if (!(await pathExists(path))) continue;
    const version = exactVersion(await readText(path));
    if (version) return version;
  }
  if (typeof engine === "string") {
    const version = exactVersion(engine);
    if (version) return version;
    const minimum = />=\s*v?(\d+\.\d+\.\d+)/.exec(engine)?.[1];
    if (minimum) return minimum;
  }
  return "22.18.0";
}

function exactVersion(value: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+)$/.exec(value.trim())?.[1];
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

export async function recommendedManifest(
  root: string,
  targetBranch: string
): Promise<ReturnType<typeof defaultManifest>> {
  const verification = await recommendedVerification(root);
  return defaultManifest({ targetBranch, ...verification });
}

async function recommendedVerification(root: string): Promise<{
  readonly bootstrap?: {
    readonly name: string;
    readonly command: string;
    readonly timeoutMs: number;
  };
  readonly commands?: readonly {
    readonly name: string;
    readonly command: string;
    readonly timeoutMs: number;
  }[];
}> {
  const packagePath = joinPath(root, "package.json");
  if (!(await pathExists(packagePath))) return {};
  try {
    const value = JSON.parse(await readText(packagePath)) as {
      packageManager?: unknown;
      scripts?: Record<string, unknown>;
    };
    const declaration =
      typeof value.packageManager === "string" ? value.packageManager : "";
    const manager = declaration.split("@")[0];
    if (!["pnpm", "npm", "yarn", "bun"].includes(manager)) return {};
    const install =
      manager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : manager === "npm"
          ? "npm ci"
          : manager === "yarn"
            ? "yarn install --immutable"
            : "bun install --frozen-lockfile";
    const scripts = value.scripts ?? {};
    const selected = ["check", "test", "build"].filter(
      (name) => typeof scripts[name] === "string"
    );
    if (selected.length === 0) return {};
    return {
      bootstrap: {
        name: "Install dependencies",
        command: install,
        timeoutMs: 15 * 60 * 1000,
      },
      commands: selected.map((name) => ({
        name: `Project ${name}`,
        command: `${manager} ${name}`,
        timeoutMs: 30 * 60 * 1000,
      })),
    };
  } catch {
    return {};
  }
}
