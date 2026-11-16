"""Small aiohttp integration for an existing Python application.

This module adds two routes to an app that already owns its authentication,
HTML, APIs, and websocket policy:

* ``POST /api/orchestrator/request`` forwards one existing NDJSON API method.
* ``GET /ws/orchestrator/events`` forwards the client's bounded event stream.

It intentionally does not create a server, chat UI, login flow, or tool
connector.  Put the app's existing auth middleware in front of these routes.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
import inspect
from typing import Any, Union

from .client import BridgeClosedError, OrchestratorClient, OrchestratorRequestError


AuthorizationCallback = Callable[[Any], Union[bool, Awaitable[bool]]]

# This route is intended for an existing authenticated browser application,
# not as a generic proxy for every local-control method. In particular,
# project.create, worktree.create, and attachment.import are deliberately not
# browser-callable: their path fields could otherwise turn a browser request
# into arbitrary local filesystem access. Server-side code can still call the
# framework-independent OrchestratorClient directly after validating paths.
BROWSER_RPC_ALLOWLIST = frozenset(
    {
        "project.list",
        "project.get",
        "thread.create",
        "thread.list",
        "thread.status",
        "thread.send",
        "thread.wait",
        "thread.read",
        "thread.cancel",
        "runtime.respond",
        "orchestrator.capabilities",
        "task.delegate",
        "task.status",
        "task.cancel",
    }
)


def browser_rpc_allowed(method: str, params: Mapping[str, Any] | None = None) -> bool:
    """Return whether a browser-facing RPC may cross the aiohttp boundary.

    ``thread.create`` is allowed for existing projects but cannot receive a
    caller-supplied worktree path. ``project.create``, ``worktree.create``, and
    ``attachment.import`` stay server-side so the browser cannot choose local
    paths. This helper is pure to make the boundary easy to test without
    installing aiohttp.
    """

    if method not in BROWSER_RPC_ALLOWLIST:
        return False
    if method == "thread.create" and params and "worktreePath" in params:
        return False
    return True


def install_orchestrator(
    app: Any,
    *,
    client: OrchestratorClient | None = None,
    client_factory: Callable[[], OrchestratorClient] | None = None,
    authorize: AuthorizationCallback | None = None,
    request_path: str = "/api/orchestrator/request",
    events_path: str = "/ws/orchestrator/events",
) -> None:
    """Register lifecycle management and two integration-only routes.

    ``aiohttp`` is imported lazily so the framework-independent client remains
    usable in a stdlib-only Python service.  ``authorize`` is mandatory and is
    called for every RPC and websocket request; it should consult the host
    application's already-authenticated principal and return a boolean (or an
    awaitable boolean). Exactly one of ``client`` and ``client_factory`` may be
    supplied. A factory is useful when application configuration is loaded
    during startup; it must return an :class:`OrchestratorClient` without
    starting another process itself.
    """

    if authorize is None:
        raise ValueError("authorize callback is required for orchestrator routes")
    if client is not None and client_factory is not None:
        raise ValueError("pass client or client_factory, not both")

    try:
        from aiohttp import web
    except ModuleNotFoundError as exc:  # pragma: no cover - exercised by importers without aiohttp
        raise RuntimeError("aiohttp is required for install_orchestrator; install the optional example dependency") from exc

    client_key = f"{__name__}.client"
    websocket_lock = asyncio.Lock()
    active_websocket: Any | None = None

    async def is_authorized(request: Any) -> bool:
        try:
            decision = authorize(request)
            if inspect.isawaitable(decision):
                decision = await decision
            return bool(decision)
        except Exception:
            # Authorization is fail-closed. The callback owns logging policy;
            # this adapter never logs request data or callback exceptions.
            return False

    async def cleanup_context(application: Any):
        active = client if client is not None else (client_factory() if client_factory is not None else OrchestratorClient())
        if not isinstance(active, OrchestratorClient):
            raise TypeError("client_factory must return OrchestratorClient")
        await active.start()
        application[client_key] = active
        try:
            yield
        finally:
            await active.close()
            application.pop(client_key, None)

    def get_client(request: Any) -> OrchestratorClient:
        active = request.app.get(client_key)
        if not isinstance(active, OrchestratorClient):
            raise RuntimeError("orchestrator client is not running")
        return active

    async def request_handler(request: Any) -> Any:
        if not await is_authorized(request):
            return web.json_response(
                {"error": {"type": "forbidden", "message": "orchestrator access is not authorized"}},
                status=403,
            )
        try:
            payload = await request.json()
        except (ValueError, TypeError):
            return web.json_response({"error": {"type": "invalid_json", "message": "request body must be JSON"}}, status=400)
        if not isinstance(payload, Mapping) or not isinstance(payload.get("method"), str):
            return web.json_response(
                {"id": payload.get("id") if isinstance(payload, Mapping) else None, "error": {"type": "invalid_request", "message": "method is required"}},
                status=400,
            )
        params = payload.get("params", {})
        if not isinstance(params, Mapping):
            return web.json_response(
                {"id": payload.get("id"), "error": {"type": "invalid_request", "message": "params must be an object"}},
                status=400,
            )
        if not browser_rpc_allowed(payload["method"], params):
            return web.json_response(
                {"id": payload.get("id"), "error": {"type": "rpc_not_allowed", "message": "method is not available to browser clients"}},
                status=403,
            )
        timeout = payload.get("timeout")
        if timeout is not None and (not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0):
            return web.json_response(
                {"id": payload.get("id"), "error": {"type": "invalid_request", "message": "timeout must be positive"}},
                status=400,
            )

        try:
            result = await get_client(request).request(payload["method"], params, timeout=timeout)
        except asyncio.TimeoutError:
            return web.json_response(
                {"id": payload.get("id"), "error": {"type": "timeout", "message": "orchestrator request timed out"}},
                status=504,
            )
        except OrchestratorRequestError:
            # The structured provider error may contain investigation content;
            # do not put it into an application access log or response by default.
            return web.json_response(
                {"id": payload.get("id"), "error": {"type": "orchestrator_error", "message": "orchestrator rejected the request"}},
                status=502,
            )
        except BridgeClosedError:
            return web.json_response(
                {"id": payload.get("id"), "error": {"type": "bridge_closed", "message": "orchestrator bridge is unavailable"}},
                status=503,
            )
        return web.json_response({"id": payload.get("id"), "result": result})

    async def events_handler(request: Any) -> Any:
        if not await is_authorized(request):
            raise web.HTTPForbidden(text="orchestrator access is not authorized")

        nonlocal active_websocket
        websocket = web.WebSocketResponse(heartbeat=30)
        async with websocket_lock:
            if active_websocket is not None and not active_websocket.closed:
                raise web.HTTPConflict(text="only one orchestrator event websocket is supported")
            active_websocket = websocket
        try:
            await websocket.prepare(request)
            async for event in get_client(request).iter_events():
                if websocket.closed:
                    break
                # The client reader never awaits this socket write.  A slow
                # browser can build backpressure here without blocking NDJSON
                # response matching; the client's bounded queue is the memory
                # boundary and emits an explicit resync marker on overflow.
                await websocket.send_json({"method": "event", "params": event})
        except (BridgeClosedError, ConnectionResetError, RuntimeError):
            pass
        finally:
            async with websocket_lock:
                if active_websocket is websocket:
                    active_websocket = None
            if not websocket.closed:
                await websocket.close()
        return websocket

    app.cleanup_ctx.append(cleanup_context)
    app.router.add_post(request_path, request_handler)
    app.router.add_get(events_path, events_handler)


__all__ = ["AuthorizationCallback", "BROWSER_RPC_ALLOWLIST", "browser_rpc_allowed", "install_orchestrator"]
