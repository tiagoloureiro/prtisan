import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { joinPath, resolvePath } from "./path.js";

export const SHARED_CODEX_HOME = "prtisan://codex-home";

export interface PrtisanPaths {
  readonly stateRoot: string;
  readonly dataRoot: string;
  readonly journal: string;
  readonly artifacts: string;
  readonly codexHome: string;
}

export function prtisanPaths(
  env: Readonly<Record<string, string | undefined>> = Bun.env
): PrtisanPaths {
  const stateBase =
    env.XDG_STATE_HOME?.trim() || joinPath(homedir(), ".local", "state");
  const dataBase =
    env.XDG_DATA_HOME?.trim() || joinPath(homedir(), ".local", "share");
  const stateRoot = joinPath(stateBase, "prtisan");
  const dataRoot = joinPath(dataBase, "prtisan");
  return {
    stateRoot,
    dataRoot,
    journal: joinPath(stateRoot, "journal.sqlite"),
    artifacts: joinPath(dataRoot, "artifacts"),
    codexHome: joinPath(dataRoot, "codex-home"),
  };
}

export function resolveCodexHome(
  cwd: string,
  configuredPath: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env
): string {
  return configuredPath === SHARED_CODEX_HOME
    ? prtisanPaths(env).codexHome
    : resolvePath(cwd, configuredPath);
}

export function prtisanRepositoryDataPath(
  cwd: string,
  ...segments: readonly string[]
): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 20);
  return joinPath(prtisanPaths().dataRoot, "repositories", key, ...segments);
}

export function prtisanRepositoryStatePath(
  cwd: string,
  ...segments: readonly string[]
): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 20);
  return joinPath(prtisanPaths().stateRoot, "repositories", key, ...segments);
}
