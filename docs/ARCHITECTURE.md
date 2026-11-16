# Architecture

This repository is a local, headless extraction of T3 Code's durable agent-management core. GitHub Copilot is the provider; the local composition replaces the multi-provider and remote-capable application shell with a small host that an existing CLI, Python service, or chat frontend can call.

## Runtime shape

```text
bin/copilot-orchestrator.mjs
        |
  local-orchestrator/cli.ts     NDJSON CLI and one-shot runner
        |
  local-orchestrator/composition.ts
        |-- T3 orchestration-v2, persistence, MCP services, checkpoints
        |-- one warm CopilotClient and resident CopilotSession map
        `-- local Git/worktree and SQLite state
```

The extracted implementation lives in `packages/core/src/`. `composition.ts` wires the local Effect layers, `sdk-adapter.ts` maps Copilot SDK sessions to T3's provider adapter, and `tools.ts` exposes managed delegation tools to the active Copilot session. `packages/contracts` and `packages/shared` contain the source-backed contracts and utilities used by the core.

The source of truth remains T3's durable event log and projections. Command receipts make mutations retry-safe, the effect outbox separates replayable work from process-bound work, and recovery rebuilds projections after a restart. Threads, runs, child tasks, runtime requests, completion delivery, and checkpoints therefore remain managed records rather than transient SDK transcript state.

## Copilot connection

The host starts one local stdio `CopilotClient` for its lifetime and keeps live `CopilotSession` objects by provider session ID. A thread is resumed lazily after a process restart. SDK events are translated into the provider events expected by T3's orchestration services; terminal state is taken from the session idle lifecycle rather than an intermediate assistant event.

The adapter supplies permission and structured-question callbacks, forwards enqueue/steering and abort requests, and restores policy when a session is resumed. Copilot's built-in task, fleet, and scheduling fan-out is disabled so every child is represented in T3's parent/child tree. The host's delegation, thread, and runtime-request tools call the same durable services used by the local API.

The SDK adapter advertises native conversation fork and rollback as unsupported. T3 filesystem checkpoint, diff, and restore services remain in the core, but they are not currently exposed as dedicated methods in the public NDJSON API. An embedding host that needs them must add an explicit adapter. A capability is enabled only after it has been exercised through the real runtime and recovery path.

## Local boundaries

The process binds no network listener. `serve` uses stdin/stdout and sends logs to stderr. GitHub inference still uses the Copilot service, but the manager does not create a remote worker, relay, tunnel, device session, or cloud environment. Other T3 providers, graphical clients, PR/preview integrations, application scheduling, and secret-card UI services are outside this composition and are disabled at the wiring boundary.

MCP configuration is host-owned. Stdio servers and loopback HTTP/SSE servers may be supplied with `--mcp-config`; non-loopback network endpoints and embedded credentials are rejected by the local config loader. This lets an existing Python connector remain the system of record while exposing only selected, local tools to Copilot. Browser automation and native Windows computer use are external host/MCP capabilities, not built-in orchestrator services.

Child work can use an isolated local Git worktree. Runtime and interaction policies are inherited by managed descendants and can be narrowed. SQLite state, attachment copies, and Copilot session state are placed under the configured local data directory, separate from any other application's data.

## Efficiency choices

- Reuse one warm SDK client; do not start a runtime per turn or child.
- Resume sessions lazily and cache the model catalog.
- Keep list/status views in compact projections instead of replaying the full SDK transcript.
- Coalesce streamed events at the management boundary and persist lifecycle/terminal records durably.
- Drain managed child work from domain events rather than polling each child.
- Keep the one-shot runner and persistent NDJSON host on the same composition so they exercise identical management behavior.

The implementation preserves management behavior first. Latency and memory should be benchmarked against the same local scenarios before making a performance claim; GitHub inference time must be reported separately from host overhead.

## Provenance

The source-backed T3 code is pinned to public commit `17c0878941ab8ab19108fb639c5138d92a89e919` in [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code), under T3's MIT license. The extraction boundary and compatibility changes are recorded in [the baseline note](../reference/BASELINE.md). No T3 checkout is used at runtime.
