// Copy into your app and adjust this URL to its static route.
import {renderMarkdown, mountHtmlArtifact, renderAttachment}
  from '/static/vendor/chat-renderer/browser.js';

/** Render your own persisted message shape; wire this into your WebSocket handler. */
export function renderChatMessage(container, message, options = {}) {
  const document = container.ownerDocument;
  const body = document.createElement('div');
  const handles = [];
  const part = () => {
    const slot = document.createElement('div');
    body.append(slot);
    return slot;
  };
  container.replaceChildren(body);
  if (message.markdown) handles.push(renderMarkdown(part(), message.markdown, {
    resolveAssetUrl: options.resolveAssetUrl,
  }));
  for (const artifact of message.artifacts ?? []) {
    if (artifact.kind === 'html') handles.push(mountHtmlArtifact(part(), artifact.html, {
      title: artifact.title, height: artifact.height,
      appearance: options.appearance ?? 'dark', onOpenLink: options.onOpenLink,
    }));
  }
  for (const file of message.attachments ?? []) {
    handles.push(renderAttachment(part(), file, options.attachments));
  }
  return {
    ready: Promise.all(handles.map(handle => handle.ready)),
    cleanup() {
      for (const handle of handles) handle.cleanup();
      body.remove();
    },
  };
}
