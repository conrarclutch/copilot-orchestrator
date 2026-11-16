# Copilot Orchestrator contribution rules

This repository is a local, headless agent-management host for GitHub Copilot. The goal is to preserve T3 Code's durable management behavior while keeping the product usable from an existing application.

## Product contract

- Keep the host local. GitHub inference is expected, but this project does not add remote workers, SSH management, relay, tunnels, cloud workers, pairing, mobile control, or multi-environment features.
- Preserve durable management semantics: hierarchy, asynchronous and blocking delegation, follow-ups, steering, cancellation cascades, completion delivery, retry-safe commands, recovery, persistent approvals, worktree isolation, and paged history/status.
- Keep the event store, receipts, projections, and effect outbox until equivalent parity scenarios prove a replacement safe.
- Keep a warm Copilot SDK client, reuse sessions, coalesce streamed deltas, page history, cap concurrency, and bound context transfer. Measure host overhead separately from model latency.
- Do not call the project feature-complete or at parity until the gates in `docs/PARITY.md` pass.

## Layout

- `packages/core/src/`: extracted T3 management services plus the local Copilot SDK composition, adapter, and CLI.
- `packages/contracts/` and `packages/shared/`: source-backed T3 contracts and utilities required by the core.
- `packages/chat-renderer/`: framework-independent browser JavaScript for an existing chat app. Keep it free of React, Effect, T3 server, and Copilot SDK dependencies. Preserve iframe isolation and message-source checks; the host owns storage, authentication, and asset URLs.
- `test-support/`: provider capability fixtures and protocol helpers used to test the provider-independent management code.
- `bin/copilot-orchestrator.mjs`: executable entry point; `scripts/build.mjs` produces the bundled CLI module.
- `examples/python_bridge/`: a Python/aiohttp integration adapter. It keeps Node as the Copilot session/turn owner and leaves application connectors and frontend policy in the host app.

## Source and provenance

The source-backed baseline is the public [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at commit `17c0878941ab8ab19108fb639c5138d92a89e919`. `scripts/verify-upstream.mjs` verifies the manifest against a checkout of that public commit. Do not add private forks, local machine paths, raw traces, credentials, or live application data to the repository.

Keep ignored research/reference directories and generated local state out of commits. A cloned repository must not need another checkout or a live T3 data directory at runtime.

## Workflow

Preserve the original T3 tests. Disable services at wiring boundaries before deleting implementations. Keep SDK integration behind `ProviderAdapter`; do not rewrite the orchestration state machine and provider adapter in one change. Changes to orchestration, persistence, MCP, recovery, provider sessions, or SDK event mapping must update the relevant parity gate and verification note.
