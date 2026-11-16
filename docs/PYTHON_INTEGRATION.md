# Python and aiohttp integration

Use the Python bridge when the application already owns its backend, authentication, tool connectors, and frontend. The bridge keeps one local Node `serve` process warm and multiplexes its NDJSON API over asyncio:

```text
existing Python app -> OrchestratorClient -> stdin/stdout NDJSON -> Node serve
       |                                                        |
       +-- existing API connectors and frontend                  +-- Copilot SDK sessions and turns
```

Node owns Copilot sessions, turns, approvals, event cursors, and durable orchestration state. Keep existing Python Splunk, Tanium, Proofpoint, or other connector clients in Python when they are already working. Do not run the same conversation through both the Python Copilot SDK and this Node host; they cannot share a session.

## Start the host

Build the CLI once, then keep one process alive for the lifetime of the Python service:

```sh
npm ci
npm run build
node bin/copilot-orchestrator.mjs serve \
  --cwd /path/to/workspace \
  --data-dir /path/to/local/state \
  --events \
  --mcp-config /path/to/mcp.json
```

`--events-after <sequence>` replays stored events after a persisted cursor and then follows new events. The host accepts one JSON request per stdin line and writes one matching response per stdout line; logs stay on stderr.

## Python client

`examples/python_bridge/client.py` uses Python 3.11+ standard-library APIs. `aiohttp` is needed only for the optional route adapter.

```python
from examples.python_bridge.client import OrchestratorClient


async def start_turn(orchestrator: OrchestratorClient, workspace, attachment_path):
    # Reuse the application-lifetime client installed during startup.
    project = await orchestrator.request("project.create", {
        "title": "Investigation workspace",
        "workspaceRoot": str(workspace),
    })
    project_id = project.get("project", project)["id"]
    attachment = await orchestrator.request("attachment.import", {
        "path": str(attachment_path),
    })
    return await orchestrator.request("thread.create", {
        "projectId": project_id,
        "title": "Review evidence",
        "prompt": "Read the attachment and summarize it.",
        "attachments": [attachment],
        "runtimeMode": "approval-required",
    })
```

Handle permission/question events through your existing UI and answer with `runtime.respond`. Use `thread.wait` or the event stream to observe completion; keep the shared client alive throughout.

The persistent API defaults `thread.create` to `approval-required`. Use `runtimeMode: "full-access"` only when the host has deliberately authorized it. The one-shot CLI `run` command is the convenience path that uses `full-access`.

To stop work, send `thread.cancel`; a timeout or cancellation of the Python `request()` wait does not cancel the turn inside Node. Use stable `clientRequestId` values when retrying mutations.

## Attachments and events

`attachment.import` accepts a local file path that the host already has permission to read. Node copies it into the orchestrator's isolated attachment state and returns metadata; pass that object to `thread.create` or `thread.send`. Do not log source paths, attachment contents, credentials, or provider responses.

Persist the highest `sequence` returned to the application. `last_event_sequence` is the safe cursor; `observed_event_sequence` is diagnostic only. If the bounded queue reports `events.dropped`, or the host emits `events.resyncRequired`, re-read `thread.read` or `thread.status` before updating the UI and then resume from the persisted cursor.

## MCP connector boundary

The MCP file is host-owned. It may configure local stdio servers or loopback HTTP/SSE servers; the loader rejects non-loopback network URLs and embedded URL credentials. Example:

```json
{
  "mcpServers": {
    "work-tools": {
      "type": "stdio",
      "command": "python",
      "args": ["mcp_probe.py"],
      "workingDirectory": ".",
      "tools": ["integration_probe"]
    }
  }
}
```

Copy [the example MCP server](../examples/mcp_probe.py) or replace it with a narrowly scoped server that wraps existing Python connector functions. The orchestrator does not bundle Splunk, Tanium, Proofpoint, browser automation, or native Windows computer-use tools. Those remain host/MCP integrations and should enforce their own authentication, authorization, tenant scope, and audit policy.

Protect the MCP configuration because stdio environment values may contain secrets. Keep connector credentials in the existing application secret store, not in chat messages, event payloads, or access logs.

## aiohttp routes

`examples/python_bridge/aiohttp_example.py` registers only two integration routes and an application cleanup context. It requires an explicit `authorize` callback; there is no allow-all default:

```python
async def authorize_orchestrator(request):
    return await existing_authorizer(request, capability="copilot_orchestrator")


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

- `POST /api/orchestrator/request` forwards an existing JSON API request after authorization;
- `GET /ws/orchestrator/events` forwards the bounded event stream after authorization.

It does not create a server, login flow, frontend, or standalone chat app. Put the existing authentication middleware in front of these routes and make the callback consult the host application's authenticated principal and ACL. The browser-facing route has an explicit allowlist and rejects path-bearing operations such as `project.create`, `worktree.create`, and `attachment.import`; trusted server-side code can call the framework-independent client directly after validating paths. The example permits one active event websocket and returns HTTP 409 to a second subscriber. For multiple browser clients, fan out from one application-owned event task with a bounded queue per subscriber. See the more detailed [Python bridge README](../examples/python_bridge/README.md).

## Tests

Run the bridge unit and aiohttp adapter tests without Copilot credentials:

```sh
python -m unittest -v examples.python_bridge.test_client examples.python_bridge.test_aiohttp_example
```

The optional live integration requires authenticated Copilot access:

```sh
python scripts/python-integration-live.py --run-live
```
