import { describe, expect, test } from "bun:test";

describe("package scripts", () => {
  test("registers Prtisan itself instead of linking from Bun's global directory", async () => {
    const packageJson = (await Bun.file(
      new URL("../package.json", import.meta.url)
    ).json()) as { scripts: Record<string, string> };

    expect(packageJson.scripts["link-bin"]).toBe("bun run build && bun link");
  });

  test("clears the hook-local Git index before running nested-repository tests", async () => {
    const hook = await Bun.file(
      new URL("../.husky/pre-commit", import.meta.url)
    ).text();
    const lintStaged = hook.indexOf("bunx lint-staged");
    const clearGitIndex = hook.indexOf("unset GIT_INDEX_FILE");
    const testSuite = hook.indexOf("bun run test");

    expect(lintStaged).toBeGreaterThanOrEqual(0);
    expect(clearGitIndex).toBeGreaterThan(lintStaged);
    expect(testSuite).toBeGreaterThan(clearGitIndex);
  });
});
