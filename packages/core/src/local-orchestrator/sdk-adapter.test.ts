import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type ChatAttachment,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  COPILOT_DEFAULT_INSTANCE_ID,
  makeCopilotSdkAdapterV2,
  type CopilotSdkClientLike,
  type CopilotSdkSessionLike,
} from "./sdk-adapter.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";

const THREAD_ID = ThreadId.make("sdk-adapter-test-thread");
const SESSION_ID = ProviderSessionId.make("sdk-adapter-test-session");
const RUN_ID = RunId.make("sdk-adapter-test-run");
const ATTEMPT_ID = RunAttemptId.make("sdk-adapter-test-attempt");
const ROOT_NODE_ID = NodeId.make("sdk-adapter-test-root");
const MODEL: ModelSelection = { instanceId: COPILOT_DEFAULT_INSTANCE_ID, model: process.env.T3_COPILOT_SDK_MODEL ?? "gpt-test" };
const POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
});

class FakeSession implements CopilotSdkSessionLike {
  readonly sessionId: string;
  readonly handlers = new Set<(event: unknown) => void>();
  readonly sends: Array<Record<string, unknown>> = [];
  readonly permissionResponses: unknown[] = [];
  readonly inputResponses: unknown[] = [];
  readonly eventHistory: unknown[] = [];
  pendingPermissionItems: unknown[] = [];
  abortCount = 0;
  disconnected = false;
  readonly rpc = {
    permissions: {
      handlePendingPermissionRequest: async (input: unknown) => {
        this.permissionResponses.push(input);
        return { ok: true };
      },
      pendingRequests: async () => ({ items: this.pendingPermissionItems }),
    },
    ui: {
      handlePendingUserInput: async (input: unknown) => {
        this.inputResponses.push(input);
        return { ok: true };
      },
    },
  };

  constructor(id: string) {
    this.sessionId = id;
  }

  send(options: string | Record<string, unknown>): Promise<string> {
    this.sends.push(typeof options === "string" ? { prompt: options } : options);
    return Promise.resolve(`message-${this.sends.length}`);
  }

  on(handler: (event: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: unknown): void {
    this.eventHistory.push(event);
    for (const handler of this.handlers) handler(event);
  }

  getEvents(): Promise<ReadonlyArray<unknown>> {
    return Promise.resolve(this.eventHistory);
  }

  abort(): Promise<void> {
    this.abortCount += 1;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }
}

class FakeClient implements CopilotSdkClientLike {
  readonly sessions = new Map<string, FakeSession>();
  readonly createConfigs: Array<Record<string, unknown>> = [];
  readonly resumeConfigs: Array<Record<string, unknown>> = [];
  startCount = 0;
  createCount = 0;
  resumeCount = 0;

  start(): Promise<void> {
    this.startCount += 1;
    return Promise.resolve();
  }

  stop(): Promise<ReadonlyArray<unknown>> {
    return Promise.resolve([]);
  }

  createSession(config: Record<string, unknown>): Promise<FakeSession> {
    this.createCount += 1;
    this.createConfigs.push(config);
    const session = new FakeSession(`native-${this.createCount}`);
    this.sessions.set(session.sessionId, session);
    return Promise.resolve(session);
  }

