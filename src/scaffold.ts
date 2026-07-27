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
      `${JSON.stringify(config, null, 2)}\n`,
      options
    )
  );
  files.push(
    await writeManagedFile(
      root,
      PRTISAN_DOCKERFILE_PATH,
      dockerfileContents(),
      options
    )
  );

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

export function dockerfileContents(): string {
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
    '  && mkdir -p "${BUN_INSTALL}" /home/agent/.codex-prtisan \\',
    "  && bun add --global @openai/codex@0.145.0 \\",
    '  && chmod -R a+rX "${BUN_INSTALL}" \\',
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
