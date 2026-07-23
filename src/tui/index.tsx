import { render } from "ink";

import { AgentTrainTui } from "./app.js";
import { createAgentTrainRuntime, type TuiRuntimeOptions } from "./runtime.js";

export async function runTui(options: TuiRuntimeOptions): Promise<number> {
  if (!isInteractiveTerminal()) {
    console.error(
      "agent-train tui requires an interactive terminal. Use agent-train validate or agent-train merge for non-interactive runs."
    );
    return 1;
  }

  process.stdin.resume();
  const runtime = createAgentTrainRuntime(options);
  const instance = render(<AgentTrainTui runtime={runtime} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  const result = await instance.waitUntilExit();
  return typeof result === "number" ? result : 0;
}

function isInteractiveTerminal(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    Bun.env.CI !== "true" &&
    Bun.env.TERM !== "dumb"
  );
}
