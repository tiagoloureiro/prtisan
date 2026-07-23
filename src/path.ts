export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+/g, "/");
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

export function joinPath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return ".";

  const startsAbsolute = isAbsolutePath(filtered[0] ?? "");
  const joined = normalizePath(filtered.join("/"));
  const withoutTrailing = joined.length > 1 ? joined.replace(/\/+$/g, "") : joined;
  return startsAbsolute && !withoutTrailing.startsWith("/")
    ? `/${withoutTrailing}`
    : withoutTrailing;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function resolvePath(cwd: string, path: string): string {
  return isAbsolutePath(path) ? normalizePath(path) : joinPath(cwd, path);
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug.length > 0 ? slug : "issue";
}
