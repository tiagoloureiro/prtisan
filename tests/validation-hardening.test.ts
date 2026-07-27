import { describe, expect, test } from "bun:test";

import type { ReviewFinding } from "@/types.js";
import {
  buildValidationSnapshot,
  normalizeAndDedupeFindings,
} from "@/validation-hardening.js";

import { issue, pullRequest, testConfig } from "./helpers.js";

describe("validation hardening", () => {
  test("deduplicates contradictory copies by stable finding identity", () => {
    const advisory: ReviewFinding = {
      axis: "standards",
      severity: "advisory",
      title: "  Docker check can skip  ",
      body: "First explanation.",
      rule: "CI checks must fail closed",
      evidence: "skip branch A",
      path: "./.github/workflows/ci.yml",
    };
    const blocking: ReviewFinding = {
      ...advisory,
      severity: "blocking",
      body: "A different explanation.",
      evidence: "skip branch B",
      path: ".github\\workflows\\ci.yml",
    };

    const findings = normalizeAndDedupeFindings([advisory, blocking]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "blocking",
      title: "Docker check can skip",
      rule: "CI checks must fail closed",
    });
    expect(findings[0]?.findingId).toHaveLength(24);
  });

  test("snapshot identity covers head, base, issue, standards, and runtime", () => {
    const config = testConfig();
    const pr = pullRequest({
      headRefOid: "head-a",
      baseRefOid: "base-a",
    });
    const primary = issue({
      number: 117,
      title: "Harden CI",
      body: "Cancelled checks must not trigger repair.",
    });
    const baseline = buildValidationSnapshot({
      pr,
      diff: "diff --git a/src/a.ts b/src/a.ts",
      issue: primary,
      relatedIssues: [],
      standardsContents: ["AGENTS.md\nRun all checks."],
      runtimeFingerprint: "runtime-a",
      config,
    });
    const variants = [
      buildValidationSnapshot({
        pr: { ...pr, headRefOid: "head-b" },
        diff: "diff --git a/src/a.ts b/src/a.ts",
        issue: primary,
        relatedIssues: [],
        standardsContents: ["AGENTS.md\nRun all checks."],
        runtimeFingerprint: "runtime-a",
        config,
      }),
      buildValidationSnapshot({
        pr: { ...pr, baseRefOid: "base-b" },
        diff: "diff --git a/src/a.ts b/src/a.ts",
        issue: primary,
        relatedIssues: [],
        standardsContents: ["AGENTS.md\nRun all checks."],
        runtimeFingerprint: "runtime-a",
        config,
      }),
      buildValidationSnapshot({
        pr,
        diff: "diff --git a/src/a.ts b/src/a.ts",
        issue: { ...primary, body: "Edited requirement." },
        relatedIssues: [],
        standardsContents: ["AGENTS.md\nRun all checks."],
        runtimeFingerprint: "runtime-a",
        config,
      }),
      buildValidationSnapshot({
        pr,
        diff: "diff --git a/src/a.ts b/src/a.ts",
        issue: primary,
        relatedIssues: [],
        standardsContents: ["AGENTS.md\nA changed rule."],
        runtimeFingerprint: "runtime-a",
        config,
      }),
      buildValidationSnapshot({
        pr,
        diff: "diff --git a/src/a.ts b/src/a.ts",
        issue: primary,
        relatedIssues: [],
        standardsContents: ["AGENTS.md\nRun all checks."],
        runtimeFingerprint: "runtime-b",
        config,
      }),
      buildValidationSnapshot({
        pr,
        diff: "diff --git a/src/a.ts b/src/a.ts",
        issue: primary,
        relatedIssues: [],
        standardsContents: ["AGENTS.md\nRun all checks."],
        runtimeFingerprint: "runtime-a",
        config: testConfig({
          agentProfiles: {
            ...config.agentProfiles,
            standardsReview: {
              model: "gpt-5.6-terra",
              reasoningEffort: "medium",
            },
          },
        }),
      }),
    ];

    expect(new Set(variants.map((snapshot) => snapshot.key))).toHaveLength(6);
    for (const variant of variants) {
      expect(variant.key).not.toBe(baseline.key);
    }
  });
});
