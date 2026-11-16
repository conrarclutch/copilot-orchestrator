import { mountHtmlArtifact } from "./HtmlArtifact.js";
import { renderMarkdown } from "./Markdown.js";
import { makeHandle, type RenderHandle } from "./handles.js";

export interface ChatAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly url?: string;
  readonly text?: string;
  readonly html?: string;
  readonly sizeBytes?: number;
}

export interface AttachmentOptions {
  /** Resolve an attachment through the host app's authenticated asset route. */
  readonly resolveUrl?: (attachment: ChatAttachment) => string | undefined;
  readonly onOpen?: (attachment: ChatAttachment) => void;
  readonly onOpenLink?: (url: string) => void;
  readonly onDownload?: (attachment: ChatAttachment) => void;
}

const safeDirectUrl = (url: string, dataMime?: string) =>
  /^(?:https?:|blob:)/i.test(url) ||
  (dataMime === "image/" && /^data:image\//i.test(url)) ||
  (dataMime !== undefined && dataMime !== "image/" && new RegExp(`^data:${dataMime}(?:;|,)`, "i").test(url));
const languageForName = (name: string) => name.split(".").pop()?.toLowerCase();

function codeFence(value: string, language: string): string {
  const maxTicks = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, maxTicks + 1));
  const safeLanguage = language.replace(/[^a-z0-9_+#.-]/gi, "") || "text";
  return `${fence}${safeLanguage}\n${value}\n${fence}`;
}

function resolveAttachmentUrl(
  attachment: ChatAttachment,
  options: AttachmentOptions,
  document: Document,
  dataMime?: string,
): string | undefined {
  const source = options.resolveUrl?.(attachment) ?? attachment.url;
  if (source === undefined) return undefined;
  if (safeDirectUrl(source, dataMime)) return source;
  try {
    const resolved = new URL(source, document.baseURI);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function button(document: Document, label: string, handler: (() => void) | undefined) {
  if (handler === undefined) return undefined;
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cor-attachment__action";
  element.textContent = label;
  element.addEventListener("click", handler);
  return element;
}

/** Mount an image, text/code, HTML, PDF, or generic file attachment. */
export function renderAttachment(container: HTMLElement, attachment: ChatAttachment, options: AttachmentOptions = {}): RenderHandle {
  const document = container.ownerDocument;
  const mime = attachment.mimeType.toLowerCase();
  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf" || /\.pdf$/i.test(attachment.name);
  const isHtml = mime === "text/html" || attachment.html !== undefined;
  const url = resolveAttachmentUrl(
    attachment,
    options,
    document,
    isImage ? "image/" : isPdf ? "application/pdf" : isHtml ? "text/html" : undefined,
  );
  if (isHtml && attachment.html !== undefined) {
    return mountHtmlArtifact(container, attachment.html, {
      title: attachment.name,
      ...(options.onOpenLink === undefined ? {} : { onOpenLink: options.onOpenLink }),
    });
  }
  if (isImage && url !== undefined && safeDirectUrl(url, "image/")) {
    const figure = document.createElement("figure");
    figure.className = "cor-attachment cor-attachment--image";
    const image = document.createElement("img");
    image.src = url;
    image.alt = attachment.name;
    image.loading = "lazy";
    figure.appendChild(image);
    const caption = document.createElement("figcaption");
    caption.textContent = attachment.name;
    const open = options.onOpen === undefined ? undefined : button(document, "Open", () => options.onOpen?.(attachment));
    if (open) caption.appendChild(open);
    figure.appendChild(caption);
    container.replaceChildren(figure);
    return makeHandle(() => {
      if (container.contains(figure)) container.replaceChildren();
    });
  }
  if (isHtml && url !== undefined && safeDirectUrl(url, "text/html")) {
    const frame = document.createElement("iframe");
    frame.className = "cor-attachment cor-attachment--html";
    frame.title = attachment.name;
    frame.src = url;
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    container.replaceChildren(frame);
    return makeHandle(() => {
      if (container.contains(frame)) container.replaceChildren();
    });
  }
  if (isPdf && url !== undefined && safeDirectUrl(url, "application/pdf")) {
    const frame = document.createElement("iframe");
    frame.className = "cor-attachment cor-attachment--pdf";
    frame.title = attachment.name;
    frame.src = `${url}#toolbar=0&view=FitH`;
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    container.replaceChildren(frame);
    return makeHandle(() => {
      if (container.contains(frame)) container.replaceChildren();
    });
  }
  if (attachment.text !== undefined || mime.startsWith("text/")) {
    const source = attachment.text ?? "";
    const markdown = codeFence(source, languageForName(attachment.name) ?? "text");
    const body = document.createElement("div");
    body.className = "cor-attachment cor-attachment--text";
    const header = document.createElement("div");
    header.className = "cor-attachment__header";
    header.textContent = attachment.name;
    const download = options.onDownload === undefined ? undefined : button(document, "Download", () => options.onDownload?.(attachment));
    if (download) header.appendChild(download);
    const content = document.createElement("div");
    body.appendChild(header);
    body.appendChild(content);
    container.replaceChildren(body);
    const rendered = renderMarkdown(content, markdown);
    return makeHandle(() => {
      rendered.cleanup();
      if (container.contains(body)) container.replaceChildren();
    }, rendered.ready);
  }
  const fallback = document.createElement("div");
  fallback.className = "cor-attachment cor-attachment--file";
  fallback.textContent = attachment.name;
  if (attachment.sizeBytes !== undefined) {
    const size = document.createElement("small");
    size.textContent = ` (${attachment.sizeBytes.toLocaleString()} bytes)`;
    fallback.appendChild(size);
  }
  const download = options.onDownload === undefined ? undefined : button(document, "Download", () => options.onDownload?.(attachment));
  if (download) fallback.appendChild(download);
  container.replaceChildren(fallback);
  return makeHandle(() => {
    if (container.contains(fallback)) container.replaceChildren();
  });
}
