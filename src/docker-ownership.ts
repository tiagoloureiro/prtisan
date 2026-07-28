import { createHash } from "node:crypto";

export const PRTISAN_MANAGED_DOCKER_LABEL = "io.prtisan.managed=true";

export function prtisanProjectKey(cwd: string): string {
  return `project-${createHash("sha256").update(cwd).digest("hex").slice(0, 20)}`;
}

export function managedDockerBuildLabels(kind: string, cwd?: string): string[] {
  return [
    "--label",
    PRTISAN_MANAGED_DOCKER_LABEL,
    "--label",
    `io.prtisan.resource-kind=${kind}`,
    ...(cwd ? ["--label", `io.prtisan.project=${prtisanProjectKey(cwd)}`] : []),
  ];
}

export function managedDockerRunLabels(kind: string, cwd?: string): string[] {
  return managedDockerBuildLabels(kind, cwd);
}
