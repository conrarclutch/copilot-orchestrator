# Copilot Orchestrator

A local, headless extraction of T3 Code's durable agent-management core, powered by the GitHub Copilot SDK. It runs through a CLI and a persistent stdin/stdout NDJSON API. Copilot inference uses GitHub; the manager does not start a network listener or remote worker.

The durable event log, command receipts, projections, effect outbox, delegation state machine, completion delivery, recovery, cancellation, and checkpoints are retained. The local composition and Copilot SDK adapter provide the host boundary for an existing application.

## Run

Requires Node **24.13.1 or newer**, Git, and an authenticated GitHub account with Copilot access. The SDK installs its matching local runtime through npm.

```sh
git clone https://github.com/conrarclutch/copilot-orchestrator.git
cd copilot-orchestrator
npm ci
npm run build
node bin/copilot-orchestrator.mjs doctor
node bin/copilot-orchestrator.mjs models
node bin/copilot-orchestrator.mjs run "Explain this repository" --cwd /path/to/repository --model auto
```

`run` is a one-shot convenience command and uses `full-access` runtime policy. The persistent API defaults new threads to `approval-required`; select `runtimeMode: "full-access"` explicitly when that is appropriate for the host application.

To keep a persistent host alive for a chat application:

```sh
node bin/copilot-orchestrator.mjs serve \
  --cwd /path/to/repository \
  --data-dir /path/to/local/state \
  --events \
  --mcp-config /path/to/mcp.json
```

Send one JSON request per line: `{ "id": 1, "method": "project.list", "params": {} }`. Responses contain the same `id` and either `result` or `error`. With `--events`, domain events arrive as `{ "method": "event", "params": ... }`. Use `--events-after <sequence>` to replay events after a persisted cursor and continue following new events. Logs go to stderr; EOF shuts down the host.

## Integrate

For an existing chat app, the independent [chat-renderer package](packages/chat-renderer/README.md) provides interactive HTML/JavaScript artifacts, Markdown, highlighted code, images, and attachment previews. It builds to browser JavaScript and CSS that can be served by Python/aiohttp; React and the T3 interface are not required. See [the Python integration guide](docs/PYTHON_INTEGRATION.md) and [the renderer example](examples/embed-chat-message.js).

The Python bridge keeps one warm Node process for Copilot sessions and turns. Your existing Python connectors, authentication, routes, frontend, and websocket policy remain yours. Local, narrowly scoped connector tools can be exposed through the host-owned [`--mcp-config`](examples/mcp.config.example.json) boundary.

The API includes projects, threads, paged history, steering, cancellation, worktrees, approvals, structured questions, child-task controls, and `attachment.import`. The SDK's `delegate_task`, `task_status`, `task_cancel`, `t3_thread_send`, `t3_thread_read`, `t3_thread_wait`, and `orchestrator_capabilities` tools call those same durable services. Native Copilot task/fleet fan-out is disabled so children remain visible to the manager.

## Validate

```sh
npm test
npm run check
npm run build
python -m unittest -v examples.python_bridge.test_client examples.python_bridge.test_aiohttp_example
```

See [verification](docs/VERIFICATION.md) for the recorded automated counts, historical lifecycle checks, and current Python bridge integration evidence. See [parity](docs/PARITY.md) for the remaining qualification gates.

Graphical clients, remote access, cloud/device/preview integrations, PR integrations, application scheduling, and secret-card UI services are outside this local composition. Browser automation and native Windows computer use are external host/MCP capabilities, not built-in services. SDK-native conversation fork and rollback are not advertised; filesystem checkpoint/diff/restore services remain in the core but are not currently dedicated NDJSON methods.

## Source and license

The source-backed baseline is the public [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at commit `17c0878941ab8ab19108fb639c5138d92a89e919`. [The baseline note](reference/BASELINE.md) records the extraction boundary, and `scripts/verify-upstream.mjs` verifies source records against that public commit. The project preserves T3 Code's MIT copyright and third-party notices; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
