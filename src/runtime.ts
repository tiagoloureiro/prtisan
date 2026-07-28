import { randomUUID } from "node:crypto";

import {
  DockerBaseImageManager,
  requireDockerImageId,
} from "./docker-image.js";
import {
  managedDockerBuildLabels,
  managedDockerRunLabels,
} from "./docker-ownership.js";
import type { CommandRunner } from "./exec.js";
import { ensureDir } from "./fs.js";
import { joinPath, resolvePath } from "./path.js";
import { prtisanRepositoryDataPath } from "./prtisan-paths.js";
import { redactCredentialValues } from "./redaction.js";
import type {
  AgentTrainConfig,
  SandboxCommandConfig,
  VerificationResult,
} from "./types.js";
import { stableDigest } from "./validation-hardening.js";

const RUNTIME_SCHEMA_VERSION = 1;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_OUTPUT_CHARS = 8_000;

export interface ToolchainProfile {
  readonly kind: "node" | "bun" | "python" | "go" | "rust" | "image";
  readonly nodeVersion?: string;
  readonly languageVersion?: string;
  readonly packageManager?:
    "pnpm" | "npm" | "yarn" | "bun" | "uv" | "go" | "cargo";
  readonly packageManagerVersion?: string;
  readonly lockfileDigest?: string;
  readonly bootstrap?: SandboxCommandConfig;
  readonly verification: readonly SandboxCommandConfig[];
  readonly probes: readonly SandboxCommandConfig[];
  readonly fingerprint: string;
}

export interface PreparedRuntime {
  readonly imageName: string;
  readonly fingerprint: string;
  readonly profile: ToolchainProfile;
  readonly bootstrap?: SandboxCommandConfig;
  readonly verification: readonly SandboxCommandConfig[];
  readonly probes: readonly SandboxCommandConfig[];
  readonly cacheMount?: {
    readonly hostPath: string;
    readonly sandboxPath: string;
  };
}

export interface ToolchainResolver {
  resolve(input: {
    readonly cwd: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
  }): Promise<ToolchainProfile>;
}

export interface RuntimeImageBuilder {
  ensureImage(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly profile: ToolchainProfile;
  }): Promise<string>;
}

export interface RuntimeProvider {
  prepare(input: {
    readonly cwd: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
  }): Promise<PreparedRuntime>;
}

export interface VerificationRunner {
  verify(input: {
    readonly cwd: string;
    readonly runId: string;
    readonly label: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
    readonly runtime: PreparedRuntime;
    readonly extraCommands?: readonly SandboxCommandConfig[];
  }): Promise<VerificationResult>;
}

export class DeclaredRuntimeProvider implements RuntimeProvider {
  constructor(private readonly baseImages: DockerBaseImageManager) {}

  async prepare(input: {
    readonly cwd: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
  }): Promise<PreparedRuntime> {
    if (
      input.config.runtime.verificationMode !== "explicit" ||
      input.config.runtime.verification.length === 0
    ) {
      throw new RuntimePreparationError(
        "Prtisan requires repository-declared verification commands.",
        "unsupported"
      );
    }
    const image = await this.baseImages.ensure({
      cwd: input.cwd,
      config: input.config,
      ref: `${input.config.remote}/${input.config.targetBranch}`,
    });
    const packageManager = declaredPackageManager(
      input.config.runtime.bootstrap?.command
    );
    const cacheMount = await packageManagerCacheMount(
      input.cwd,
      packageManager,
      packageManager
        ? stableDigest({
            schema: RUNTIME_SCHEMA_VERSION,
            source: "declared",
            packageManager,
            bootstrap: input.config.runtime.bootstrap?.command,
          })
        : undefined
    );
    const bootstrap = bootstrapWithCachePath(
      input.config.runtime.bootstrap,
      packageManager,
      cacheMount?.sandboxPath
    );
    const profileValue = {
      kind: "image" as const,
      packageManager,
      bootstrap,
      verification: input.config.runtime.verification,
      probes: input.config.runtime.probes,
      imageId: image.id,
      ref: input.ref,
    };
    return {
      imageName: image.id,
      fingerprint: stableDigest(profileValue),
      profile: {
        ...profileValue,
        fingerprint: stableDigest(profileValue),
      },
      bootstrap,
      verification: input.config.runtime.verification,
      probes: input.config.runtime.probes,
      cacheMount,
    };
  }
}

export class RuntimePreparationError extends Error {
  constructor(
    message: string,
    readonly category: "infra_failed" | "unsupported" = "infra_failed"
  ) {
    super(message);
    this.name = "RuntimePreparationError";
  }
}

export class ManifestToolchainResolver implements ToolchainResolver {
  constructor(private readonly runner: CommandRunner) {}

