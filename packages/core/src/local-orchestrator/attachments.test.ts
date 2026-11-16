import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { importAttachment } from "./attachments.ts";

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(NodePath.join(tmpdir(), "copilot-orchestrator-attachments-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("local attachment import", () => {
  it("copies a local file into isolated state and resolves it by id", async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = NodePath.join(directory, "evidence.txt");
      const attachmentsDir = NodePath.join(directory, "state", "attachments");
      await writeFile(sourcePath, "read-only evidence", "utf8");

      const attachment = await importAttachment(attachmentsDir, {
        path: sourcePath,
        mimeType: "text/plain",
      });

      expect(attachment).toMatchObject({
        type: "file",
        name: "evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 18,
      });
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: attachment.id,
      });
      expect(resolved).not.toBeNull();
      expect(await readFile(resolved!, "utf8")).toBe("read-only evidence");
      expect(await readFile(sourcePath, "utf8")).toBe("read-only evidence");
    });
  });

  it("classifies images and rejects traversal-like source metadata", async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = NodePath.join(directory, "capture.png");
      await writeFile(sourcePath, Buffer.from([1, 2, 3]));

      const attachment = await importAttachment(NodePath.join(directory, "attachments"), {
        path: sourcePath,
        name: "nested\\capture.png",
        mimeType: "image/png",
      });
      expect(attachment.type).toBe("image");
      expect(attachment.name).toBe("capture.png");
      expect(attachment.id).toMatch(/^pending-[0-9a-f-]+-png$/);

      await expect(
        importAttachment(NodePath.join(directory, "attachments"), {
          path: sourcePath,
          name: "..",
          mimeType: "image/png",
        }),
      ).rejects.toThrow("attachment name is empty or invalid");
    });
  });

  it("rejects unsupported mime metadata and directories", async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = NodePath.join(directory, "evidence.bin");
      await writeFile(sourcePath, Buffer.from([1]));
      await expect(
        importAttachment(NodePath.join(directory, "attachments"), {
          path: sourcePath,
          mimeType: "not-a-mime",
        }),
      ).rejects.toThrow("mimeType is invalid");
      await expect(
        importAttachment(NodePath.join(directory, "attachments"), {
          path: directory,
        }),
      ).rejects.toThrow("source path is not a regular file");
    });
  });
});
