export function redactCredentialValues(value: string): string {
  return value
    .replace(
      /\b(?:ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9_-]{12,})\b/g,
      "[REDACTED]"
    )
    .replace(
      /\b([A-Z0-9_]*(?:AUTHORIZATION|TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*\S+/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /\b(Authorization)\s*:\s*(?:Bearer|Basic)\s+\S+/gi,
      "$1: [REDACTED]"
    );
}

export function redactLocalPaths(value: string): string {
  return value
    .replace(/\/home\/[^/\s]+\/[^\s"'`)<>\]]+/g, "[local workspace path]")
    .replace(/\/(?:private\/)?tmp\/[^\s"'`)<>\]]+/g, "[temporary path]")
    .replace(
      /\b[A-Za-z]:\\Users\\[^\\\s]+\\[^\s"'`)<>\]]+/g,
      "[local workspace path]"
    );
}

export function sanitizeForGitHub(value: string): string {
  return redactLocalPaths(redactCredentialValues(value));
}
