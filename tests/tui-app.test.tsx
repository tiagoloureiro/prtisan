import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";

import { buildOpenPrGraph } from "@/open-pr-graph.js";
import { DashboardView } from "@/tui/app.js";
import { initialTuiModel } from "@/tui/state.js";

import { issue, pullRequest, testConfig } from "./helpers.js";

describe("TUI dashboard render", () => {
  test("renders repo, preflight, PR train, and log state", () => {
    const graph = buildOpenPrGraph(
      [
        {
          pr: pullRequest({
            number: 10,
            headRefName: "feature-a",
            closingIssuesReferences: [{ number: 100 }],
          }),
          issue: issue({ number: 100, title: "Feature A" }),
        },
        {
          pr: pullRequest({
            number: 20,
            headRefName: "feature-b",
            baseRefName: "feature-a",
          }),
        },
      ],
      "main"
    );

    const output = renderToString(
      <DashboardView
        context={{ cwd: "/repo", config: testConfig({ repo: "o/r" }) }}
        diagnostics={[{ name: "Bun runtime", status: "ok", details: "Bun" }]}
        graph={graph}
        model={{
          ...initialTuiModel,
          logs: [{ message: "Loaded 2 open PR(s)." }],
        }}
      />
    );

    expect(output).toContain("Agent Train");
    expect(output).toContain("Repo: o/r");
    expect(output).toContain("ok: Bun runtime");
    expect(output).toContain("L1 #10");
    expect(output).toContain("L2 #20");
    expect(output).toContain("Loaded 2 open PR(s).");
  });
});
