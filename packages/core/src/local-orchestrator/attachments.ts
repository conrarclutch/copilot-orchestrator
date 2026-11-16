// @effect-diagnostics nodeBuiltinImport:off
import { constants as NodeFSConstants } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";

import {
  attachmentFileExtension,
  createPendingAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { inferImageExtension } from "../imageMime.ts";

/**
 * A small, local-only import boundary for the headless orchestrator.
 *
 * Callers provide a path they already have access to. The source is only
 * read; the returned attachment always points at a fresh copy in the
 * orchestrator's private attachments directory. Keeping this boundary here
 * means the SDK adapter never has to accept arbitrary user paths.
 */
export interface ImportAttachmentInput {
  readonly path: string;
  readonly name?: string;
  readonly mimeType?: string;
}

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,98}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,98}$/i;

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function importError(message: string, cause?: unknown): Error {
  const suffix = cause instanceof Error && cause.message.length > 0 ? `: ${cause.message}` : "";
  return new Error(`Unable to import attachment${message.length > 0 ? ` (${message})` : ""}${suffix}`);
}

function metadataName(input: ImportAttachmentInput, sourcePath: string): string {
  const rawName = (input.name?.trim() || NodePath.basename(sourcePath)).trim();
  // Names are metadata, not paths. Strip any accidental directory prefix so
  // callers cannot smuggle a path into persisted chat state.
  const name = rawName.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (name.length === 0 || name === "." || name === ".." || name.includes("\0")) {
    throw importError("attachment name is empty or invalid");
  }
  if (name.length > 255) {
    throw importError("attachment name exceeds 255 characters");
  }
  return name;
}

function normalizedMimeType(input: ImportAttachmentInput, name: string): string {
  const explicit = input.mimeType?.trim().toLowerCase();
  if (explicit !== undefined) {
    if (!MIME_TYPE_PATTERN.test(explicit)) {
      throw importError("mimeType is invalid");
    }
    return explicit;
  }
  return MIME_TYPE_BY_EXTENSION[NodePath.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Copies a local file into the isolated attachments directory and returns the
 * durable metadata object used by T3's message contracts.
 *
 * The returned id is a pending id by design. Existing claim/restore code can
 * later rename it to a thread-owned id, while `resolveAttachmentPathById`
 * continues to resolve the copied bytes by id only.
 */
export async function importAttachment(
  attachmentsDir: string,
  input: ImportAttachmentInput,
): Promise<ChatAttachment> {
  const source = input.path.trim();
  if (source.length === 0 || source.includes("\0")) {
    throw importError("source path is empty or invalid");
  }
  const sourcePath = NodePath.resolve(source);
  let sourceStat: Awaited<ReturnType<typeof NodeFS.stat>>;
  try {
    sourceStat = await NodeFS.stat(sourcePath);
  } catch (cause) {
    throw importError("source file could not be read", cause);
  }
  if (!sourceStat.isFile()) {
    throw importError("source path is not a regular file");
  }

  const name = metadataName(input, sourcePath);
  const mimeType = normalizedMimeType(input, name);
  const isImage = mimeType.startsWith("image/");
  const maxBytes = isImage ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(sourceStat.size) || sourceStat.size > maxBytes) {
    throw importError(
      isImage
        ? `image exceeds ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES} byte limit`
        : `file exceeds ${PROVIDER_SEND_TURN_MAX_FILE_BYTES} byte limit`,
    );
  }

  const extension = isImage
    ? inferImageExtension({ mimeType, fileName: name })
    : attachmentFileExtension(name);
  const id = createPendingAttachmentId(extension);
  const attachment: ChatAttachment = isImage
    ? { type: "image", id, name, mimeType, sizeBytes: sourceStat.size }
    : { type: "file", id, name, mimeType, sizeBytes: Math.max(1, sourceStat.size) };
  const targetPath = resolveAttachmentPath({ attachmentsDir, attachment });
  if (targetPath === null) {
    throw importError("failed to resolve isolated destination");
  }

  let copied = false;
  try {
    await NodeFS.mkdir(NodePath.resolve(attachmentsDir), { recursive: true });
    await NodeFS.copyFile(sourcePath, targetPath, NodeFSConstants.COPYFILE_EXCL);
    copied = true;

    // Re-stat the copy so a source that changes during the copy cannot make
    // the persisted metadata claim a size that the SDK will later reject.
    const copiedStat = await NodeFS.stat(targetPath);
    if (!copiedStat.isFile() || !Number.isSafeInteger(copiedStat.size) || copiedStat.size > maxBytes) {
      throw importError("copied file exceeds the attachment limit");
    }
    if (copiedStat.size < 1) {
      throw importError("empty files are not valid provider attachments");
    }

    const resolvedPath = resolveAttachmentPathById({ attachmentsDir, attachmentId: id });
    if (resolvedPath === null || NodePath.resolve(resolvedPath) !== NodePath.resolve(targetPath)) {
      throw importError("copied file could not be resolved by attachment id");
    }
    return { ...attachment, sizeBytes: copiedStat.size } as ChatAttachment;
  } catch (cause) {
    if (copied) {
      await NodeFS.unlink(targetPath).catch(() => undefined);
    }
    if (cause instanceof Error && cause.message.startsWith("Unable to import attachment")) {
      throw cause;
    }
    throw importError("source could not be copied into isolated state", cause);
  }
}
