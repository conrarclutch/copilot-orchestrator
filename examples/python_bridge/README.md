# Python bridge

This is an integration adapter for an existing Python API/backend and browser
frontend. It is not a second chat application. The adapter keeps one local
Node `copilot-orchestrator serve` process warm and multiplexes its NDJSON API
over asyncio:

```text
existing Python app -> OrchestratorClient -> stdin/stdout NDJSON -> Node serve
       |                                                        |
       +-- existing Splunk/Tanium/Proofpoint APIs                +-- Copilot SDK
       +-- existing auth, routes, HTML and websocket policy
```

The Node process owns Copilot sessions and turns. A Python Copilot SDK client
is still a valid alternative architecture, but it is a separate engine; this
bridge does not attempt to resume or share a session between the Python SDK
and the Node SDK.

## Client-only use

The client uses Python 3.11+ standard-library APIs. `aiohttp` is not needed
unless the optional route example is used.

```python
from examples.python_bridge.client import OrchestratorClient


async def list_projects(workspace: str):
    async with OrchestratorClient(
        cwd=workspace,
        data_dir=".local/copilot-orchestrator",
        model="auto",
        # Optional local MCP config. The Node CLI validates this file and
        # starts only its configured stdio/loopback-HTTP servers.
        mcp_config=".local/mcp.json",
        events=True,
    ) as orchestrator:
        return await orchestrator.request("project.list")
```

The default Node entry point is resolved as `bin/copilot-orchestrator.mjs`
relative to this repository, so the Python app does not need to run from the
repository root. Use `node_path` and `bin_path` when packaging Node under a
known absolute path. Reuse one `OrchestratorClient` for the lifetime of the
Python process; starting one child per HTTP request defeats the warm-runtime
latency benefit.

`request()` accepts every method in [`docs/API.md`](../../docs/API.md), so the
Python app can keep its own tool calls unchanged and use the bridge only for
projects, threads, turns, permissions, delegation, worktrees, and attachments.
Timeouts and caller cancellation stop waiting in Python but do not cancel work
inside the orchestrator. To stop a turn, send the protocol's
`thread.cancel` request explicitly.

## Event stream and recovery

Pass the last persisted event sequence at startup:

```python
client = OrchestratorClient(
    cwd=workspace,
    events=True,
    events_after=last_saved_sequence,
    event_queue_size=256,
)
```

The Node server emits domain-event fields, including `sequence`, in
`event.params`. `client.last_event_sequence` is the last event returned to the
application (a safe persisted cursor); `client.observed_event_sequence` is
diagnostic only. Event sequences are monotonic but may have legitimate gaps
because other streams share the application log. If the bounded queue
overflows, `next_event()` first returns a marker like:

```json
{
  "type": "events.dropped",
  "dropped": 3,
  "resyncRequired": true,
  "resyncAfterSequence": 42,
  "lastEventSequence": 45
}
```

Do not silently continue an in-memory UI after that marker. Re-read
authoritative state with `thread.read`/`thread.status`, persist the returned
cursor, and then resume event consumption. The marker is deliberately visible
to websocket consumers. A slow browser can therefore cause a resync rather
than unbounded Python memory growth.

An optional `event_callback` runs behind its own bounded callback queue. A slow
callback cannot block response matching; callback drops are counted by
`dropped_callbacks`. Prefer `iter_events()` for one event consumer and keep
the callback lightweight.

## aiohttp integration

`aiohttp_example.py` adds only integration routes and an application cleanup
context. It does not create a server, frontend, login flow, or standalone chat
UI. Keep the existing authentication middleware on these paths and provide an
explicit authorization callback. There is no allow-all default:

```python
from aiohttp import web

from examples.python_bridge.aiohttp_example import install_orchestrator
from examples.python_bridge.client import OrchestratorClient

async def authorize_orchestrator(request):
    # Delegate to the host app's already-authenticated principal/ACL check.
    # Return False (or raise) for an unauthorized browser/session.
    return await existing_authorizer(request, capability="copilot_orchestrator")

app = web.Application(middlewares=[existing_auth_middleware])
install_orchestrator(
    app,
    authorize=authorize_orchestrator,
    client_factory=lambda: OrchestratorClient(
        cwd=workspace,
        data_dir=".local/copilot-orchestrator",
        mcp_config=".local/mcp.json",
        events=True,
        events_after=load_last_sequence(),
    ),
)
```

Routes owned by the example are:

* `POST /api/orchestrator/request`: body `{ "id": "ui-1", "method": "thread.status", "params": {...} }`; the mandatory authorization callback runs before parsing or dispatching it.
* `GET /ws/orchestrator/events`: forwards `{ "method": "event", "params": ... }` envelopes.

Change the paths to match the existing application. The browser RPC boundary
allows read/turn/delegation/runtime-response methods needed by the chat app. It
deliberately rejects `project.create`, `worktree.create`, and
`attachment.import`; it also rejects `thread.create` when a browser supplies a
`worktreePath`. Those operations can choose local filesystem paths and belong
in server-side code that validates the target. Use the framework-independent
client directly for that trusted path.

The example permits one active event websocket and returns HTTP 409 to a
second subscriber. This keeps the shared bounded queue's ownership explicit.
If the host app needs multiple browser subscribers, create one application-
owned `iter_events()` pump and give each subscriber its own bounded queue;
do not have multiple route handlers consume the client's queue directly.

The response adapter intentionally returns generic bridge errors and does not
echo request parameters or provider error payloads. Credentials and tenant
data should remain in the existing Python connector configuration and should
never be written to access logs, `stderr_tail`, or chat history. Protect the
MCP config file itself because stdio command environments may contain secrets.

## Local MCP configuration

`mcp_config` is passed as `--mcp-config` to the Node serve command. The file
belongs to the host application and should contain only the local stdio and
loopback-HTTP MCP servers that the orchestrator is allowed to start. The
bridge does not proxy or duplicate the existing Python Splunk, Tanium, or
Proofpoint API clients. Keep those connectors in Python when they are already
working; expose a narrowly scoped MCP server only when a Copilot turn needs to
invoke one through the orchestrator's tool boundary.

## Tests

The tests launch a temporary fake child with `sys.executable`; they do not
start Node, call a real tenant, or use credentials:

```powershell
python -m unittest -v examples.python_bridge.test_client
```

They cover request multiplexing, structured errors, timeout/cancellation,
EOF, malformed output, bounded stderr, queue drops, resync markers,
non-contiguous valid cursors, and shutdown of pending waiters.
