import { describe, expect, test } from "bun:test";

import { readText } from "@/fs.js";

describe("documentation", () => {
  test("exposes matching HTML and Markdown documentation links", async () => {
    const html = await readText("docs/index.html");
    const markdown = await readText("docs/index.md");

    expect(markdown).toContain("# Prtisan Documentation");
    expect(markdown).toContain("Raw Markdown for agents");
    expect(html).toContain('href="./index.md"');
    expect(html).toContain(
      "https://raw.githubusercontent.com/tiagoloureiro/prtisan/main/docs/index.md"
    );
    expect(html).toContain("GitHub Issue And PR Conventions");
  });

  test("publishes docs through GitHub Pages actions", async () => {
    const workflow = await readText(".github/workflows/pages.yml");

    expect(workflow).toContain("actions/configure-pages@");
    expect(workflow).toContain("actions/upload-pages-artifact@");
    expect(workflow).toContain("actions/deploy-pages@");
    expect(workflow).toContain("path: docs");
    expect(workflow).toContain("github-pages");
  });
});