  resumeSession(id: string, config: Record<string, unknown>): Promise<FakeSession> {
    this.resumeCount += 1;
    this.resumeConfigs.push(config);
    const session = this.sessions.get(id) ?? new FakeSession(id);
    this.sessions.set(id, session);
    return Promise.resolve(session);
  }
}

const turnInput = (providerThread: ProviderAdapterV2TurnInput["providerThread"]): ProviderAdapterV2TurnInput => ({
  appThread: { interactionMode: "default" } as OrchestrationV2AppThread,
  threadId: THREAD_ID,
  runId: RUN_ID,
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: ATTEMPT_ID,
  rootNodeId: ROOT_NODE_ID,
  providerThread,
  message: {
    messageId: MessageId.make("sdk-adapter-test-message"),
    text: "hello Copilot",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
  modelSelection: MODEL,
  runtimePolicy: POLICY,
});

describe("Copilot SDK adapter", () => {
  it.effect("uses one warm client, translates streamed turns, and disables native children", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const adapter = makeCopilotSdkAdapterV2({ client });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const eventFiber = yield* runtime.events.pipe(Stream.takeUntil((event) => event.type === 'turn.terminal'), Stream.runCollect, Effect.forkScoped);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      yield* runtime.startTurn(turnInput(providerThread));
      const session = client.sessions.get("native-1");
      assert.isDefined(session);
      session!.emit({ type: "assistant.message", data: { messageId: "assistant-1", content: "hello back" } });
      // Completion events omit the tool name; retain it from execution_start.
      session!.emit({ type: "tool.execution_start", data: { toolCallId: "probe-1", toolName: "integration_probe", arguments: { marker: "probe" } } });
      session!.emit({ type: "tool.execution_complete", data: { toolCallId: "probe-1", success: true, result: { content: "probe result" } } });
      session!.emit({ type: "assistant.idle", data: {} });
      const runningSnapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(runningSnapshot.providerTurns[0]!.status, "running");
      session!.emit({ type: "session.idle", data: {} });
      const events = (yield* Fiber.join(eventFiber)) as ReadonlyArray<ProviderAdapterV2Event>;
      assert.isTrue(events.some((event) => event.type === "turn_item.updated"
        && event.turnItem.type === "dynamic_tool" && event.turnItem.status === "completed"
        && event.turnItem.toolName === "integration_probe"));
      assert.equal(client.startCount, 1);
      assert.equal(client.createCount, 1);
      assert.equal(client.resumeCount, 0);
      assert.equal(events.some((event) => event.type === "message.updated"), true);
      assert.equal(
        events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
        true,
      );
      const config = client.createConfigs[0]!;
      assert.deepEqual(config.includedBuiltinAgents, []);
      assert.deepEqual(config.excludedTools, ["task", "fleet", "manage_schedule"]);
      assert.equal(config.manageScheduleEnabled, false);
      assert.equal(config.permissionMode, "allow-all");
      yield* Effect.promise(() => adapter.close());
      assert.equal(session!.disconnected, true);
    }),
  );

  it.effect("routes a permission event through the durable runtime request RPC", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const adapter = makeCopilotSdkAdapterV2({ client });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const eventFiber = yield* runtime.events.pipe(Stream.takeUntil((event) => event.type === 'turn.terminal'), Stream.runCollect, Effect.forkScoped);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      yield* runtime.startTurn(turnInput(providerThread));
      const session = client.sessions.get("native-1")!;
      session.emit({
        type: "permission.requested",
        data: {
          requestId: "permission-1",
          permissionRequest: { kind: "shell", fullCommandText: "git status" },
        },
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.runtimeRequests.length, 1);
      const requestId = snapshot.runtimeRequests[0]!.id;
      yield* runtime.respondToRuntimeRequest({ requestId, decision: "accept" });
      assert.equal(session.permissionResponses.length, 1);
      assert.deepEqual(session.permissionResponses[0], {
        requestId: "permission-1",
        result: { kind: "approve-once", approvedInteractively: true },
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId: snapshot.runtimeRequests[0]!.providerTurnId! });
      assert.equal(session.abortCount, 1);
      session.emit({ type: 'session.idle', data: {} });
      const events = yield* Fiber.join(eventFiber);
      assert.equal(events.some((event) => event.type === "runtime_request.updated"), true);
    }),
  );

