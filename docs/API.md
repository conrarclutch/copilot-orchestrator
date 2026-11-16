# Local API

Start `node bin/copilot-orchestrator.mjs serve --cwd <repository> --model auto`. Keep stdin open to keep the shared SDK runtime and asynchronous children alive. Add `--data-dir <directory>` for isolated state, `--events` for live domain-event notifications, `--mcp-config <path>` for host-owned stdio/loopback MCP servers, and `--events-after <sequence>` to replay stored events after a persisted cursor before following new events.

Every line is `{ "id": <correlation-id>, "method": "name", "params": { ... } }`. Responses are `{ "id": ..., "result": ... }` or `{ "id": ..., "error": "..." }`. Events have `method: "event"` and no response ID. Concurrent requests are supported. Use a stable, unique `clientRequestId` for retried mutations; the correlation `id` alone is not an idempotency key.

| Method | Main parameters |
| --- | --- |
| `project.list` | none |
| `project.get` | `projectId` |
| `project.create` | `title`, `workspaceRoot`, optional `clientRequestId`, `createWorkspaceRootIfMissing` |
| `thread.create` | `projectId`, optional `title`, `prompt`, `clientRequestId`, `runtimeMode`, `interactionMode`, `worktreePath`, `branch` |
| `thread.list` | `projectId`, optional `includeSubagents`, `statuses`, `cursor`, `limit` |
| `thread.status` | `threadId`; returns the thread, latest run and managed tasks |
| `thread.send` | `threadId`, `message`, optional `mode`, `clientRequestId` |
| `thread.wait` | `threadId`, optional `runId`, `timeoutMs` |
| `thread.read` | `threadId`, optional `view`, `afterPosition`, `limit`, `runLimit`, `itemId`, `textOffset`, `maxCharsPerItem` |
| `thread.cancel` | `threadId`, optional `runId`, `reason`, `clientRequestId` |
| `runtime.respond` | `threadId`, `requestId`, optional `decision`, `answers`, `clientRequestId` |
| `attachment.import` | `path`, optional `name`, `mimeType`; copies a local file into isolated attachment state |
| `worktree.create` | `cwd`, `refName`, optional `newRefName`, `baseRefName`, `path` (null chooses the local worktrees directory) |
| `orchestrator.capabilities` | optional active caller `threadId` |
| `task.delegate` | active parent `threadId`, `task`, optional `mode`, `target`, `title`, `role`, `timeoutMs`, `clientRequestId` |
| `task.status` | parent `threadId`, `taskId` |
| `task.cancel` | parent `threadId`, `taskId`, optional `clientRequestId` |

`thread.send.mode` is `auto`, `queue`, `steer` or `restart`. Runtime modes are `approval-required`, `auto-accept-edits`, `auto` and `full-access`; persistent `thread.create` defaults to `approval-required`. The one-shot `run` command intentionally uses `full-access`. Interaction mode is `default` or `plan`.

Approval decisions are `accept`, `acceptForSession`, `acceptAlways`, `decline` and `cancel`. Questions use `answers`, keyed by the question ID found in the pending request's turn item. `thread.read` with `view: "activity"` includes request items. `thread.status` and event notifications expose waiting state.

Delegation tools enforce the real provider-session identity and active-parent rules. Agent calls receive that identity directly from the SDK adapter. External controllers can list/read threads and cancel a child by its thread ID without inventing an agent caller. The `task.*` methods require a parent session opened by the current host; after a restart, use thread controls until that parent session resumes.

## Example requests

```json
{"id":1,"method":"project.create","params":{"title":"My project","workspaceRoot":"/absolute/repository","clientRequestId":"project-setup-1"}}
{"id":2,"method":"thread.create","params":{"projectId":"<returned project id>","title":"Review","prompt":"Use delegate_task with mode wait for a reviewer, then summarize its findings.","clientRequestId":"review-1"}}
{"id":3,"method":"thread.wait","params":{"threadId":"<returned thread id>","timeoutMs":120000}}
{"id":4,"method":"thread.read","params":{"threadId":"<returned thread id>","limit":20}}
```

A separate local Git worktree can be created with `worktree.create`, then passed as `worktreePath` when creating a thread. Its managed descendants inherit that workspace. SDK conversation fork/rollback are not advertised.

Import an attachment first, then include the returned attachment object in `thread.create` or `thread.send`. A new thread with attachments must include a prompt. The current public method list does not expose dedicated checkpoint/diff/restore RPCs; those services remain available inside the core for an embedding adapter.

When an event queue overflows, the bridge emits `events.dropped` and the host may emit `events.resyncRequired`. Re-read authoritative state with `thread.read` or `thread.status` before continuing the UI. Persist the last event sequence returned to the application, not merely the highest sequence observed by a reader.

The state-machine and service schemas in `packages/contracts/src/orchestratorMcp.ts` and `packages/core/src/` are the authoritative contracts. The transport validates against those schemas rather than reimplementing their paging, cancellation or delegation logic.
