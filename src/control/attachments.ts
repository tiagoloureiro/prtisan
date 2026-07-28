import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { ensureDir } from "@/fs.js";
import { joinPath } from "@/path.js";
import { prtisanPaths } from "@/prtisan-paths.js";

import type { ConversationAttachment } from "./types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export async function captureAttachments(
  paths: readonly string[]
): Promise<ConversationAttachment[]> {
  const captured: ConversationAttachment[] = [];
  for (const sourcePath of paths) {
    const source = await realpath(sourcePath);
    const details = await stat(source);
    if (!details.isFile()) {
      throw new Error(`Conversation attachment is not a file: ${sourcePath}.`);
    }
    const bytes = await readFile(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const extension = extname(source).toLowerCase();
    const directory = joinPath(prtisanPaths().attachments, digest.slice(0, 2));
    const target = joinPath(
      directory,
      `${digest}-${randomUUID().slice(0, 8)}${extension}`
    );
    await ensureDir(directory);
    await copyFile(source, target);
    const kind = IMAGE_EXTENSIONS.has(extension) ? "image" : "file";
    captured.push({
      kind,
      name: basename(source),
      path: target,
      digest,
      ...(kind === "image" ? { mediaType: imageMediaType(extension) } : {}),
    });
  }
  return captured;
}

function imageMediaType(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return `image/${extension.slice(1)}`;
}
