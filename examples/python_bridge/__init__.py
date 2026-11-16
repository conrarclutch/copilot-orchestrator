"""Python integration helpers for the local Copilot orchestrator.

The bridge is intentionally transport-focused.  It does not replace a host
application's Python investigation tools; it keeps a local Node orchestrator
warm and exposes its line-delimited JSON API to Python code.
"""

from .client import (
    BridgeClosedError,
    BridgeEOFError,
    BridgeError,
    BridgeProtocolError,
    OrchestratorClient,
    OrchestratorRequestError,
)

__all__ = [
    "BridgeClosedError",
    "BridgeEOFError",
    "BridgeError",
    "BridgeProtocolError",
    "OrchestratorClient",
    "OrchestratorRequestError",
]
