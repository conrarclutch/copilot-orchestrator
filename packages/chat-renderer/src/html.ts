import {
  clampHtmlRenderHeight,
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
  htmlRenderThemeMessage,
  type HtmlRenderFonts,
  type HtmlRenderTheme,
} from "./upstream/htmlRender.js";
import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
} from "./upstream/themePalettes.js";

/** Theme chosen for a self-contained HTML artifact. */
export type HtmlAppearance = ThemeAppearance;

export interface PrepareHtmlDocumentOptions {
  readonly appearance?: HtmlAppearance;
  readonly fonts?: HtmlRenderFonts;
}

const PREPARED_MARKER = "data-copilot-orchestrator-html-render";
const APPEARANCE_MARKER = "data-copilot-orchestrator-appearance";

function appearanceTheme(appearance: HtmlAppearance, fonts?: HtmlRenderFonts): HtmlRenderTheme {
  return htmlRenderTheme(
    appearance === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS,
    appearance,
    fonts,
  );
}

function appearanceScript(theme: HtmlRenderTheme): string {
  const payload = JSON.stringify(htmlRenderThemeMessage(theme)).replace(/</g, "\\u003c");
  return `<script ${APPEARANCE_MARKER}="${theme.appearance}">window.dispatchEvent(new MessageEvent("message",{data:${payload}}));</script>`;
}

function addToHead(html: string, markup: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}

function addAfterT3Bootstrap(html: string, markup: string): string {
  const themeStyle = /<style\b[^>]*\bid=["']t3-theme["'][^>]*>[\s\S]*?<\/style>/i.exec(html);
  if (!themeStyle) return addToHead(html, markup);
  const afterTheme = themeStyle.index + themeStyle[0].length;
  const bootstrap = /<script\b[^>]*>[\s\S]*?<\/script>/i.exec(html.slice(afterTheme));
  const at = bootstrap ? afterTheme + bootstrap.index + bootstrap[0].length : afterTheme;
  return html.slice(0, at) + markup + html.slice(at);
}

/**
 * Prepares agent-authored HTML for a sandboxed srcDoc iframe. This is not a sanitizer.
 *
 * T3's original bootstrap is retained: it supplies theme variables before the
 * page paints, reports content height through postMessage, and turns external
 * links into user-activated host requests. An explicit appearance initializes the same theme style synchronously,
 * preserving later host theme updates. This is useful for srcDoc where
 * there is no URL fragment to carry the initial theme.
 */
export function prepareHtmlDocument(
  html: string,
  options: PrepareHtmlDocumentOptions = {},
): string {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new TypeError("HTML document must be a non-empty string.");
  }
  const appearance = options.appearance;
  const prepared = html.includes(PREPARED_MARKER) || /<style\b[^>]*\bid=["']t3-theme["']/i.test(html)
    ? html
    : addToHead(injectHtmlRenderBootstrap(html), `<!--${PREPARED_MARKER}-->`);
  if (appearance === undefined) return prepared;
  if (prepared.includes(`${APPEARANCE_MARKER}="${appearance}"`)) return prepared;
  const withoutOldAppearance = prepared.replace(/<script\b[^>]*data-copilot-orchestrator-appearance=["'][^"']*["'][^>]*>[\s\S]*?<\/script>/gi, "");
  return addAfterT3Bootstrap(withoutOldAppearance, appearanceScript(appearanceTheme(appearance, options.fonts)));
}

/** Re-export the shared sizing and host-message helpers used by embedders. */
export {
  clampHtmlRenderHeight,
  htmlRenderFrameHeight,
  htmlRenderFileName,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderReference,
  type HtmlRenderTheme,
  type HtmlRenderFonts,
} from "./upstream/htmlRender.js";
