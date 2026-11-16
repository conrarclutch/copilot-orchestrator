# Verification

This document separates repeatable automated evidence from live checks. Live checks use isolated temporary Git repositories and local data directories; they do not use another application's data or a T3 runtime database.

## Automated suites

The full TypeScript suite passed **301 tests with 1 skipped test across 26 files**, including the orchestration MCP contracts. The hardened Python bridge passed **14 tests** across `test_client.py` and `test_aiohttp_example.py`.

Repeat the local checks after a clean install:

```sh
npm ci
npm test
npm run check
npm run build
python -m unittest -v examples.python_bridge.test_client examples.python_bridge.test_aiohttp_example
```

The skipped TypeScript case is the opt-in live SDK test when its live environment flag is not set. The automated suites cover the extracted orchestration, persistence, MCP, checkpoint, recovery, provider-session, renderer, local composition, SDK-adapter, NDJSON bridge, attachment, and aiohttp integration assertions.

## Current live evidence

The fresh compiled Node/Python integration passed through `scripts/python-integration-live.py --run-live`:

- the model read the marker from an imported attachment;
- the Copilot turn called a local Python MCP tool configured through `--mcp-config`;
- 66 ordered domain events were captured;
- after shutdown and restart, replay began at the exact next event sequence;
- the completed thread remained persisted and readable.

The current direct live smoke also passed with a real managed parent and children: it produced `ALPHA+BETA`, persisted three threads and two child projections, captured 203 events, verified follow-up retry idempotency, created a worktree, and read the state successfully after restart.

Run the opt-in Python integration only when authenticated Copilot access and a suitable local model are available:

```sh
python scripts/python-integration-live.py --run-live
```

The live script writes temporary evidence under ignored local state. Do not commit its generated workspace, attachment, event, or summary files.

## Historical live evidence

Earlier isolated smoke checks exercised nested delegation, restart reads, stable retry IDs, worktree binding, structured questions, manual approvals, and cancellation. Those checks are useful regression evidence, but they are historical and do not replace a current release run.

## Event and recovery checks

The persistent host supports replay with `--events-after <sequence>`. Persist the highest event sequence returned to the application, not merely the highest sequence observed by a reader. If the bounded queue emits `events.dropped` or the host emits `events.resyncRequired`, re-read authoritative state with `thread.read` or `thread.status` before resuming the UI.

## Remaining qualification

This evidence does not claim full T3 product parity. The complete multi-provider application, graphical clients, abrupt-process recovery with active children and pending approvals, a normalized side-by-side management differential against T3, and comparative host-overhead benchmarks remain separate qualification work. Native Copilot conversation fork and rollback are unsupported.

## Publication review

The release tree was checked against the public upstream provenance records and scanned with Gitleaks. Five generic-key alerts were manually reviewed: three keyboard shortcut definitions and two instances of a fixed test idempotency UUID. They are false positives; no actual credential findings remained. Local state, credentials, generated live traces, and earlier research history are excluded from the public release.