  it.effect("buffers handoff history without creating an extra SDK turn", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const adapter = makeCopilotSdkAdapterV2({ client });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const session = client.sessions.get("native-1")!;
      yield* runtime.injectHistory!({ context: "previous handoff", messages: [], providerThread });
      assert.equal(session.sends.length, 0);
      yield* runtime.startTurn(turnInput(providerThread));
      assert.equal(session.sends.length, 1);
      assert.equal(session.sends[0]!.prompt, "previous handoff\n\nhello Copilot");
      session.emit({ type: "session.idle", data: {} });
      yield* Effect.promise(() => adapter.close());
    }),
  );

  it.effect("resolves persisted attachment ids before forwarding native SDK paths", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const resolvedPath = "C:\\isolated-state\\attachments\\pending-file.txt";
      const attachment: ChatAttachment = {
        type: "file",
        id: "pending-12345678-1234-1234-1234-123456789abc-txt",
        name: "evidence.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      };
      const resolvedIds: string[] = [];
      const adapter = makeCopilotSdkAdapterV2({
        client,
        resolveAttachmentPath: (value) => {
          resolvedIds.push(value.id);
          return resolvedPath;
        },
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      yield* runtime.startTurn({
        ...turnInput(providerThread),
        message: { ...turnInput(providerThread).message, attachments: [attachment] },
      });
      const session = client.sessions.get("native-1")!;
      assert.deepEqual(resolvedIds, [attachment.id]);
      assert.deepEqual(session.sends[0]!.attachments, [{ type: "file", path: resolvedPath }]);
      session.emit({ type: "session.idle", data: {} });
      yield* Effect.promise(() => adapter.close());
    }),
  );

  it.effect("fails a turn when an attachment cannot be resolved", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const adapter = makeCopilotSdkAdapterV2({ client });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const attachment: ChatAttachment = {
        type: "file",
        id: "pending-12345678-1234-1234-1234-123456789abc-txt",
        name: "missing.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      };
      const result = yield* Effect.exit(
        runtime.startTurn({
          ...turnInput(providerThread),
          message: { ...turnInput(providerThread).message, attachments: [attachment] },
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.include(String(result), "attachment resolver is not configured");
      yield* Effect.promise(() => adapter.close());
    }),
  );

  it.effect("maps runtime policy modes to SDK permission modes", () =>
    Effect.gen(function* () {
      const cases = [
        ["approval-required", "manual"],
        ["full-access", "allow-all"],
        ["auto", "assisted"],
        ["auto-accept-edits", "manual"],
      ] as const;
      for (const [runtimeMode, permissionMode] of cases) {
        const client = new FakeClient();
        const adapter = makeCopilotSdkAdapterV2({ client });
        const policy = ProviderAdapterV2RuntimePolicy.make({ ...POLICY, runtimeMode });
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: MODEL,
          runtimePolicy: policy,
        });
        yield* runtime.ensureThread({ threadId: THREAD_ID, modelSelection: MODEL, runtimePolicy: policy });
        assert.equal(client.createConfigs[0]!.permissionMode, permissionMode);
        if (runtimeMode === "auto-accept-edits") {
          assert.isFunction(client.createConfigs[0]!.onPermissionRequest);
          const onPermissionRequest = client.createConfigs[0]!.onPermissionRequest as (
            request: unknown,
            invocation: unknown,
          ) => Promise<unknown>;
          assert.deepEqual(
            yield* Effect.promise(() => onPermissionRequest({ kind: "write", fileName: "README.md" }, { sessionId: "native-1" })),
            { kind: "approve-once" },
          );
        } else if (runtimeMode === 'full-access') {
          assert.equal(client.createConfigs[0]!.onPermissionRequest, undefined);
        } else {
          assert.isFunction(client.createConfigs[0]!.onPermissionRequest);
        }
        yield* Effect.promise(() => adapter.close());
      }
    }),
  );

  it.effect("bridges SDK user-input callbacks to the runtime request response", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const adapter = makeCopilotSdkAdapterV2({ client });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const session = client.sessions.get("native-1")!;
      const onUserInputRequest = client.createConfigs[0]!.onUserInputRequest as (
        request: unknown,
        invocation: unknown,
      ) => Promise<unknown>;
      const callbackResult = onUserInputRequest(
        { requestId: "question-1", question: "Which branch?", choices: ["main", "dev"] },
        { sessionId: session.sessionId },
      );
      const pending = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(pending.runtimeRequests.length, 1);
      const requestId = pending.runtimeRequests[0]!.id;
      yield* runtime.respondToRuntimeRequest({ requestId, response: "dev" });
      assert.deepEqual(yield* Effect.promise(() => callbackResult), { answer: "dev", wasFreeform: true });
      assert.equal(session.inputResponses.length, 0);
      yield* Effect.promise(() => adapter.close());
    }),
  );

  it.effect("recovers permission pending-list requests with a stable session/request id", () =>
    Effect.gen(function* () {
      const client = new FakeClient();
      const firstAdapter = makeCopilotSdkAdapterV2({ client });
      const firstRuntime = yield* firstAdapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const firstThread = yield* firstRuntime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const firstSession = client.sessions.get("native-1")!;
      firstSession.emit({
        type: "permission.requested",
        data: { requestId: "permission-recover-1", permissionRequest: { kind: "shell", fullCommandText: "git status" } },
      });
      const firstSnapshot = yield* firstRuntime.readThreadSnapshot({ providerThread: firstThread });
      const firstRequestId = firstSnapshot.runtimeRequests[0]!.id;
      yield* Effect.promise(() => firstAdapter.close());

      firstSession.pendingPermissionItems = [
        { requestId: "permission-recover-1", request: { kind: "shell", fullCommandText: "git status" } },
      ];
      const resumedAdapter = makeCopilotSdkAdapterV2({ client });
      const resumedRuntime = yield* resumedAdapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
        initialNativeThreadId: "native-1",
      });
      const resumedThread = yield* resumedRuntime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const resumedSnapshot = yield* resumedRuntime.readThreadSnapshot({ providerThread: resumedThread });
      assert.equal(resumedSnapshot.runtimeRequests.length, 1);
      assert.equal(resumedSnapshot.runtimeRequests[0]!.id, firstRequestId);
      yield* Effect.promise(() => resumedAdapter.close());
    }),
  );

  // Opt-in because it requires a locally authenticated Copilot CLI runtime.
  // Run with T3_COPILOT_SDK_LIVE=1 to exercise the actual child process; the
  // adapter still forces RuntimeConnection.forStdio and never uses a URI.
  it.effect.skipIf(process.env.T3_COPILOT_SDK_LIVE !== "1")(
    "drives a real local Copilot child through a T3 turn",
    () =>
      Effect.gen(function* () {
        const adapter = makeCopilotSdkAdapterV2({
          instanceId: COPILOT_DEFAULT_INSTANCE_ID,
          ...(process.env.T3_COPILOT_SDK_RUNTIME === undefined
            ? {}
            : { runtimePath: process.env.T3_COPILOT_SDK_RUNTIME }),
        });
        const effect = Effect.gen(function* () {
          const runtime = yield* adapter.openSession({
            threadId: THREAD_ID,
            providerSessionId: SESSION_ID,
            modelSelection: { ...MODEL, model: process.env.T3_COPILOT_SDK_MODEL ?? MODEL.model },
            runtimePolicy: POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId: THREAD_ID,
            modelSelection: { ...MODEL, model: process.env.T3_COPILOT_SDK_MODEL ?? MODEL.model },
            runtimePolicy: POLICY,
          });
          const terminal = yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "turn.terminal"),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* runtime.startTurn(
            turnInput(providerThread),
          );
          const result = yield* Fiber.join(terminal);
          assert.equal(Option.isSome(result), true);
          if (Option.isSome(result)) {
            assert.equal(result.value.type, "turn.terminal");
            if (result.value.type === 'turn.terminal') assert.equal(result.value.status, 'completed');
          }
        });
        yield* effect.pipe(
          Effect.ensuring(Effect.promise(() => adapter.close()).pipe(Effect.ignore)),
        );
      }),
  );
});
