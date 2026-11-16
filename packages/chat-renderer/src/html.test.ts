import { describe, expect, it } from "vitest";
import { JSDOM } from 'jsdom';

import { prepareHtmlDocument } from "./html.js";
import {
  createHtmlArtifact,
  HTML_ARTIFACT_MAX_BYTES,
  readHtmlArtifact,
} from "./artifacts.js";
import { htmlRenderThemeMessage, htmlRenderTheme } from './html.js';
import { T3_CODE_LIGHT_THEME_COLORS } from './upstream/themePalettes.js';

describe("portable HTML artifacts", () => {
  it('sets an explicit theme before the page script and accepts later host updates', () => {
    const document = prepareHtmlDocument('<body><script>window.firstTheme=document.getElementById("t3-theme").textContent</script></body>', {appearance:'dark'});
    const dom = new JSDOM(document, {runScripts:'dangerously'});
    try {
      expect(dom.window.firstTheme).toContain('color-scheme:dark');
      expect(dom.window.firstTheme).not.toContain('prefers-color-scheme');
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', {data:htmlRenderThemeMessage(htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS,'light'))}));
      expect(dom.window.document.getElementById('t3-theme')!.textContent).toContain('color-scheme:light');
    } finally {dom.window.close();}
  });
  it("uses T3's bootstrap before page styles and scripts", () => {
    const html = prepareHtmlDocument("<!doctype html><html><head><title>x</title></head><body><script>window.ok=1</script></body></html>", { appearance: "dark" });
    expect(html.indexOf("data-copilot-orchestrator-html-render")).toBeGreaterThan(-1);
    expect(html.indexOf('id="t3-theme"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-copilot-orchestrator-appearance="dark"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-copilot-orchestrator-html-render')).toBeLessThan(html.indexOf("<title>"));
    expect(html.indexOf('data-copilot-orchestrator-appearance="dark"')).toBeGreaterThan(
      html.indexOf('</style>'),
    );
  });

  it("is idempotent when preparation is repeated", () => {
    const once = prepareHtmlDocument("<main>chart</main>", { appearance: "light" });
    const twice = prepareHtmlDocument(once, { appearance: "light" });
    expect(twice).toBe(once);
    expect((twice.match(/id="t3-theme"/g) ?? []).length).toBe(1);
  });

  it("creates and validates bounded artifact payloads", () => {
    const artifact = createHtmlArtifact("<p>hello</p>", { id: "a1", title: "Chart", height: 12 });
    expect(artifact).toMatchObject({ kind: "html", id: "a1", title: "Chart", height: 80 });
    expect(readHtmlArtifact(artifact)).toEqual(artifact);
    expect(readHtmlArtifact({ ...artifact, height: Number.NaN })).toBeUndefined();
  });

  it("rejects overlarge documents", () => {
    expect(() => createHtmlArtifact("x".repeat(HTML_ARTIFACT_MAX_BYTES))).toThrow(/maximum/);
  });
});
