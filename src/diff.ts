export interface DiffLine {
  readonly path: string;
  readonly position: number;
  readonly side: "RIGHT" | "LEFT";
  readonly line: number;
  readonly text: string;
}

export interface ReviewLocation {
  readonly path: string;
  readonly line: number;
  readonly side?: "RIGHT" | "LEFT";
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  const entries: DiffLine[] = [];
  let currentPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentPath = undefined;
      inHunk = false;
      oldLine = 0;
      newLine = 0;
      position = 0;
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentPath = parseDiffPath(line.slice(4));
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      continue;
    }

    if (!currentPath || !inHunk || line.length === 0) {
      continue;
    }

    const prefix = line[0];
    if (prefix === "+") {
      position += 1;
      entries.push({
        path: currentPath,
        position,
        side: "RIGHT",
        line: newLine,
        text: line.slice(1),
      });
      newLine += 1;
    } else if (prefix === "-") {
      position += 1;
      entries.push({
        path: currentPath,
        position,
        side: "LEFT",
        line: oldLine,
        text: line.slice(1),
      });
      oldLine += 1;
    } else if (prefix === " ") {
      position += 1;
      entries.push({
        path: currentPath,
        position,
        side: "RIGHT",
        line: newLine,
        text: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return entries;
}

export function findDiffPosition(
  diffLines: readonly DiffLine[],
  location: ReviewLocation,
): number | undefined {
  const side = location.side ?? "RIGHT";
  return diffLines.find(
    (line) => line.path === location.path && line.line === location.line && line.side === side,
  )?.position;
}

function parseDiffPath(raw: string): string | undefined {
  if (raw === "/dev/null") return undefined;
  return raw.replace(/^"|"$/g, "").replace(/^b\//, "").replace(/^a\//, "");
}
