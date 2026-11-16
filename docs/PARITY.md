# T3 management parity

The target is parity with T3's management behavior for a local Copilot provider. This does not mean shipping T3's remote, mobile, graphical, or multi-provider product. The extracted core retains the state machine and its assertions; the local composition removes unrelated application wiring.

## Behaviors retained

- retry-safe command IDs and durable command receipts;
- parent/run/node hierarchy, nested delegation, and inherited policies that may only be narrowed;
- blocking and asynchronous delegation, bounded waits, and completion wake policies;
- sibling completion acceptance, acknowledgement, and disposal with safe re-offer after interrupted delivery;
- cancellation across child follow-ups and grandchildren, with published terminal results remaining final;
- durable event log, projections, effect outbox, and restart recovery;
- root continuation and accurate child status after a process restart;
- queued and steering follow-ups with stable message IDs and at-least-once delivery;
- persisted permission and structured-input requests, including answers routed to the owning session;
- local worktrees, checkpoints, diffs, and restore;
- paged history, status, event delivery, and managed tool injection;
- no invisible Copilot task/fleet fan-out outside the managed tree.

## Current gates

### P0 - public source and local boundary: passed

The source boundary is pinned to public `pingdotgg/t3code` commit `17c0878941ab8ab19108fb639c5138d92a89e919` and is recorded in [BASELINE.md](../reference/BASELINE.md). The runnable workspace is `packages/core`; remote/device/cloud/other-provider wiring is not a runtime dependency.

### P1 - automated management and bridge suites: passed

The full automated run passed 301 TypeScript tests with 1 skipped test across 26 files, plus 14 Python tests. These suites cover the extracted orchestration, persistence, MCP, checkpoint, recovery, provider-session, renderer, local composition, SDK-adapter, NDJSON bridge, attachment, and aiohttp assertions.

### P2 - live lifecycle evidence: mixed current and historical

A fresh compiled Node/Python integration passed: Copilot read a marker from an imported attachment, called a local Python MCP tool configured through `--mcp-config`, 66 ordered events were captured, and a shutdown/restart replay matched the exact next event sequence with the completed thread persisted. Earlier historical smoke checks also exercised managed children, nested delegation, restart reads, retry idempotency, worktree binding, structured questions, approvals, and cancellation; those records are evidence of prior runs, not a substitute for repeating a release check.

### P3 - broader management qualification: pending

The retained T3 algorithms are not an exhaustive equivalence proof. Live abrupt-process recovery with active children and pending approvals, a normalized side-by-side management differential against T3, and comparative host-overhead benchmarks remain qualification work. Native SDK conversation fork/rollback are unsupported.

Graphical clients, remote transports, other providers, PR/preview integrations, and unrelated application services are outside the requested local product.

## Change rule

Changes to `packages/core/src/orchestration-v2`, persistence, MCP orchestration, recovery, provider sessions, or SDK event mapping must preserve P1 and the relevant P2 scenario. If a T3 assertion is removed, document the removed application boundary and keep the management guarantee covered by another test. Do not replace durable state with an in-memory task graph or blanket approval handler.
