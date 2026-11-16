# Embeddable chat renderer

Plain JavaScript rendering for an existing chat application. No React, T3 server, orchestrator process or chat shell is required. The HTML theme, sizing and link protocol are extracted from T3; the DOM/Markdown/attachment adapters are new.

Included: sandboxed interactive HTML/JavaScript charts and widgets, GFM Markdown, highlighted code, images and attachment previews. Mermaid, diffs and T3's interface are outside this package.

## Python/aiohttp app

From the repository root:

```sh
npm ci
npm run build --workspace @copilot-orchestrator/chat-renderer
```

Copy the **entire** `packages/chat-renderer/dist` directory into your app's static assets, for example `static/vendor/chat-renderer`. Keep the hashed JavaScript chunks beside the entry points: Markdown and code highlighting load on demand. Serve these files with your existing aiohttp static route. Node/npm are only needed to build these assets; your running Python app does not need Node.

```html
<link rel="stylesheet" href="/static/vendor/chat-renderer/styles.css">
<div id="message"></div>
<script type="module">
  import {renderMarkdown, mountHtmlArtifact, renderAttachment}
    from '/static/vendor/chat-renderer/browser.js';

  const slot = document.querySelector('#message');
  const view = renderMarkdown(slot, '**Hello** from your existing chat app.');
  await view.ready;
  // Call view.cleanup() when removing or replacing this message.
</script>
```

Use a separate container for each message part. Every rendering function replaces its container's contents and returns `{ready, cleanup}`. Call `cleanup()` before rerendering a slot, removing a message, or navigating away.

```js
// artifact is JSON received over your existing WebSocket.
const view = mountHtmlArtifact(slot, artifact.html, {
  title: artifact.title,
  height: artifact.height,
  appearance: 'dark',
  onOpenLink: url => window.open(url, '_blank', 'noopener,noreferrer'),
});
```

The iframe permits scripts and forms but keeps an opaque origin. Do not add `allow-same-origin`. HTML documents may load external resources; this is isolation from the host app, not a network sandbox. For self-contained/offline visuals, inline the chart library and use data URLs for images. Your app's CSP must permit the iframe bootstrap and the resources you choose to load.

## Message and attachment contracts

An HTML artifact is a JSON object:

```json
{"kind":"html","id":"chart-1","title":"Chart","html":"<button onclick=\"this.textContent='Clicked'\">Try me</button>","height":480}
```

Python can construct this directly; the browser prepares the theme and sizing bootstrap. See `examples/aiohttp-artifacts.py` in the repository for validation helpers and a Python Copilot-tool handler integration sketch. Store artifacts alongside your messages and send them through your existing authenticated transport. This package does not register tools or alter your Copilot engine automatically.

For Markdown attachment images, pass `resolveAssetUrl(source)` to map IDs or local references to your app's asset URLs. Do not expose raw filesystem paths. For attachments:

```js
const view = renderAttachment(slot, {
  id: 'a1', name: 'sample.py', mimeType: 'text/plain',
  text: 'print("hello")',
}, {
  resolveUrl: file => `/api/attachments/${encodeURIComponent(file.id)}`,
  onOpen: file => openYourExistingFilePanel(file),
  onDownload: file => downloadUsingYourExistingAPI(file),
});
await view.ready;
```

Attachment fields are `id`, `name`, `mimeType`, optional `url`, `text`, `html`, and `sizeBytes`. Supply inline `text` for text/code previews and `html` for interactive HTML previews. The host owns authenticated fetching; the renderer does not read files or fetch text attachments automatically. Images use asset URLs. PDF support depends on the browser's sandboxed viewer; unsupported files retain a download/open fallback through your callbacks.

Markdown is sanitized with DOMPurify. Executable HTML goes through `mountHtmlArtifact`, separately from Markdown. Syntax highlighting loads only for fenced code; unknown languages remain plain text. Renderer styles use `cor-` classes and `--cor-*` CSS variables so your app can override them.

## Other consumers

The package root exports framework-independent `createHtmlArtifact`, `readHtmlArtifact`, `prepareHtmlDocument`, and T3's theme/sizing helpers. `./browser` exports the DOM renderers. `./styles.css` supplies optional styles.

```sh
npm pack --workspace @copilot-orchestrator/chat-renderer
```

The generated tarball can be installed into another JavaScript project. It contains compiled JavaScript, TypeScript declarations, CSS and the MIT license; it does not depend on T3 contracts, Effect, React or the Copilot SDK.