  async resolve(input: {
    readonly cwd: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
  }): Promise<ToolchainProfile> {
    const reader = new GitSnapshotReader(this.runner, input.cwd, input.ref);
    const packageJsonText = await reader.read("package.json");
    const configuredVerification = input.config.runtime.verification;

    if (!packageJsonText) {
      const detected = await resolveNonNodeProfile(
        reader,
        input.config,
        configuredVerification
      );
      if (detected) return detected;
      if (
        input.config.runtime.verificationMode !== "explicit" ||
        configuredVerification.length === 0 ||
        input.config.runtime.probes.length === 0
      ) {
        throw new RuntimePreparationError(
          "Unsupported runtime stacks require explicit sandbox probes and verification commands.",
          "unsupported"
        );
      }
      const imageProfile = {
        kind: "image" as const,
        bootstrap: input.config.runtime.bootstrap,
        verification: configuredVerification,
        probes: input.config.runtime.probes,
      };
      return {
        ...imageProfile,
        fingerprint: stableDigest({
          schema: RUNTIME_SCHEMA_VERSION,
          ...imageProfile,
          image: input.config.docker.imageName,
        }),
      };
    }

    const packageJson = parsePackageJson(packageJsonText);
    const manager = await packageManagerProfile(reader, packageJson);
    const nodeVersions = await nodeVersionCandidates(reader, packageJson);
    const uniqueNodeVersions = [...new Set(nodeVersions.map(normalizeVersion))];
    if (uniqueNodeVersions.length > 1) {
      throw new RuntimePreparationError(
        `Conflicting Node versions: ${uniqueNodeVersions.join(", ")}.`,
        "unsupported"
      );
    }
    const nodeVersion = uniqueNodeVersions[0];
    if (manager.name !== "bun" && !nodeVersion) {
      throw new RuntimePreparationError(
        "A Node project must pin an exact version in .node-version, .nvmrc, .tool-versions, mise.toml, or package.json engines.node.",
        "unsupported"
      );
    }
    if (nodeVersion) {
      assertEngineAllowsVersion(packageJson.engines?.node, nodeVersion);
    }
    const scripts = packageJson.scripts ?? {};
    const autoVerification = autoVerificationCommands(manager.name, scripts);
    const verification =
      input.config.runtime.verificationMode === "explicit"
        ? configuredVerification
        : [...autoVerification, ...configuredVerification];
    if (verification.length === 0) {
      throw new RuntimePreparationError(
        "No safe verification commands were discovered. Configure runtime.verification explicitly.",
        "unsupported"
      );
    }

    const lockfileContents = await reader.read(manager.lockfile);
    if (!lockfileContents) {
      throw new RuntimePreparationError(
        `Expected ${manager.lockfile} for ${manager.name}, but it is missing.`,
        "unsupported"
      );
    }
    const bootstrap =
      input.config.runtime.bootstrap ??
      bootstrapCommand(manager.name, manager.lockfile);
    const probes = [
      ...(manager.name === "bun"
        ? []
        : [
            exactVersionProbe(
              "Node",
              "node --version",
              `v${nodeVersion as string}`
            ),
          ]),
      exactVersionProbe(
        `${manager.name} package manager`,
        `${manager.name} --version`,
        manager.version as string
      ),
      command("ripgrep", "rg --version", 30_000),
      ...input.config.runtime.probes,
    ];
    const profileValue = {
      schema: RUNTIME_SCHEMA_VERSION,
      kind: (manager.name === "bun" ? "bun" : "node") as "bun" | "node",
      nodeVersion,
      packageManager: manager.name,
      packageManagerVersion: manager.version,
      lockfileDigest: stableDigest(lockfileContents),
      bootstrap,
      verification,
      probes,
      image: input.config.docker.imageName,
    };

    return {
      kind: manager.name === "bun" ? "bun" : "node",
      nodeVersion,
      packageManager: manager.name,
      packageManagerVersion: manager.version,
      lockfileDigest: profileValue.lockfileDigest,
      bootstrap,
      verification,
      probes,
      fingerprint: stableDigest(profileValue),
    };
  }
}

export class DockerRuntimeImageBuilder implements RuntimeImageBuilder {
  constructor(
    private readonly runner: CommandRunner,
    private readonly baseImages = new DockerBaseImageManager(runner)
  ) {}

  async ensureImage(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly profile: ToolchainProfile;
  }): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.ensureImageOnce(input);
      } catch (error) {
        if (attempt === 0 && isVanishedRuntimeImageError(error)) {
          this.baseImages.clear(input);
          continue;
        }
        throw error;
      }
    }
    throw new RuntimePreparationError(
      "Runtime image preparation exhausted its retry budget."
    );
  }

  private async ensureImageOnce(input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly profile: ToolchainProfile;
  }): Promise<string> {
    const baseImage = await this.baseImages.ensure(input);
    if (input.profile.kind === "image" || !input.config.runtime.autoProvision) {
      return baseImage.id;
    }
    const baseImageId = baseImage.id;
    const toolchainImageId = await pullImmutableImage(
      this.runner,
      input.cwd,
      toolchainStageImage(input.profile),
      input.config.validation.maxWallTimeMs
    );
    const toolsImageId = await pullImmutableImage(
      this.runner,
      input.cwd,
      "debian:bookworm-slim",
      input.config.validation.maxWallTimeMs
    );
    const imageDigest = stableDigest({
      baseImageId,
      toolchainImageId,
      toolsImageId,
      toolchain: input.profile.fingerprint,
      dockerfile: runtimeDockerfileDigest(input.profile),
    });
    const imageName = `prtisan/runtime:${imageDigest.slice(0, 20)}`;
    const inspect = await this.runner.run(
      "docker",
      ["image", "inspect", imageName],
      { cwd: input.cwd }
    );
    if (inspect.exitCode === 0) return imageName;

    const runtimeDir = prtisanRepositoryDataPath(
      input.cwd,
      "runtime",
      input.profile.fingerprint
    );
    await ensureDir(runtimeDir);

    const sourceReferences = await createTemporaryImageReferences(
      this.runner,
      input.cwd,
      {
        base: baseImageId,
        toolchain: toolchainImageId,
        tools: toolsImageId,
      }
    );
    let build;
    try {
      build = await this.runner.run(
        "docker",
        [
          "build",
          "-t",
          imageName,
          ...managedDockerBuildLabels("runtime-image"),
          "--build-arg",
          `AGENT_UID=${runtimeUid()}`,
          "--build-arg",
          `AGENT_GID=${runtimeGid()}`,
          "-f",
          "-",
          runtimeDir,
        ],
        {
          cwd: input.cwd,
          input: runtimeDockerfile(input.profile, sourceReferences.references),
          timeoutMs: Math.min(
            20 * 60 * 1000,
            input.config.validation.maxWallTimeMs
          ),
        }
      );
    } finally {
      await removeTemporaryImageReferences(
        this.runner,
        input.cwd,
        sourceReferences.created
      );
    }
    if (build.exitCode !== 0) {
      throw new RuntimePreparationError(
        `Unable to build runtime image ${imageName}: ${trimOutput(
          build.stderr || build.stdout
        )}`
      );
    }
    return imageName;
  }
}

export class DockerRuntimeProvider implements RuntimeProvider {
  constructor(
    private readonly runner: CommandRunner,
    private readonly resolver: ToolchainResolver = new ManifestToolchainResolver(
      runner
    ),
    baseImages: DockerBaseImageManager = new DockerBaseImageManager(runner),
    private readonly imageBuilder: RuntimeImageBuilder = new DockerRuntimeImageBuilder(
      runner,
      baseImages
    ),
    private readonly now: () => number = Date.now
  ) {}

