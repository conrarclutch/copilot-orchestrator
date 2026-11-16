import { clampHtmlRenderHeight } from "./html.js";
import { prepareHtmlDocument, type HtmlAppearance } from "./html.js";

export const HTML_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
export const HTML_ARTIFACT_DEFAULT_HEIGHT = 480;

export interface HtmlArtifact {
  readonly kind: "html";
  readonly id: string;
  readonly title: string;
  readonly html: string;
  readonly height: number;
}

export interface CreateHtmlArtifactOptions {
  readonly id?: string;
  readonly title?: string;
  readonly height?: number;
  readonly appearance?: HtmlAppearance;
}

function newArtifactId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoApi?.randomUUID?.() ?? `html-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cleanTitle(value: string | undefined): string {
  const title = value?.trim().slice(0, 200);
  return title || "HTML";
}

/** Build a transport-friendly HTML artifact for a chat timeline. */
export function createHtmlArtifact(
  html: string,
  options: CreateHtmlArtifactOptions = {},
): HtmlArtifact {
  if (options.height !== undefined && !Number.isFinite(options.height)) {
    throw new TypeError('Artifact height must be finite.');
  }
  const prepared = prepareHtmlDocument(
    html,
    options.appearance === undefined ? {} : { appearance: options.appearance },
  );
  const size = byteLength(prepared);
  if (size > HTML_ARTIFACT_MAX_BYTES) {
    throw new RangeError(
      `HTML artifact is ${size} bytes; the maximum is ${HTML_ARTIFACT_MAX_BYTES} bytes.`,
    );
  }
  return {
    kind: "html",
    id: options.id?.trim() || newArtifactId(),
    title: cleanTitle(options.title),
    html: prepared,
    height: clampHtmlRenderHeight(options.height ?? HTML_ARTIFACT_DEFAULT_HEIGHT),
  };
}

/** Validate an unknown tool/event payload before handing it to a renderer. */
export function readHtmlArtifact(value: unknown): HtmlArtifact | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "html" ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.title !== "string" ||
    typeof candidate.html !== "string" ||
    candidate.html.length === 0 ||
    typeof candidate.height !== "number" ||
    !Number.isFinite(candidate.height) ||
    byteLength(candidate.html) > HTML_ARTIFACT_MAX_BYTES
  ) {
    return undefined;
  }
  return {
    kind: "html",
    id: candidate.id,
    title: cleanTitle(candidate.title),
    html: candidate.html,
    height: clampHtmlRenderHeight(candidate.height),
  };
}
