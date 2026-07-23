import type { CommandOptions, CommandResult, CommandRunner } from "../src/exec.js";
import type { Issue } from "../src/types.js";

export function issue(input: Partial<Issue> & Pick<Issue, "number" | "title">): Issue {
  return {
    body: "",
    state: "OPEN",
    url: `https://github.com/o/r/issues/${input.number}`,
    labels: [],
    blockedBy: [],
    blocking: [],
    subIssues: [],
    ...input,
  };
}

export class FakeRunner implements CommandRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly options?: CommandOptions;
  }[] = [];
  private responses: CommandResult[] = [];

  enqueue(stdout: string, exitCode = 0, stderr = ""): void {
    this.responses.push({
      command: [],
      stdout,
      stderr,
      exitCode,
    });
  }

  async run(command: string, args: readonly string[] = [], options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const response = this.responses.shift() ?? {
      command: [command, ...args],
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    return {
      ...response,
      command: [command, ...args],
      cwd: options?.cwd,
    };
  }
}
