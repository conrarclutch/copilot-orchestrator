import { prepareHtmlDocument } from "../html.js";
import {
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderResult,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "../upstream/htmlRender.js";
import { makeHandle, type RenderHandle } from "./handles.js";

export interface HtmlArtifactOptions {
  readonly title?: string;
  readonly appearance?: "dark" | "light";
  readonly height?: number;
  readonly maxHeight?: number;
  /** The host decides how to open a user-activated external link. */
  readonly onOpenLink?: (url: string) => void;
  readonly className?: string;
}

const clampHeight = (height: number, max: number) =>
  Math.max(HTML_RENDER_MIN_HEIGHT, Math.min(max, Math.round(Number.isFinite(height) ? height : HTML_RENDER_MIN_HEIGHT)));

/** Mount a self-contained interactive HTML artifact in an opaque-origin iframe. */
export function mountHtmlArtifact(
  container: HTMLElement,
  html: string,
  options: HtmlArtifactOptions = {},
): RenderHandle {
  const document = container.ownerDocument;
  const iframe = document.createElement("iframe");
  const maxHeight = clampHeight(options.maxHeight ?? HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MAX_HEIGHT);
  const initialHeight = clampHeight(options.height ?? HTML_RENDER_MIN_HEIGHT, maxHeight);
  iframe.title = options.title ?? "HTML artifact";
  iframe.className = ["cor-html-artifact", options.className].filter(Boolean).join(" ");
  iframe.setAttribute("sandbox", "allow-scripts allow-forms");
  iframe.style.display = "block";
  iframe.style.width = "100%";
  iframe.style.height = `${initialHeight}px`;
  iframe.style.maxHeight = `${maxHeight}px`;
  iframe.style.border = "0";
  iframe.srcdoc = prepareHtmlDocument(html, { appearance: options.appearance ?? "dark" });
  container.replaceChildren(iframe);

  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== iframe.contentWindow) return;
    const measured = readHtmlRenderContentHeight(event.data);
    if (measured !== undefined) {
      const nextHeight = Math.max(HTML_RENDER_MIN_HEIGHT, Math.min(maxHeight, Math.round(measured)));
      iframe.style.height = `${nextHeight}px`;
      return;
    }
    const link = readHtmlRenderLinkRequest(event.data);
    if (link === undefined || options.onOpenLink === undefined) return;
    const view = document.defaultView;
    if (document.activeElement !== iframe) return;
    if (view?.navigator.userActivation?.isActive === false) return;
    options.onOpenLink(link.url);
    iframe.contentWindow?.postMessage(htmlRenderResult(link.id), "*");
  };
  document.defaultView?.addEventListener("message", onMessage);

  return makeHandle(() => {
    document.defaultView?.removeEventListener("message", onMessage);
    if (container.contains(iframe)) container.replaceChildren();
  });
}
