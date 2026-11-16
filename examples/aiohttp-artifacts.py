"""JSON payload helpers for an existing aiohttp/Copilot Python chat app.

No server is started here. Persist these payloads with messages and deliver
them over your existing authenticated REST/WebSocket transport.
"""
from __future__ import annotations

import math
import uuid

MAX_HTML_BYTES = 25 * 1024 * 1024


def html_artifact(html: str, title: str = "HTML", height: int = 480) -> dict:
    """Return an artifact that the JavaScript mountHtmlArtifact helper accepts."""
    if not isinstance(html, str) or not html.strip():
        raise ValueError("HTML must be a non-empty string")
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise ValueError("HTML exceeds the 25 MiB artifact limit")
    if not isinstance(height, (int, float)) or not math.isfinite(height):
        raise ValueError("height must be finite")
    return {
        "kind": "html",
        "id": str(uuid.uuid4()),
        "title": title.strip()[:200] or "HTML",
        "html": html,
        "height": max(80, min(2000, int(height))),
    }


def attachment(attachment_id: str, name: str, mime_type: str, url: str) -> dict:
    """Use your own authenticated asset route; never send raw filesystem paths."""
    return {"id": attachment_id, "name": name, "mimeType": mime_type, "url": url}


# In your Python Copilot tool handler:
#   artifact = html_artifact(arguments["html"], arguments.get("title", "Chart"))
#   await your_message_store.save_artifact(thread_id, artifact)
#   await your_websocket.send_json({"type": "artifact", "artifact": artifact})
#   return {"artifact": artifact}
# The storage and WebSocket methods above belong to your existing app.
