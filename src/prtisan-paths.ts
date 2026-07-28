import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { joinPath, resolvePath } from "./path.js";

export const SHARED_CODEX_HOME = "prtisan://codex-home";

export interface PrtisanPaths {
  readonly stateRoot: string;
  readonly dataRoot: string;
  readonly configRoot: string;
  readonly journal: string;
  readonly control: string;
  readonly artifacts: string;
  readonly attachments: string;
  readonly codexHome: string;
  readonly workerSocket: string;
  readonly workerLock: string;
  readonly workerLog: string;
}

export function prtisanPaths(
  env: Readonly<Record<string, string | undefined>> = Bun.env
): PrtisanPaths {
  const stateBase =
    env.XDG_STATE_HOME?.trim() || joinPath(homedir(), ".local", "state");
  const dataBase =
    env.XDG_DATA_HOME?.trim() || joinPath(homedir(), ".local", "share");
  const configBase =
    env.XDG_CONFIG_HOME?.trim() || joinPath(homedir(), ".config");
  const stateRoot = joinPath(stateBase, "prtisan");
  const dataRoot = joinPath(dataBase, "prtisan");
  const configRoot = joinPath(configBase, "prtisan");
  const runtimeRoot = env.XDG_RUNTIME_DIR?.trim() || stateRoot;
  return {
    stateRoot,
    dataRoot,
    configRoot,
    journal: joinPath(stateRoot, "journal.sqlite"),
    control: joinPath(stateRoot, "control.sqlite"),
    artifacts: joinPath(dataRoot, "artifacts"),
    attachments: joinPath(dataRoot, "attachments"),
    codexHome: joinPath(dataRoot, "codex-home"),
    workerSocket: joinPath(runtimeRoot, "prtisan-worker.sock"),
    workerLock: joinPath(stateRoot, "worker.lock"),
    workerLog: joinPath(stateRoot, "worker.log"),
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