  async prepare(input: {
    readonly cwd: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
  }): Promise<PreparedRuntime> {
    const deadlineAt = this.now() + input.config.validation.maxWallTimeMs;
    const profile = await this.resolver.resolve(input);
    const imageName = await this.imageBuilder.ensureImage({
      cwd: input.cwd,
      config: configWithinDeadline(input.config, deadlineAt, this.now),
      profile,
    });
    const cacheMount = await packageManagerCacheMount(
      input.cwd,
      profile.packageManager,
      profile.lockfileDigest
    );
    const runtime = {
      imageName,
      fingerprint: stableDigest({
        profile: profile.fingerprint,
        imageName,
      }),
      profile,
      bootstrap: profile.bootstrap,
      verification: profile.verification,
      probes: profile.probes,
      cacheMount,
    } satisfies PreparedRuntime;

    await runRuntimeProbes(
      this.runner,
      input.cwd,
      runtime,
      deadlineAt,
      this.now
    );
    return runtime;
  }
}

export class DockerVerificationRunner implements VerificationRunner {
  constructor(
    private readonly runner: CommandRunner,
    private readonly now: () => number = Date.now
  ) {}

  async verify(input: {
    readonly cwd: string;
    readonly runId: string;
    readonly label: string;
    readonly ref: string;
    readonly config: AgentTrainConfig;
    readonly runtime: PreparedRuntime;
    readonly extraCommands?: readonly SandboxCommandConfig[];
  }): Promise<VerificationResult> {
    const deadlineAt = this.now() + input.config.validation.maxWallTimeMs;
    const worktreePath = prtisanRepositoryDataPath(
      input.cwd,
      "runs",
      input.runId,
      "worktrees",
      `verify-${safeLabel(input.label)}`
    );
    await ensureDir(
      prtisanRepositoryDataPath(input.cwd, "runs", input.runId, "worktrees")
    );
    await this.runner.run(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: input.cwd }
    );
    const add = await this.runner.run(
      "git",
      ["worktree", "add", "--force", "--detach", worktreePath, input.ref],
      { cwd: input.cwd }
    );
    if (add.exitCode !== 0) {
      return {
        status: "infra_failed",
        commands: [
          commandResult(
            "Verification worktree",
            `git worktree add ${input.ref}`,
            add,
            0
          ),
        ],
      };
    }
    const gitCommonDir = await resolveGitCommonDirectory(
      this.runner,
      input.cwd,
      worktreePath
    );

    const commands: VerificationResult["commands"][number][] = [];
    try {
      if (input.runtime.bootstrap) {
        const result = await runInRuntime(
          this.runner,
          input,
          worktreePath,
          gitCommonDir,
          input.runtime.bootstrap,
          deadlineAt,
          this.now
        );
        commands.push(result);
        if (result.exitCode !== 0) {
          return {
            status: "infra_failed",
            commands,
          };
        }
      }

      const verification = [
        ...input.runtime.verification,
        ...(input.extraCommands ?? []),
      ];
      if (verification.length === 0) {
        return {
          status: "infra_failed",
          commands: [
            ...commands,
            {
              name: "Verification policy",
              command: "",
              exitCode: 1,
              durationMs: 0,
              timedOut: false,
              output: "No verification commands are configured.",
            },
          ],
        };
      }

      for (const item of verification) {
        const result = await runInRuntime(
          this.runner,
          input,
          worktreePath,
          gitCommonDir,
          item,
          deadlineAt,
          this.now
        );
        commands.push(result);
        if (result.exitCode !== 0) {
          return {
            status: isInfrastructureCommandFailure(result)
              ? "infra_failed"
              : "failed",
            commands,
          };
        }
      }

      return { status: "passed", commands };
    } finally {
      await this.runner.run(
        "git",
        ["worktree", "remove", "--force", worktreePath],
        { cwd: input.cwd }
      );
      await this.runner.run("git", ["worktree", "prune"], { cwd: input.cwd });
    }
  }
}

class GitSnapshotReader {
  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string,
    private readonly ref: string
  ) {}

  async read(path: string): Promise<string | undefined> {
    const result = await this.runner.run(
      "git",
      ["show", `${this.ref}:${path}`],
      {
        cwd: this.cwd,
      }
    );
    return result.exitCode === 0 ? result.stdout : undefined;
  }
}

interface PackageJson {
  readonly packageManager?: string;
  readonly engines?: {
    readonly node?: string;
  };
  readonly scripts?: Readonly<Record<string, string>>;
}

function parsePackageJson(contents: string): PackageJson {
  try {
    return JSON.parse(contents) as PackageJson;
  } catch (error) {
    throw new RuntimePreparationError(
      `package.json is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }.`,
      "unsupported"
    );
  }
}

async function nodeVersionCandidates(
  reader: GitSnapshotReader,
  packageJson: PackageJson
): Promise<string[]> {
  const candidates: string[] = [];
  for (const path of [".node-version", ".nvmrc"]) {
    const contents = (await reader.read(path))?.trim();
    if (contents) candidates.push(contents.replace(/^v/, ""));
  }

  const toolVersions = await reader.read(".tool-versions");
  const toolVersionDeclaration = toolVersions?.match(
    /^(?:node|nodejs)\s+(\S+)\s*$/m
  )?.[1];
  if (toolVersionDeclaration) {
    candidates.push(normalizeVersion(toolVersionDeclaration));
  }

  for (const path of ["mise.toml", ".mise.toml"]) {
    const contents = await reader.read(path);
    const miseVersionDeclaration = contents?.match(
      /^(?:node|nodejs)\s*=\s*["']([^"']+)["']\s*$/m
    )?.[1];
    if (miseVersionDeclaration) {
      candidates.push(normalizeVersion(miseVersionDeclaration));
    }
  }

  const exactEngine = exactVersion(packageJson.engines?.node);
  if (exactEngine) candidates.push(exactEngine);
  return candidates;
}

