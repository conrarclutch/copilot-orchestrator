import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { renderAttachment } from "./Attachment.js";
import { mountHtmlArtifact } from "./HtmlArtifact.js";
import { renderMarkdown } from "./Markdown.js";

function dom() {
  return new JSDOM("<!doctype html><html><body></body></html>");
}

describe("browser chat renderer", () => {
  it("sanitizes markdown, resolves images, and highlights fenced code", async () => {
    const instance = dom();
    const container = instance.window.document.createElement("div");
    instance.window.document.body.appendChild(container);
    const handle = renderMarkdown(container, [
      "# Hello",
      "",
      "```js",
      "const answer = 42",
      "```",
      "",
      "<script>window.pwned = true</script>",
      "![image](/asset/one)",
    ].join("\n"), { resolveAssetUrl: (source) => `https://assets.example.test${source}` });
    await handle.ready;
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Hello");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://assets.example.test/asset/one");
    expect(container.querySelector("code")?.dataset.corHighlighted).toBe("true");
    handle.cleanup();
    expect(container.childElementCount).toBe(0);
  });

  it("mounts interactive HTML in an opaque sandbox and does not erase replacement content", () => {
    const instance = dom();
    const container = instance.window.document.createElement("div");
    instance.window.document.body.appendChild(container);
    const handle = mountHtmlArtifact(container, "<body><button>Run</button></body>", { title: "Chart" });
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(iframe?.srcdoc).toContain("data-copilot-orchestrator-html-render");
    const replacement = instance.window.document.createElement("p");
    replacement.textContent = "new message";
    container.replaceChildren(replacement);
    handle.cleanup();
    expect(container.firstElementChild).toBe(replacement);
  });

  it("only forwards HTML links while the iframe is the active element", () => {
    const instance = dom();
    const container = instance.window.document.createElement("div");
    instance.window.document.body.appendChild(container);
    const opened: string[] = [];
    const handle = mountHtmlArtifact(container, "<body>link</body>", { onOpenLink: (url) => opened.push(url) });
    const iframe = container.querySelector("iframe")!;
    const message = { jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url: "https://example.com" } };
    instance.window.dispatchEvent(new instance.window.MessageEvent("message", { data: message, source: iframe.contentWindow }));
    expect(opened).toHaveLength(0);
    iframe.focus();
    instance.window.dispatchEvent(new instance.window.MessageEvent("message", { data: message, source: iframe.contentWindow }));
    expect(opened).toEqual(["https://example.com"]);
    handle.cleanup();
  });

  it("keeps attachment header/actions while rendering text content", async () => {
    const instance = dom();
    const container = instance.window.document.createElement("div");
    instance.window.document.body.appendChild(container);
    let downloaded = false;
    const handle = renderAttachment(container, {
      id: "file-1",
      name: "answer.js",
      mimeType: "text/javascript",
      text: "const answer = 42;",
    }, { onDownload: () => { downloaded = true; } });
    await handle.ready;
    expect(container.textContent).toContain("answer.js");
    expect(container.textContent).toContain("const answer = 42;");
    container.querySelector("button")?.dispatchEvent(new instance.window.Event("click"));
    expect(downloaded).toBe(true);
    handle.cleanup();
  });

  it("does not let backticks in text attachments break the fenced preview", async () => {
    const instance = dom();
    const container = instance.window.document.createElement("div");
    instance.window.document.body.appendChild(container);
    const handle = renderAttachment(container, {
      id: "file-2",
      name: "notes.txt",
      mimeType: "text/plain",
      text: "before ``` after",
    });
    await handle.ready;
    expect(container.textContent).toContain("before ``` after");
    handle.cleanup();
  });

  it("sandboxes PDF previews to prevent mislabeled HTML from running in the host", () => {
    const instance = dom();
    const container = instance.window.document.createElement("div");
    instance.window.document.body.appendChild(container);
    const handle = renderAttachment(container, {
      id: "file-3",
      name: "report.pdf",
      mimeType: "application/pdf",
      url: "https://assets.example.test/report.pdf",
    });
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    handle.cleanup();
  });
});
