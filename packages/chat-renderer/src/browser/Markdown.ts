import { makeHandle, type RenderHandle } from "./handles.js";

export interface MarkdownOptions {
  /** Resolve attachment IDs or relative paths using the embedding app. */
  readonly resolveAssetUrl?: (source: string) => string | undefined;
  readonly className?: string;
}

type HastNode = {
  readonly type: string;
  readonly value?: string;
  readonly tagName?: string;
  readonly properties?: Record<string, unknown>;
  readonly children?: ReadonlyArray<HastNode>;
};

const safeImageSource = (source: string) => /^(?:https?:|blob:|data:image\/)/i.test(source);

function appendHast(parent: Node, node: HastNode, document: Document): void {
  if (node.type === "text") {
    parent.appendChild(document.createTextNode(node.value ?? ""));
    return;
  }
  if (node.type !== "element" || node.tagName === undefined) {
    for (const child of node.children ?? []) appendHast(parent, child, document);
    return;
  }
  const element = document.createElement(node.tagName);
  const className = node.properties?.className;
  if (Array.isArray(className)) element.className = className.join(" ");
  else if (typeof className === "string") element.className = className;
  for (const child of node.children ?? []) appendHast(element, child, document);
  parent.appendChild(element);
}

async function highlightBlocks(container: HTMLElement, document: Document): Promise<void> {
  const blocks = [...container.querySelectorAll<HTMLElement>("pre > code")];
  if (blocks.length === 0) return;
  const { highlightCode } = await import('./highlighter.js');
  for (const block of blocks) {
    const language = [...block.classList].find((name) => name.startsWith("language-"))?.slice(9);
    if (!language) continue;
    try {
      const tree = highlightCode(language, block.textContent ?? "") as unknown as HastNode;
      const replacement = document.createDocumentFragment();
      for (const child of tree.children ?? []) appendHast(replacement, child, document);
      block.replaceChildren(replacement);
      block.dataset.corHighlighted = "true";
    } catch {
      // Unknown languages remain as safe, escaped plain text.
    }
  }
}

function configureImagesAndLinks(container: HTMLElement, options: MarkdownOptions) {
  for (const image of [...container.querySelectorAll<HTMLImageElement>("img")]) {
    const source = image.getAttribute("src");
    const resolved = source === null ? undefined : resolveImageSource(source, options, container.ownerDocument);
    if (resolved === undefined) image.remove();
    else {
      image.src = resolved;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
    }
  }
  for (const link of [...container.querySelectorAll<HTMLAnchorElement>("a[href]")]) {
    const href = link.getAttribute("href");
    if (href === null || !/^(?:https?:|mailto:)/i.test(href)) link.removeAttribute("href");
    else {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
}

function resolveImageSource(source: string, options: MarkdownOptions, document: Document): string | undefined {
  const hostResolved = options.resolveAssetUrl?.(source);
  if (hostResolved !== undefined) {
    if (safeImageSource(hostResolved)) return hostResolved;
    try {
      const resolved = new URL(hostResolved, document.baseURI);
      return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
    } catch {
      return undefined;
    }
  }
  if (safeImageSource(source)) return source;
  if (!/^(?:\/|\.\.?\/)/.test(source)) return undefined;
  try {
    const resolved = new URL(source, document.baseURI);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

/** Parse and mount GFM Markdown. Raw HTML is sanitized; executable documents use mountHtmlArtifact. */
export function renderMarkdown(container: HTMLElement, markdown: string, options: MarkdownOptions = {}): RenderHandle {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = ["cor-markdown", options.className].filter(Boolean).join(" ");
  container.replaceChildren(root);
  let active = true;
  const ready = (async () => {
    const [{ marked }, domPurifyModule] = await Promise.all([import("marked"), import("dompurify")]);
    if (!active) return;
    const view = document.defaultView;
    if (view === null) throw new Error("Markdown rendering requires a browser document.");
    const factory = (domPurifyModule.default ?? domPurifyModule) as unknown as (window: Window) => { sanitize: (value: string, config?: unknown) => string };
    const purifier = factory(view);
    const raw = await marked.parse(markdown, { gfm: true, breaks: true });
    const clean = purifier.sanitize(raw, { USE_PROFILES: { html: true }, ADD_ATTR: ["target", "rel"] });
    if (!active) return;
    const template = document.createElement("template");
    template.innerHTML = clean;
    root.replaceChildren(template.content.cloneNode(true));
    configureImagesAndLinks(root, options);
    await highlightBlocks(root, document);
  })().catch(() => {
    if (active) root.textContent = markdown;
  });
  return makeHandle(() => {
    active = false;
    if (container.contains(root)) container.replaceChildren();
  }, ready);
}
