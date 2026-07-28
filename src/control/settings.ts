import { availableParallelism } from "node:os";

import { pathExists, readJson, writeJson } from "@/fs.js";
import { joinPath } from "@/path.js";
import { prtisanPaths } from "@/prtisan-paths.js";

import { DEFAULT_GLOBAL_SETTINGS, type GlobalSettings } from "./types.js";

export function defaultTurnConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

export async function loadGlobalSettings(): Promise<GlobalSettings> {
  const path = joinPath(prtisanPaths().configRoot, "config.json");
  if (!(await pathExists(path))) {
    return {
      ...DEFAULT_GLOBAL_SETTINGS,
      maxConcurrentTurns: defaultTurnConcurrency(),
    };
  }
  const value = await readJson<Partial<GlobalSettings>>(path);
  return {
    ...DEFAULT_GLOBAL_SETTINGS,
    ...value,
    defaultConversationProfile: {
      ...DEFAULT_GLOBAL_SETTINGS.defaultConversationProfile,
      ...value.defaultConversationProfile,
    },
    maxConcurrentTurns: value.maxConcurrentTurns ?? defaultTurnConcurrency(),
  };
}

export async function saveGlobalSettings(
  settings: GlobalSettings
): Promise<void> {
  await writeJson(joinPath(prtisanPaths().configRoot, "config.json"), settings);
}