async function packageManagerProfile(
  reader: GitSnapshotReader,
  packageJson: PackageJson
): Promise<{
  readonly name: "pnpm" | "npm" | "yarn" | "bun";
  readonly version?: string;
  readonly lockfile: string;
}> {
  const lockfiles = await discoveredLockfiles(reader);
  const declared = packageJson.packageManager?.match(
    /^(pnpm|npm|yarn|bun)@(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)$/i
  );
  if (declared?.[1]) {
    const name = declared[1].toLowerCase() as "pnpm" | "npm" | "yarn" | "bun";
    const foreignLockfiles = lockfiles.filter((item) => item.name !== name);
    if (foreignLockfiles.length > 0) {
      throw new RuntimePreparationError(
        `packageManager declares ${name}, but conflicting lockfile(s) exist: ${foreignLockfiles.map((item) => item.path).join(", ")}.`,
        "unsupported"
      );
    }
    const lockfile = lockfiles.find((item) => item.name === name)?.path;
    if (!lockfile) {
      throw new RuntimePreparationError(
        `packageManager declares ${name}, but its lockfile is missing.`,
        "unsupported"
      );
    }
    return { name, version: declared[2], lockfile };
  }
  if (packageJson.packageManager) {
    throw new RuntimePreparationError(
      `packageManager must pin an exact supported version; received ${packageJson.packageManager}.`,
      "unsupported"
    );
  }

  if (lockfiles.length > 0) {
    throw new RuntimePreparationError(
      `Found ${lockfiles.map((item) => item.path).join(", ")}, but package.json does not pin an exact packageManager version.`,
      "unsupported"
    );
  }
  throw new RuntimePreparationError(
    "No supported package-manager lockfile was found.",
    "unsupported"
  );
}

async function discoveredLockfiles(reader: GitSnapshotReader): Promise<
  {
    readonly name: "pnpm" | "npm" | "yarn" | "bun";
    readonly path: string;
  }[]
> {
  const candidates = [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
  ] as const;
  const found: {
    name: "pnpm" | "npm" | "yarn" | "bun";
    path: string;
  }[] = [];
  for (const [name, path] of candidates) {
    if (await reader.read(path)) found.push({ name, path });
  }
  return found;
}

