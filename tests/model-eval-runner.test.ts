import { describe, expect, test } from "bun:test";

import { AgentExecutionError, AgentInfrastructureError } from "@/agent.js";
import { retryPreAgentInfrastructure } from "@/model-eval/runner.js";

describe("model-evaluation infrastructure retry", () => {
  test("retries a pre-agent infrastructure failure exactly once", async () => {
    const attempts: number[] = [];
    const result = await retryPreAgentInfrastructure(async (retryCount) => {
      attempts.push(retryCount);
      if (retryCount === 0) {
        throw new AgentInfrastructureError("sandbox unavailable");
      }
      return "completed";
    });

    expect(result).toBe("completed");
    expect(attempts).toEqual([0, 1]);
  });

  test("does not retry a completed agent execution failure", async () => {
    let attempts = 0;
    await expect(
      retryPreAgentInfrastructure(async () => {
        attempts += 1;
        throw new AgentExecutionError("malformed output");
      })
    ).rejects.toBeInstanceOf(AgentExecutionError);
    expect(attempts).toBe(1);
  });
});
