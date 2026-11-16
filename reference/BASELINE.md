# Public source baseline

The source-backed portion of this project is pinned to the public [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) repository at:

```text
17c0878941ab8ab19108fb639c5138d92a89e919
```

`packages/core/.extract-manifest.json` records relative upstream paths and normalized source hashes. Run `scripts/verify-upstream.mjs <path-to-t3code-checkout>` against that public commit to verify the records. The verification tool is optional for runtime and does not require a private checkout or a T3 data directory.

## Published boundary

The runnable source is under `packages/core/src/`, with contracts in `packages/contracts/src/` and shared utilities in `packages/shared/src/`. The local composition adds the Copilot SDK adapter, CLI/NDJSON host, local Git workflow, MCP configuration boundary, attachment import boundary, and explicit disabled boundaries for application services outside the local manager.

The extraction preserves T3's management assertions. Compatibility changes are limited to provider test fixtures, local composition wiring, the Copilot SDK adapter, the local transport and integration boundaries, and platform-specific path expectations. They do not replace command receipts, event replay, delegation, completion delivery, recovery, or runtime-request semantics with an in-memory task graph.

The `packages/chat-renderer` package is a separate browser-facing integration surface. It contains the T3 rendering protocol plus framework-independent adapters for HTML artifacts, Markdown, code, images, and attachments.

## License and notices

T3 is MIT licensed, Copyright (c) 2026 T3 Tools Inc. The repository retains the original notice in [LICENSE](../LICENSE) and documents the copied source in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). No source credentials, ignored environment files, live T3 database, or logged-in session data are runtime dependencies of this project.
