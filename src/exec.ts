export interface CommandResult {
  readonly command: string[];
  readonly cwd?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly input?: string;
}

export interface CommandRunner {
  run(command: string, args?: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

export class CommandError extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(
      `${result.command.join(" ")} failed with exit code ${result.exitCode}\n${result.stderr || result.stdout}`,
    );
    this.name = "CommandError";
    this.result = result;
  }
}

export class BunCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[] = [],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...Bun.env, ...options.env },
      stdin: options.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    if (options.input !== undefined) {
      proc.stdin.write(options.input);
      proc.stdin.end();
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      command: [command, ...args],
      cwd: options.cwd,
      stdout,
      stderr,
      exitCode,
    };
  }
}

export async function mustRun(
  runner: CommandRunner,
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {},
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
  options: CommandOptions = {},
): Promise<T> {
  const result = await mustRun(runner, command, args, options);
  return JSON.parse(result.stdout) as T;
}
