export interface CommandResult {
  readonly command: string[];
  readonly cwd?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface CommandRunner {
  run(
    command: string,
    args?: readonly string[],
    options?: CommandOptions
  ): Promise<CommandResult>;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(
      `${result.command.join(" ")} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`
    );
    this.name = "CommandError";
    this.result = result;
  }
}

export class BunCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[] = [],
    options: CommandOptions = {}
  ): Promise<CommandResult> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...Bun.env, ...options.env },
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            proc.kill();
          }, options.timeoutMs);

    if (options.input !== undefined) {
      const stdin = proc.stdin;
      if (!stdin) {
        throw new Error("Expected a writable stdin pipe for command input.");
      }
      stdin.write(options.input);
      stdin.end();
    }

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    return {
      command: [command, ...args],
      cwd: options.cwd,
      stdout,
      stderr,
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
    };
  }
}

export async function mustRun(
  runner: CommandRunner,
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.exitCode !== 0) {
    throw new CommandError(result);
  }
  return result;
}

export async function runJson<T>(
  runner: CommandRunner,
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {}
): Promise<T> {
  const result = await mustRun(runner, command, args, options);
  return JSON.parse(result.stdout) as T;
}
