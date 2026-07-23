import { dirname } from "./path.js";

export async function pathExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

export async function ensureDir(path: string): Promise<void> {
  const proc = Bun.spawn(["mkdir", "-p", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `mkdir -p ${path} failed (${exitCode}): ${stderr || stdout}`
    );
  }
}

export async function writeText(path: string, contents: string): Promise<void> {
  await ensureDir(dirname(path));
  await Bun.write(path, contents);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}