async function resolveNonNodeProfile(
  reader: GitSnapshotReader,
  config: AgentTrainConfig,
  configuredVerification: readonly SandboxCommandConfig[]
): Promise<ToolchainProfile | undefined> {
  const [
    pyproject,
    uvLock,
    pythonVersion,
    goMod,
    cargoToml,
    cargoLock,
    rustToolchain,
  ] = await Promise.all([
    reader.read("pyproject.toml"),
    reader.read("uv.lock"),
    reader.read(".python-version"),
    reader.read("go.mod"),
    reader.read("Cargo.toml"),
    reader.read("Cargo.lock"),
    reader
      .read("rust-toolchain.toml")
      .then((value) => value ?? reader.read("rust-toolchain")),
  ]);
  const detected = [
    pyproject && uvLock ? "python" : undefined,
    goMod ? "go" : undefined,
    cargoToml && cargoLock ? "rust" : undefined,
  ].filter(Boolean);
  if (detected.length > 1) {
    throw new RuntimePreparationError(
      `Detected a polyglot repository (${detected.join(", ")}). Configure runtime verification and probes explicitly for the composed image.`,
      "unsupported"
    );
  }

  if (pyproject && uvLock) {
    const version =
      exactLanguageVersion(pythonVersion) ??
      pyproject.match(/requires-python\s*=\s*["']==(\d+\.\d+\.\d+)["']/)?.[1];
    if (!version) {
      throw new RuntimePreparationError(
        "A Python/uv project must pin an exact version in .python-version or pyproject.toml requires-python.",
        "unsupported"
      );
    }
    const automatic = [
      ...(pyproject.includes("ruff")
        ? [command("Ruff", "uv run ruff check .")]
        : []),
      ...(pyproject.includes("pytest")
        ? [command("Pytest", "uv run pytest")]
        : []),
    ];
    const verification = configuredOrAutomaticVerification(
      config,
      configuredVerification,
      automatic,
      "Python"
    );
    return languageProfile({
      kind: "python",
      version,
      manager: "uv",
      managerVersion: "0.8.13",
      lockfile: uvLock,
      bootstrap: command(
        "Install Python dependencies from uv.lock",
        `UV_CACHE_DIR=${packageManagerCachePath("uv")} uv sync --frozen`
      ),
      verification,
      probes: [
        exactVersionProbe(
          "Python",
          "python --version 2>&1",
          `Python ${version}`
        ),
        exactVersionProbe("uv", "uv --version", "uv 0.8.13"),
        command("ripgrep", "rg --version", 30_000),
        ...config.runtime.probes,
      ],
    });
  }

  if (goMod) {
    const version = goMod.match(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new RuntimePreparationError(
        "go.mod must pin an exact three-part Go version.",
        "unsupported"
      );
    }
    const verification = configuredOrAutomaticVerification(
      config,
      configuredVerification,
      [command("Go vet", "go vet ./..."), command("Go tests", "go test ./...")],
      "Go"
    );
    return languageProfile({
      kind: "go",
      version,
      manager: "go",
      lockfile: goMod,
      bootstrap: command(
        "Download Go modules",
        `GOMODCACHE=${packageManagerCachePath("go")} go mod download`
      ),
      verification,
      probes: [
        exactVersionProbe(
          "Go",
          "go version | awk '{print $3}'",
          `go${version}`
        ),
        command("ripgrep", "rg --version", 30_000),
        ...config.runtime.probes,
      ],
    });
  }

  if (cargoToml && cargoLock) {
    const version = rustToolchain?.match(
      /(?:channel\s*=\s*["']|^)(\d+\.\d+\.\d+)(?:["']|\s*$)/m
    )?.[1];
    if (!version) {
      throw new RuntimePreparationError(
        "A Rust project must pin an exact toolchain in rust-toolchain.toml or rust-toolchain.",
        "unsupported"
      );
    }
    const verification = configuredOrAutomaticVerification(
      config,
      configuredVerification,
      [
        command("Cargo format", "cargo fmt --check"),
        command(
          "Cargo clippy",
          "cargo clippy --all-targets --all-features -- -D warnings"
        ),
        command("Cargo tests", "cargo test --locked"),
      ],
      "Rust"
    );
    return languageProfile({
      kind: "rust",
      version,
      manager: "cargo",
      lockfile: cargoLock,
      bootstrap: command("Fetch Cargo dependencies", "cargo fetch --locked"),
      verification,
      probes: [
        exactVersionProbe(
          "Rust",
          "rustc --version | awk '{print $2}'",
          version
        ),
        command("ripgrep", "rg --version", 30_000),
        ...config.runtime.probes,
      ],
    });
  }

  return undefined;
}

function configuredOrAutomaticVerification(
  config: AgentTrainConfig,
  configured: readonly SandboxCommandConfig[],
  automatic: readonly SandboxCommandConfig[],
  language: string
): readonly SandboxCommandConfig[] {
  const verification =
    config.runtime.verificationMode === "explicit"
      ? configured
      : [...automatic, ...configured];
  if (verification.length === 0) {
    throw new RuntimePreparationError(
      `No safe ${language} verification commands were discovered. Configure runtime.verification explicitly.`,
      "unsupported"
    );
  }
  return verification;
}

function languageProfile(input: {
  readonly kind: "python" | "go" | "rust";
  readonly version: string;
  readonly manager: "uv" | "go" | "cargo";
  readonly managerVersion?: string;
  readonly lockfile: string;
  readonly bootstrap: SandboxCommandConfig;
  readonly verification: readonly SandboxCommandConfig[];
  readonly probes: readonly SandboxCommandConfig[];
}): ToolchainProfile {
  const value = {
    schema: RUNTIME_SCHEMA_VERSION,
    kind: input.kind,
    languageVersion: input.version,
    packageManager: input.manager,
    packageManagerVersion: input.managerVersion,
    lockfileDigest: stableDigest(input.lockfile),
    bootstrap: input.bootstrap,
    verification: input.verification,
    probes: input.probes,
  };
  return { ...value, fingerprint: stableDigest(value) };
}

function exactLanguageVersion(value: string | undefined): string | undefined {
  const version = value?.trim().replace(/^v/, "");
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

function autoVerificationCommands(
  manager: "pnpm" | "npm" | "yarn" | "bun",
  scripts: Readonly<Record<string, string>>
): SandboxCommandConfig[] {
  const commands: SandboxCommandConfig[] = [];
  if (scripts.check) {
    commands.push(scriptCommand(manager, "check"));
  } else {
    for (const name of ["format:check", "lint", "typecheck"]) {
      if (scripts[name]) commands.push(scriptCommand(manager, name));
    }
  }
  for (const name of ["test", "build"]) {
    if (scripts[name]) commands.push(scriptCommand(manager, name));
  }
  return commands;
}

function scriptCommand(
  manager: "pnpm" | "npm" | "yarn" | "bun",
  script: string
): SandboxCommandConfig {
  const invocation =
    manager === "npm"
      ? script === "test"
        ? "npm test"
        : `npm run ${script}`
      : manager === "yarn"
        ? `yarn ${script}`
        : manager === "bun"
          ? `bun run ${script}`
          : `pnpm ${script}`;
  return command(`Project ${script}`, invocation);
}

function bootstrapCommand(
  manager: "pnpm" | "npm" | "yarn" | "bun",
  lockfile: string
): SandboxCommandConfig {
  const cachePath = packageManagerCachePath(manager);
  const invocation =
    manager === "pnpm"
      ? `pnpm install --frozen-lockfile --store-dir ${cachePath}`
      : manager === "npm"
        ? `npm ci --cache ${cachePath}`
        : manager === "yarn"
          ? `YARN_CACHE_FOLDER=${cachePath} yarn install --immutable`
          : `BUN_INSTALL_CACHE_DIR=${cachePath} bun install --frozen-lockfile`;
  return command(`Install dependencies from ${lockfile}`, invocation);
}

function command(
  name: string,
  invocation: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
): SandboxCommandConfig {
  return { name, command: invocation, timeoutMs };
}

function exactVersionProbe(
  name: string,
  invocation: string,
  expected: string
): SandboxCommandConfig {
  return command(
    name,
    `actual=$(${invocation}) && printf '%s\\n' "$actual" && test "$actual" = "${expected}"`,
    30_000
  );
}

type RuntimeSourceRole = "base" | "toolchain" | "tools";

interface RuntimeSourceReferences {
  readonly base: string;
  readonly toolchain: string;
  readonly tools: string;
}

async function createTemporaryImageReferences(
  runner: CommandRunner,
  cwd: string,
  imageIds: RuntimeSourceReferences
): Promise<{
  readonly references: RuntimeSourceReferences;
  readonly created: readonly string[];
}> {
  const buildId = randomUUID().replaceAll("-", "");
  const references = {} as Record<RuntimeSourceRole, string>;
  const created: string[] = [];

  for (const role of ["base", "toolchain", "tools"] as const) {
    const imageId = imageIds[role];
    const digest = requireDockerImageId(imageId, `${role} runtime`).slice(
      "sha256:".length
    );
    const reference = `prtisan.invalid/runtime-input:${role}-${digest}-${buildId}`;
    const tag = await runner.run(
      "docker",
      ["image", "tag", imageId, reference],
      { cwd }
    );
    if (tag.exitCode !== 0) {
      await removeTemporaryImageReferences(runner, cwd, created);
      throw new RuntimePreparationError(
        `Unable to create local ${role} runtime image reference from ${imageId}: ${trimOutput(
          tag.stderr || tag.stdout
        )}`
      );
    }
    references[role] = reference;
    created.push(reference);
  }

  return { references, created };
}

async function removeTemporaryImageReferences(
  runner: CommandRunner,
  cwd: string,
  references: readonly string[]
): Promise<void> {
  for (const reference of [...references].reverse()) {
    await runner.run("docker", ["image", "rm", reference], { cwd });
  }
}

function runtimeDockerfile(
  profile: ToolchainProfile,
  references: RuntimeSourceReferences
): string {
  const manager = profile.packageManager ?? "npm";
  const managerVersion = profile.packageManagerVersion
    ? requireSafeVersion(profile.packageManagerVersion, manager)
    : undefined;
  if (profile.kind === "bun") {
    return [
      `ARG BASE_IMAGE=${references.base}`,
      `ARG TOOLCHAIN_IMAGE=${references.toolchain}`,
      `ARG TOOLS_IMAGE=${references.tools}`,
      "FROM ${TOOLCHAIN_IMAGE} AS bun_runtime",
      "",
      "FROM ${TOOLS_IMAGE} AS tools",
      "RUN apt-get update \\",
      "  && apt-get install -y --no-install-recommends ripgrep \\",
      "  && rm -rf /var/lib/apt/lists/*",
      "",
      "FROM ${BASE_IMAGE}",
      "USER root",
      "COPY --from=bun_runtime /usr/local/bin/bun /usr/local/bin/bun",
      "COPY --from=tools /usr/bin/rg /usr/local/bin/rg",
      "ARG AGENT_UID=1000",
      "ARG AGENT_GID=1000",
      "USER ${AGENT_UID}:${AGENT_GID}",
      "",
    ].join("\n");
  }

  if (profile.kind === "python") {
    return [
      ...runtimeStageHeader(references),
      "FROM ${TOOLCHAIN_IMAGE} AS language_runtime",
      "RUN pip install --no-cache-dir uv==0.8.13",
      "",
      ...toolsStage(),
      "FROM ${BASE_IMAGE}",
      "USER root",
      "COPY --from=language_runtime /usr/local/ /usr/local/",
      "COPY --from=tools /usr/bin/rg /usr/local/bin/rg",
      ...runtimeUserFooter(),
    ].join("\n");
  }

  if (profile.kind === "go") {
    return [
      ...runtimeStageHeader(references),
      "FROM ${TOOLCHAIN_IMAGE} AS language_runtime",
      "",
      ...toolsStage(),
      "FROM ${BASE_IMAGE}",
      "USER root",
      "COPY --from=language_runtime /usr/local/go/ /usr/local/go/",
      "COPY --from=tools /usr/bin/rg /usr/local/bin/rg",
      "ENV PATH=/usr/local/go/bin:${PATH}",
      ...runtimeUserFooter(),
    ].join("\n");
  }

  if (profile.kind === "rust") {
    return [
      ...runtimeStageHeader(references),
      "FROM ${TOOLCHAIN_IMAGE} AS language_runtime",
      "RUN rustup component add rustfmt clippy",
      "",
      ...toolsStage(),
      "FROM ${BASE_IMAGE}",
      "USER root",
      "COPY --from=language_runtime /usr/local/cargo/ /usr/local/cargo/",
      "COPY --from=language_runtime /usr/local/rustup/ /usr/local/rustup/",
      "COPY --from=tools /usr/bin/rg /usr/local/bin/rg",
      "ENV PATH=/usr/local/cargo/bin:${PATH}",
      "ENV RUSTUP_HOME=/usr/local/rustup",
      "ENV CARGO_HOME=/home/agent/.cargo",
      ...runtimeUserFooter(),
    ].join("\n");
  }

  const install =
    manager === "bun"
      ? "RUN true"
      : managerVersion
        ? `RUN npm install --global ${manager}@${managerVersion}`
        : "RUN true";

  return [
    `ARG BASE_IMAGE=${references.base}`,
    `ARG TOOLCHAIN_IMAGE=${references.toolchain}`,
    `ARG TOOLS_IMAGE=${references.tools}`,
    "FROM ${TOOLCHAIN_IMAGE} AS node_runtime",
    install,
    "RUN set -eu; \\",
    "  mkdir -p /runtime-libs; \\",
    "  libatomic_path=\"$(ldd /usr/local/bin/node | awk '/libatomic\\.so\\.1/ { print $3; exit }')\"; \\",
    '  if [ -n "${libatomic_path}" ]; then \\',
    '    libatomic_dir="$(dirname "$(readlink -f "${libatomic_path}")")"; \\',
    '    mkdir -p "/runtime-libs${libatomic_dir}"; \\',
    '    cp -L "${libatomic_path}" "/runtime-libs${libatomic_dir}/libatomic.so.1"; \\',
    "  fi",
    "",
    "FROM ${TOOLS_IMAGE} AS tools",
    "RUN apt-get update \\",
    "  && apt-get install -y --no-install-recommends ripgrep \\",
    "  && rm -rf /var/lib/apt/lists/*",
    "",
    "FROM ${BASE_IMAGE}",
    "USER root",
    "COPY --from=node_runtime /usr/local/ /usr/local/",
    "COPY --from=node_runtime /runtime-libs/ /",
    "COPY --from=tools /usr/bin/rg /usr/local/bin/rg",
    "ARG AGENT_UID=1000",
    "ARG AGENT_GID=1000",
    "ENV PATH=/usr/local/bin:${PATH}",
    "USER ${AGENT_UID}:${AGENT_GID}",
    "",
  ].join("\n");
}

function runtimeStageHeader(references: RuntimeSourceReferences): string[] {
  return [
    `ARG BASE_IMAGE=${references.base}`,
    `ARG TOOLCHAIN_IMAGE=${references.toolchain}`,
    `ARG TOOLS_IMAGE=${references.tools}`,
  ];
}

function toolsStage(): string[] {
  return [
    "FROM ${TOOLS_IMAGE} AS tools",
    "RUN apt-get update \\",
    "  && apt-get install -y --no-install-recommends ripgrep \\",
    "  && rm -rf /var/lib/apt/lists/*",
    "",
  ];
}

function runtimeUserFooter(): string[] {
  return [
    "ARG AGENT_UID=1000",
    "ARG AGENT_GID=1000",
    "USER ${AGENT_UID}:${AGENT_GID}",
    "",
  ];
}

function runtimeDockerfileDigest(profile: ToolchainProfile): string {
  return stableDigest(
    runtimeDockerfile(profile, {
      base: "prtisan.invalid/runtime-template:base",
      toolchain: "prtisan.invalid/runtime-template:toolchain",
      tools: "prtisan.invalid/runtime-template:tools",
    })
  );
}

function toolchainStageImage(profile: ToolchainProfile): string {
  if (profile.kind === "bun") {
    return `oven/bun:${requireSafeVersion(
      profile.packageManagerVersion,
      "Bun"
    )}-debian`;
  }
  if (profile.kind === "python") {
    return `python:${requireSafeVersion(
      profile.languageVersion,
      "Python"
    )}-bookworm`;
  }
  if (profile.kind === "go") {
    return `golang:${requireSafeVersion(
      profile.languageVersion,
      "Go"
    )}-bookworm`;
  }
  if (profile.kind === "rust") {
    return `rust:${requireSafeVersion(
      profile.languageVersion,
      "Rust"
    )}-bookworm`;
  }
  return `node:${requireSafeVersion(
    profile.nodeVersion,
    "Node"
  )}-bookworm-slim`;
}

async function pullImmutableImage(
  runner: CommandRunner,
  cwd: string,
  image: string,
  timeoutMs: number
): Promise<string> {
  const pull = await runner.run("docker", ["pull", image], {
    cwd,
    timeoutMs,
  });
  if (pull.exitCode !== 0) {
    throw new RuntimePreparationError(
      `Unable to pull runtime stage ${image}: ${trimOutput(
        pull.stderr || pull.stdout
      )}`
    );
  }
  const inspect = await runner.run(
    "docker",
    ["image", "inspect", image, "--format={{.Id}}"],
    { cwd, timeoutMs }
  );
  const imageId = inspect.stdout.trim();
  if (inspect.exitCode !== 0 || !imageId) {
    throw new RuntimePreparationError(
      `Unable to resolve immutable runtime stage ${image}: ${trimOutput(
        inspect.stderr || inspect.stdout
      )}`
    );
  }
  return imageId;
}

async function packageManagerCacheMount(
  cwd: string,
  manager: ToolchainProfile["packageManager"],
  lockfileDigest: string | undefined
): Promise<PreparedRuntime["cacheMount"]> {
  if (!manager || !lockfileDigest) return undefined;
  const hostPath = prtisanRepositoryDataPath(
    cwd,
    "cache",
    "package-managers",
    manager,
    lockfileDigest
  );
  await ensureDir(hostPath);
  return {
    hostPath,
    sandboxPath: packageManagerCachePath(manager),
  };
}

function declaredPackageManager(
  commandValue: string | undefined
): ToolchainProfile["packageManager"] {
  const command = commandValue?.trim();
  if (!command) return undefined;
  return /^(?:corepack\s+)?(pnpm|npm|yarn|bun|uv|go|cargo)(?:\s|$)/.exec(
    command
  )?.[1] as ToolchainProfile["packageManager"];
}

function packageManagerCachePath(
  manager: NonNullable<ToolchainProfile["packageManager"]>
): string {
  return manager === "pnpm"
    ? "/home/agent/.local/share/pnpm/store"
    : manager === "npm"
      ? "/home/agent/.npm"
      : manager === "yarn"
        ? "/home/agent/.cache/yarn"
        : manager === "bun"
          ? "/home/agent/.bun/install/cache"
          : manager === "uv"
            ? "/home/agent/.cache/uv"
            : manager === "go"
              ? "/home/agent/go/pkg/mod"
              : "/home/agent/.cargo/registry";
}

function bootstrapWithCachePath(
  bootstrap: SandboxCommandConfig | undefined,
  manager: ToolchainProfile["packageManager"],
  cachePath: string | undefined
): SandboxCommandConfig | undefined {
  if (
    !bootstrap ||
    manager !== "pnpm" ||
    !cachePath ||
    /(?:^|\s)--store-dir(?:\s|=|$)/.test(bootstrap.command) ||
    /(?:&&|\|\||[;|<>\n`])/.test(bootstrap.command)
  ) {
    return bootstrap;
  }
  return {
    ...bootstrap,
    command: `${bootstrap.command.trim()} --store-dir ${cachePath}`,
  };
}

async function runRuntimeProbes(
  runner: CommandRunner,
  cwd: string,
  runtime: PreparedRuntime,
  deadlineAt: number,
  now: () => number
): Promise<void> {
  for (const probe of runtime.probes) {
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) {
      throw new RuntimePreparationError(
        `Runtime probe deadline expired before ${probe.name}.`
      );
    }
    const startedAt = Date.now();
    const result = await runner.run(
      "docker",
      [
        "run",
        "--rm",
        ...managedDockerRunLabels("runtime-probe", cwd),
        "--user",
        `${runtimeUid()}:${runtimeGid()}`,
        "-e",
        "HOME=/home/agent",
        runtime.imageName,
        "sh",
        "-lc",
        probe.command,
      ],
      { cwd, timeoutMs: Math.min(probe.timeoutMs, remainingMs) }
    );
    if (result.exitCode !== 0) {
      throw new RuntimePreparationError(
        `${probe.name} probe failed after ${Date.now() - startedAt}ms: ${trimOutput(
          result.stderr || result.stdout
        )}`
      );
    }
  }
}

function configWithinDeadline(
  config: AgentTrainConfig,
  deadlineAt: number,
  now: () => number
): AgentTrainConfig {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    throw new RuntimePreparationError(
      "Runtime preparation exhausted the validation wall-time budget."
    );
  }
  return {
    ...config,
    validation: {
      ...config.validation,
      maxWallTimeMs: remainingMs,
    },
  };
}

async function runInRuntime(
  runner: CommandRunner,
  input: {
    readonly cwd: string;
    readonly config: AgentTrainConfig;
    readonly runtime: PreparedRuntime;
  },
  worktreePath: string,
  gitCommonDir: string,
  item: SandboxCommandConfig,
  deadlineAt: number,
  now: () => number
): Promise<VerificationResult["commands"][number]> {
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    return {
      name: item.name,
      command: item.command,
      exitCode: 124,
      durationMs: 0,
      timedOut: true,
      output:
        "Validation wall-time deadline expired before this command started.",
    };
  }
  const args = [
    "run",
    "--rm",
    ...managedDockerRunLabels("verification", input.cwd),
    "--user",
    `${runtimeUid()}:${runtimeGid()}`,
    "-e",
    "HOME=/home/agent",
    "-v",
    `${worktreePath}:/home/agent/workspace`,
    "-v",
    `${gitCommonDir}:${gitCommonDir}:ro`,
  ];
  if (input.runtime.cacheMount) {
    args.push(
      "-v",
      `${input.runtime.cacheMount.hostPath}:${input.runtime.cacheMount.sandboxPath}`
    );
  }
  for (const mount of input.config.docker.mounts) {
    args.push(
      "-v",
      `${resolvePath(input.cwd, mount.hostPath)}:${mount.sandboxPath}${
        mount.readonly ? ":ro" : ""
      }`
    );
  }
  for (const [key, value] of Object.entries(item.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(
    "-w",
    "/home/agent/workspace",
    input.runtime.imageName,
    "sh",
    "-lc",
    item.command
  );

  const startedAt = Date.now();
  const result = await runner.run("docker", args, {
    cwd: input.cwd,
    timeoutMs: Math.min(item.timeoutMs, remainingMs),
  });
  return commandResult(item.name, item.command, result, Date.now() - startedAt);
}

async function resolveGitCommonDirectory(
  runner: CommandRunner,
  cwd: string,
  worktreePath: string
): Promise<string> {
  const result = await runner.run("git", ["rev-parse", "--git-common-dir"], {
    cwd: worktreePath,
  });
  const path = result.stdout.trim();
  return result.exitCode === 0 && path
    ? resolvePath(worktreePath, path)
    : joinPath(cwd, ".git");
}

function commandResult(
  name: string,
  invocation: string,
  result: {
    readonly exitCode: number;
    readonly timedOut?: boolean;
    readonly stdout: string;
    readonly stderr: string;
  },
  durationMs: number
): VerificationResult["commands"][number] {
  return {
    name,
    command: invocation,
    exitCode: result.exitCode,
    durationMs,
    timedOut: result.timedOut ?? false,
    output: redactOutput(
      trimOutput(result.stderr || result.stdout, MAX_VERIFICATION_OUTPUT_CHARS)
    ),
  };
}

function isInfrastructureCommandFailure(
  result: VerificationResult["commands"][number]
): boolean {
  return (
    result.timedOut ||
    result.exitCode === 124 ||
    result.exitCode === 127 ||
    /command not found|no such file or directory|not a git repository|cannot connect to the docker daemon|network is unreachable|temporary failure|could not resolve host/i.test(
      result.output
    )
  );
}

function assertEngineAllowsVersion(
  engine: string | undefined,
  version: string
): void {
  if (!engine) return;
  const exact = exactVersion(engine);
  if (exact && normalizeVersion(exact) !== normalizeVersion(version)) {
    throw new RuntimePreparationError(
      `Pinned Node ${version} conflicts with engines.node ${engine}.`,
      "unsupported"
    );
  }
  if (exact) return;

  const clauses = engine.split("||").map((clause) => clause.trim());
  const proven = clauses.some((clause) =>
    engineClauseAllowsVersion(clause, version)
  );
  if (!proven) {
    throw new RuntimePreparationError(
      `Pinned Node ${version} does not satisfy engines.node ${engine}.`,
      "unsupported"
    );
  }
}

function engineClauseAllowsVersion(clause: string, version: string): boolean {
  const comparators = [...clause.matchAll(/(>=|>|<=|<)\s*v?(\d+\.\d+\.\d+)/g)];
  if (comparators.length > 0) {
    return comparators.every((match) => {
      const comparison = compareVersions(version, match[2] as string);
      if (match[1] === ">=") return comparison >= 0;
      if (match[1] === ">") return comparison > 0;
      if (match[1] === "<=") return comparison <= 0;
      return comparison < 0;
    });
  }

  const compatible = clause.match(/^\^\s*v?(\d+)\.(\d+)\.(\d+)$/);
  if (compatible?.[1]) {
    return (
      version.split(".")[0] === compatible[1] &&
      compareVersions(version, compatible.slice(1).join(".")) >= 0
    );
  }
  const patchRange = clause.match(/^~\s*v?(\d+)\.(\d+)\.(\d+)$/);
  if (patchRange?.[1] && patchRange[2]) {
    const parts = version.split(".");
    return (
      parts[0] === patchRange[1] &&
      parts[1] === patchRange[2] &&
      compareVersions(version, patchRange.slice(1).join(".")) >= 0
    );
  }
  const majorRange = clause.match(/^v?(\d+)(?:\.x)?$/i);
  return Boolean(majorRange?.[1] && version.split(".")[0] === majorRange[1]);
}

function exactVersion(value: string | undefined): string | undefined {
  return value?.trim().match(/^v?(\d+\.\d+\.\d+)$/)?.[1];
}

function normalizeVersion(value: string): string {
  const normalized = value.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new RuntimePreparationError(
      `Expected an exact semantic version, received ${value}.`,
      "unsupported"
    );
  }
  return normalized;
}

function requireSafeVersion(value: string | undefined, label: string): string {
  if (!value || !/^\d+(?:\.\d+){1,2}(?:[-+][a-z0-9.-]+)?$/i.test(value)) {
    throw new RuntimePreparationError(
      `${label} version is missing or unsafe: ${value ?? "(missing)"}.`,
      "unsupported"
    );
  }
  return value;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function redactOutput(value: string): string {
  return redactCredentialValues(value);
}

function trimOutput(value: string, maxChars = 2_000): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(-maxChars);
}

function isVanishedRuntimeImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such image|image .+ not found|not found:|failed to resolve source metadata/i.test(
    message
  );
}

function safeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
}

function runtimeUid(): number {
  return process.getuid?.() ?? 1000;
}

function runtimeGid(): number {
  return process.getgid?.() ?? 1000;
}
