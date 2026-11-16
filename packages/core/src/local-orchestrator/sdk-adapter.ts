/**
 * Copilot SDK provider adapter.
 *
 * The SDK is deliberately kept behind the orchestration-v2 adapter seam.  T3
 * still owns runs, retries, child threads, persistence, and runtime-request
 * policy; this module only owns the local Copilot runtime and translates its
 * session events into provider events.
 *
 * A single client is started by the adapter and resident SDK sessions are
 * keyed by native thread id.  The default client always uses the SDK's local
 * stdio transport.  An injected client is supported for deterministic tests
 * and for the headless composition's process lifecycle.
 */

import {
  CopilotClient,
  RuntimeConnection,
  type MCPServerConfig,
  type SessionConfig,
  type ResumeSessionConfig,
} from "@github/copilot-sdk";
import {
  defaultInstanceIdForDriver,
  MessageId,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  TurnItemId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import { turnScopedSelectionTransition } from "../orchestration-v2/ProviderSelectionTransition.ts";

/** Driver kind used by the extracted local Copilot provider. */
export const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
export const COPILOT_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(COPILOT_PROVIDER);

/**
 * The SDK types are intentionally structural here.  Apart from making the
 * adapter easy to fixture, this keeps the production seam tolerant of SDK
 * patch releases which add methods to CopilotSession.
 */
export interface CopilotSdkSessionLike {
  readonly sessionId: string;
  send(prompt: string): Promise<string>;
  send(options: Record<string, unknown>): Promise<string>;
  on(handler: (event: unknown) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  getEvents?(): Promise<ReadonlyArray<unknown>>;
  setModel?(model: string, options?: Record<string, unknown>): Promise<void>;
  readonly rpc?: {
    readonly permissions?: {
      readonly handlePendingPermissionRequest?: (input: unknown) => Promise<unknown>;
      readonly pendingRequests?: () => Promise<unknown>;
    };
    readonly ui?: {
      readonly handlePendingUserInput?: (input: unknown) => Promise<unknown>;
    };
  };
}

export interface CopilotSdkClientLike {
  start(): Promise<void>;
  stop(): Promise<ReadonlyArray<unknown>>;
  createSession(config: SessionConfig): Promise<CopilotSdkSessionLike>;
  resumeSession(id: string, config: ResumeSessionConfig): Promise<CopilotSdkSessionLike>;
}

export interface CopilotSdkAdapterSessionConfigInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly resume: boolean;
}

export interface CopilotSdkAdapterV2Options {
  readonly instanceId?: ProviderInstanceId;
  /** Inject a started/unstarted SDK client in tests or a composition host. */
  readonly client?: CopilotSdkClientLike;
  /** Optional path to the local Copilot runtime executable. */
  readonly runtimePath?: string;
  /**
   * Supplies additional SDK config.  `onEvent`, model, working directory,
   * policy, MCP, and child-agent gates are owned by this adapter and win over
   * conflicting values.
   */
  readonly sessionConfig?: (
    input: CopilotSdkAdapterSessionConfigInput,
  ) => Partial<SessionConfig>;
  /**
   * Hook for host-owned SDK tools.  The extracted runtime uses this to expose
   * T3 delegation as a local `defineTool` bridge where the SDK runtime can
   * register it directly; MCP remains the fallback transport.
   */
  readonly tools?: (
    input: CopilotSdkAdapterSessionConfigInput,
  ) => ReadonlyArray<unknown> | undefined;
  /** Override or augment the authenticated T3 MCP server projection. */
  readonly mcpServers?: (
    input: CopilotSdkAdapterSessionConfigInput,
    providerSession: McpProviderSession.McpProviderSessionConfig | undefined,
  ) => Record<string, MCPServerConfig> | undefined;
  /** Resolve a persisted chat attachment id to a private, local file path. */
  readonly resolveAttachmentPath?: (attachment: ChatAttachment) => string | Promise<string>;
  /** ID derivation service from the existing T3 runtime. */
  readonly idAllocator?: IdAllocator.IdAllocatorV2["Service"];
}

/** Capabilities are intentionally conservative where SDK support is unproven. */
export const CopilotSdkProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: true,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

type EventRecord = {
  readonly type?: unknown;
  readonly data?: unknown;
  readonly [key: string]: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;

const eventType = (event: unknown): string => stringValue(asRecord(event).type) ?? "";

const eventData = (event: unknown): Record<string, unknown> => {
  const record = asRecord(event);
  return asRecord(record.data);
};

const now = (): DateTime.Utc => DateTime.nowUnsafe();

const providerRef = (nativeId: string, strength: "strong" | "weak" = "strong"): OrchestrationV2ProviderRef => ({
  driver: COPILOT_PROVIDER,
  nativeId,
  strength,
});

const safeJson = (value: unknown): string => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
};

const textFrom = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const block = asRecord(part);
        return stringValue(block.text) ?? stringValue(block.content) ?? "";
      })
      .join("");
  }
  return value === undefined || value === null ? "" : safeJson(value);
};

const failure = (cause: unknown, message?: string): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message: (message ?? (cause instanceof Error ? cause.message : String(cause))).slice(0, 4_000) || "Copilot SDK error",
  code: null,
  retryable: false,
});

const attachmentList = async (
  attachments: ReadonlyArray<ChatAttachment>,
  resolveAttachmentPath: CopilotSdkAdapterV2Options["resolveAttachmentPath"],
): Promise<ReadonlyArray<unknown>> => {
  if (attachments.length === 0) return [];
  if (resolveAttachmentPath === undefined) {
    throw new Error("Copilot SDK attachment resolver is not configured");
  }
  return Promise.all(
    attachments.map(async (attachment) => {
      let path: string;
      try {
        path = await resolveAttachmentPath(attachment);
      } catch (cause) {
        throw new Error(`Unable to resolve attachment ${attachment.id}`, { cause });
      }
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new Error(`Unable to resolve attachment ${attachment.id}: resolver returned no path`);
      }
      return { type: "file", path };
    }),
  );
};

const permissionRequestsMatch = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean => {
  const leftKind = stringValue(left.kind);
  const rightKind = stringValue(right.kind);
  if (leftKind !== undefined && rightKind !== undefined && leftKind !== rightKind) return false;
  const relevantKeys = ["kind", "fullCommandText", "command", "fileName", "path", "toolName", "url"];
  return relevantKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return leftValue === undefined || rightValue === undefined || safeJson(leftValue) === safeJson(rightValue);
  });
};

function makeClient(options: CopilotSdkAdapterV2Options): CopilotSdkClientLike {
  if (options.client !== undefined) return options.client;
  const connection = RuntimeConnection.forStdio(
    options.runtimePath === undefined ? undefined : { path: options.runtimePath },
  );
  return new CopilotClient({ connection }) as unknown as CopilotSdkClientLike;
}

function idForProviderThread(
  idAllocator: IdAllocator.IdAllocatorV2["Service"] | undefined,
  nativeThreadId: string,
  instanceId: ProviderInstanceId,
): ProviderThreadId {
  return (
    idAllocator?.derive.providerThread({
      driver: COPILOT_PROVIDER,
      nativeThreadId,
      providerInstanceId: instanceId,
    }) ??
    ProviderThreadId.make(`provider-thread:provider:${COPILOT_PROVIDER}:provider-instance:${instanceId}:native-thread:${encodeURIComponent(nativeThreadId)}`)
  );
}

function idForProviderTurn(
  idAllocator: IdAllocator.IdAllocatorV2["Service"] | undefined,
  nativeTurnId: string,
): ProviderTurnId {
  return (
    idAllocator?.derive.providerTurn({ driver: COPILOT_PROVIDER, nativeTurnId }) ??
    ProviderTurnId.make(`provider-turn:provider:${COPILOT_PROVIDER}:native-turn:${encodeURIComponent(nativeTurnId)}`)
  );
}

function idForProviderItem(
  idAllocator: IdAllocator.IdAllocatorV2["Service"] | undefined,
  nativeItemId: string,
  kind: "node" | "message" | "turnItem",
): NodeId | MessageId | TurnItemId {
  if (idAllocator !== undefined) {
    if (kind === "node") return idAllocator.derive.nodeFromProviderItem({ driver: COPILOT_PROVIDER, nativeItemId });
    if (kind === "message") return idAllocator.derive.messageFromProviderItem({ driver: COPILOT_PROVIDER, nativeItemId });
    return idAllocator.derive.turnItemFromProviderItem({ driver: COPILOT_PROVIDER, nativeItemId });
  }
  const prefix = kind === "node" ? "node" : kind === "message" ? "message" : "turn-item";
  const value = `${prefix}:provider:${COPILOT_PROVIDER}:native-item:${encodeURIComponent(nativeItemId)}`;
  return kind === "node" ? NodeId.make(value) : kind === "message" ? MessageId.make(value) : TurnItemId.make(value);
}

function idForRuntimeRequest(
  idAllocator: IdAllocator.IdAllocatorV2["Service"] | undefined,
  nativeSessionId: string,
  nativeRequestId: string,
  providerTurnId: ProviderTurnId | undefined,
): RuntimeRequestId {
  // Event handlers run outside an Effect fiber.  The deterministic fallback is
  // also useful during cold-resume, where the same native request must map to
  // the same T3 request before the allocator service is available.
  // `providerTurnId` is deliberately not part of the identity. A resumed
  // session can recover a request before its contextual T3 turn is restored.
  void idAllocator;
  void providerTurnId;
  return RuntimeRequestId.make(
    `runtime-request:provider:${COPILOT_PROVIDER}:native-session:${encodeURIComponent(nativeSessionId)}:native-request:${encodeURIComponent(nativeRequestId)}`,
  );
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly messages: Map<string, { readonly messageId: MessageId; readonly startedAt: DateTime.Utc; text: string }>;
  readonly tools: Map<string, { readonly nativeItemId: string; readonly startedAt: DateTime.Utc; readonly name: string; args: unknown }>;
  readonly items: Map<string, OrchestrationV2TurnItem>;
  nextOrdinal: number;
  interrupted: boolean;
  terminal: boolean;
}

interface PendingRequest {
  readonly nativeRequestId: string;
  readonly kind: "permission" | "user_input";
  readonly requestData: Record<string, unknown>;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

interface PendingCallback {
  readonly kind: "permission" | "user_input";
  nativeRequestId: string | undefined;
  readonly requestData: Record<string, unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

interface AdapterState {
  readonly input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
  readonly queue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  providerSession: OrchestrationV2ProviderSession;
  readonly providerTurns: Map<ProviderTurnId, OrchestrationV2ProviderTurn>;
  readonly messages: Map<MessageId, OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: Map<RuntimeRequestId, OrchestrationV2RuntimeRequest>;
  readonly turnItems: Map<TurnItemId, OrchestrationV2TurnItem>;
  readonly pendingRequests: Map<RuntimeRequestId, PendingRequest>;
  readonly pendingCallbacks: Map<string, PendingCallback>;
  readonly sessionsByNativeId: Map<string, CopilotSdkSessionLike>;
  session: CopilotSdkSessionLike | null;
  nativeSessionId: string | null;
  providerThread: OrchestrationV2ProviderThread | null;
  activeTurn: ActiveTurn | null;
  unsubscribe: (() => void) | null;
  latestModel: string;
  historyContext: string | null;
}

export function makeCopilotSdkAdapterV2(
  options: CopilotSdkAdapterV2Options = {},
): ProviderAdapter.ProviderAdapterV2Shape & { readonly close: () => Promise<void> } {
  const instanceId = options.instanceId ?? COPILOT_DEFAULT_INSTANCE_ID;
  const client = makeClient(options);
  let clientStart: Promise<void> | undefined;
  const residentSessions = new Map<string, CopilotSdkSessionLike>();
  const openStates = new Set<AdapterState>();
  let callbackSequence = 0;
  let closed = false;

  const startClient = (): Promise<void> => {
    clientStart ??= client.start();
    return clientStart;
  };

  const protocolError = (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: COPILOT_PROVIDER,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });

  const mapSessionConfig = (
    state: AdapterState,
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    cwd: string,
    resume: boolean,
    onEvent: (event: unknown) => void,
  ): SessionConfig | ResumeSessionConfig => {
    const configInput: CopilotSdkAdapterSessionConfigInput = {
      threadId: input.threadId,
      providerSessionId: input.providerSessionId,
      cwd,
      modelSelection: input.modelSelection,
      runtimePolicy: input.runtimePolicy,
      resume,
    };
    const providerMcp = McpProviderSession.readMcpProviderSession(input.threadId);
    const injectedMcp =
      options.mcpServers?.(configInput, providerMcp) ??
      (providerMcp === undefined
        ? undefined
        : {
            "t3-code": {
              type: "http" as const,
              url: providerMcp.endpoint,
              headers: { Authorization: providerMcp.authorizationHeader },
            },
          });
    const extension = options.sessionConfig?.(configInput) ?? {};
    const tools = options.tools?.(configInput);
    const onUserInputRequest = async (request: unknown): Promise<unknown> => {
      const value = asRecord(request);
      const nativeRequestId =
        stringValue(value.requestId) ??
        `user-input:${state.nativeSessionId ?? state.input.providerSessionId}:${stringValue(value.question) ?? callbackSequence}`;
      const requestData = { ...value, requestId: nativeRequestId };
      let resolveCallback!: (value: unknown) => void;
      let rejectCallback!: (cause: unknown) => void;
      const response = new Promise<unknown>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      });
      state.pendingCallbacks.set(`callback:${++callbackSequence}`, {
        kind: "user_input",
        nativeRequestId,
        requestData,
        resolve: resolveCallback,
        reject: rejectCallback,
      });
      rememberRequest(state, state.activeTurn, nativeRequestId, "user_input", requestData);
      return response;
    };

    const onPermissionRequest =
      input.runtimePolicy.runtimeMode !== "full-access"
        ? async (request: unknown): Promise<unknown> => {
            const requestData = asRecord(request);
            const permissionKind = classifyPermission(requestData);
            if (input.runtimePolicy.runtimeMode === 'auto-accept-edits' && permissionKind === "file-change") {
              // Selective edit mode admits file changes while retaining the
              // normal approval boundary for commands, reads, MCP, and other
              // permission kinds.
              return { kind: "approve-once" };
            }
            let resolveCallback!: (value: unknown) => void;
            let rejectCallback!: (cause: unknown) => void;
            const response = new Promise<unknown>((resolve, reject) => {
              resolveCallback = resolve;
              rejectCallback = reject;
            });
            const pending = [...state.pendingRequests.values()].find(
              (entry) => entry.kind === "permission" && permissionRequestsMatch(entry.requestData, requestData),
            );
            state.pendingCallbacks.set(`callback:${++callbackSequence}`, {
              kind: "permission",
              nativeRequestId: pending?.nativeRequestId,
              requestData,
              resolve: resolveCallback,
              reject: rejectCallback,
            });
            if (pending === undefined) {
              // The callback can race the broadcast event. `handleEvent` binds
              // this deferred entry to the native request when that event is
              // delivered, preserving the request's durable identity.
              return response;
            }
            return response;
          }
        : undefined;

    const common: Record<string, unknown> = {
      ...extension,
      model: input.modelSelection.model,
      workingDirectory: cwd,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      mcpOAuthTokenStorage: "in-memory",
      // Host-managed T3 delegation is the only child mechanism.  Empty
      // builtin-agent allowlist also prevents future task/fleet aliases from
      // silently creating provider-owned child conversations.
      includedBuiltinAgents: [],
      excludedTools: ["task", "fleet", "manage_schedule"],
      customAgentsLocalOnly: true,
      manageScheduleEnabled: false,
      enableSessionTelemetry: false,
      enableSessionStore: true,
      enableConfigDiscovery: false,
      permissionMode: input.runtimePolicy.runtimeMode === "full-access"
        ? "allow-all"
        : input.runtimePolicy.runtimeMode === "auto" ? "assisted" : "manual",
      onEvent,
      // The SDK disables ask_user routing unless this callback is registered.
      // It remains a deferred bridge even when the event stream also reports
      // the request, so the runtime callback is completed by T3's RPC path.
      onUserInputRequest,
      // Do not allow an extension-supplied permission handler to bypass T3's
      // runtime policy. Manual and assisted requests wait for a T3 response;
      // selective edit mode admits only its file-change requests automatically.
      onPermissionRequest,
      ...(input.runtimePolicy.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.runtimePolicy.reasoningEffort }),
      ...(injectedMcp === undefined ? {} : { mcpServers: injectedMcp }),
      ...(tools === undefined ? {} : { tools }),
    };
    if (resume) {
      return {
        ...common,
        continuePendingWork: true,
        allowTranscriptRecovery: true,
      } as ResumeSessionConfig;
    }
    return common as SessionConfig;
  };

  const emit = (state: AdapterState, event: ProviderAdapter.ProviderAdapterV2Event): void => {
    try {
      Effect.runSync(Queue.offer(state.queue, event));
    } catch {
      // A late SDK notification after a scope/client close must not escape
      // the SDK's callback boundary and crash the host process.
    }
  };

  const itemOrdinal = (turn: ActiveTurn, nativeItemId: string): number => {
    const previous = turn.itemOrdinals.get(nativeItemId);
    if (previous !== undefined) return previous;
    const ordinal = turn.nextOrdinal++;
    turn.itemOrdinals.set(nativeItemId, ordinal);
    return ordinal;
  };

  const baseItem = (
    state: AdapterState,
    turn: ActiveTurn,
    nativeItemId: string,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
    status: OrchestrationV2TurnItem["status"],
    title: string | null = null,
  ) => ({
    id: idForProviderItem(options.idAllocator, nativeItemId, "turnItem") as TurnItemId,
    threadId: turn.input.threadId,
    runId: turn.input.runId,
    nodeId: idForProviderItem(options.idAllocator, nativeItemId, "node") as NodeId,
    providerThreadId: turn.input.providerThread.id,
    providerTurnId: turn.providerTurn.id,
    nativeItemRef: providerRef(nativeItemId),
    parentItemId: null,
    ordinal: itemOrdinal(turn, nativeItemId),
    status,
    title,
    startedAt,
    completedAt: status === "running" || status === "waiting" || status === "pending" ? null : updatedAt,
    updatedAt,
  });

  const emitNode = (
    state: AdapterState,
    turn: ActiveTurn,
    nativeItemId: string,
    kind: OrchestrationV2ExecutionNode["kind"],
    status: OrchestrationV2ExecutionNode["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
    runtimeRequestId: RuntimeRequestId | null = null,
  ) => {
    emit(state, {
      type: "node.updated",
      driver: COPILOT_PROVIDER,
      node: {
        id: idForProviderItem(options.idAllocator, nativeItemId, "node") as NodeId,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        runtimeRequestId,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    } as ProviderAdapter.ProviderAdapterV2Event);
  };

  const emitThread = (state: AdapterState, patch: Partial<OrchestrationV2ProviderThread>) => {
    if (state.providerThread === null) return;
    state.providerThread = { ...state.providerThread, ...patch, updatedAt: now() };
    emit(state, {
      type: "provider_thread.updated",
      driver: COPILOT_PROVIDER,
      providerThread: state.providerThread,
    });
  };

  const emitProviderSession = (
    state: AdapterState,
    status: OrchestrationV2ProviderSession["status"],
    lastError: string | null = state.providerSession.lastError,
  ) => {
    state.providerSession = {
      ...state.providerSession,
      status,
      lastError,
      updatedAt: now(),
    };
    emit(state, {
      type: "provider_session.updated",
      driver: COPILOT_PROVIDER,
      providerSession: state.providerSession,
    });
  };

  const emitTurn = (state: AdapterState, turn: ActiveTurn) => {
    state.providerTurns.set(turn.providerTurn.id, turn.providerTurn);
    emit(state, {
      type: "provider_turn.updated",
      driver: COPILOT_PROVIDER,
      threadId: turn.input.threadId,
      providerTurn: turn.providerTurn,
    });
  };

  const emitAssistant = (
    state: AdapterState,
    turn: ActiveTurn,
    nativeMessageId: string,
    text: string,
    streaming: boolean,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
  ) => {
    const messageId = idForProviderItem(options.idAllocator, `message:${nativeMessageId}`, "message") as MessageId;
    const nodeId = idForProviderItem(options.idAllocator, `message:${nativeMessageId}`, "node") as NodeId;
    const message: OrchestrationV2ConversationMessage = {
      id: messageId,
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId,
      role: "assistant",
      text,
      attachments: [],
      streaming,
      createdBy: "agent",
      creationSource: "provider",
      createdAt: startedAt,
      updatedAt,
    };
    state.messages.set(messageId, message);
    emit(state, { type: "message.updated", driver: COPILOT_PROVIDER, message });
    const item: OrchestrationV2TurnItem = {
      ...baseItem(state, turn, `message:${nativeMessageId}`, startedAt, updatedAt, streaming ? "running" : "completed"),
      type: "assistant_message",
      messageId,
      text,
      streaming,
    } as OrchestrationV2TurnItem;
    turn.items.set(item.id, item);
    emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
    emitNode(state, turn, `message:${nativeMessageId}`, "assistant_message", streaming ? "running" : "completed", startedAt, streaming ? null : updatedAt);
  };

  const emitReasoning = (
    state: AdapterState,
    turn: ActiveTurn,
    nativeReasoningId: string,
    text: string,
    streaming: boolean,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
  ) => {
    const item: OrchestrationV2TurnItem = {
      ...baseItem(state, turn, `reasoning:${nativeReasoningId}`, startedAt, updatedAt, streaming ? "running" : "completed"),
      type: "reasoning",
      text,
      streaming,
    } as OrchestrationV2TurnItem;
    turn.items.set(item.id, item);
    emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
    emitNode(state, turn, `reasoning:${nativeReasoningId}`, "reasoning", streaming ? "running" : "completed", startedAt, streaming ? null : updatedAt);
  };

  const classifyPermission = (request: Record<string, unknown>): ProviderRequestKind => {
    switch (stringValue(request.kind)) {
      case "read":
      case "file-read":
      case "view":
        return "file-read";
      case "write":
      case "file-write":
      case "edit":
        return "file-change";
      case "mcp":
      case "mcp-elicitation":
        return "mcp-elicitation";
      case "shell":
      case "command":
        return "command";
      default:
        return "permission";
    }
  };

  const rememberRequest = (
    state: AdapterState,
    turn: ActiveTurn | null,
    nativeRequestId: string,
    kind: "permission" | "user_input",
    requestData: Record<string, unknown>,
  ) => {
    const createdAt = now();
    const providerThread = state.providerThread;
    const providerTurnId = turn?.providerTurn.id;
    const nativeSessionId = state.nativeSessionId ?? state.providerThread?.nativeThreadRef?.nativeId ?? state.input.providerSessionId;
    const requestId = idForRuntimeRequest(options.idAllocator, nativeSessionId, nativeRequestId, providerTurnId);
    if (state.pendingRequests.has(requestId)) return;
    const nodeId = options.idAllocator?.derive.approvalNode({ requestId }) ?? NodeId.make(`approval-node:${requestId}`);
    const threadId = turn?.input.threadId ?? providerThread?.appThreadId ?? state.input.threadId;
    const nativeItemId = `request:${nativeRequestId}`;
    const requestKind = kind === "permission" ? classifyPermission(asRecord(requestData.permissionRequest)) : "permission";
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: providerTurnId ?? null,
      nativeRequestRef: providerRef(nativeRequestId),
      kind: kind === "user_input" ? "user_input" : requestKind,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: state.input.providerSessionId },
      createdAt,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId,
      runId: turn?.input.runId ?? null,
      parentNodeId: turn?.input.rootNodeId ?? null,
      rootNodeId: turn?.input.rootNodeId ?? nodeId,
      kind: kind === "user_input" ? "user_input_request" : "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: providerThread?.id ?? null,
      providerTurnId: providerTurnId ?? null,
      nativeItemRef: providerRef(nativeRequestId),
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: null,
    };
    const itemBase = {
      id: options.idAllocator?.derive.approvalTurnItem({ requestId }) ?? TurnItemId.make(`approval-item:${requestId}`),
      threadId,
      runId: turn?.input.runId ?? null,
      nodeId,
      providerThreadId: providerThread?.id ?? null,
      providerTurnId: providerTurnId ?? null,
      nativeItemRef: providerRef(nativeRequestId),
      parentItemId: null,
      ordinal: turn === null ? 0 : itemOrdinal(turn, nativeItemId),
      status: "waiting" as const,
      title: stringValue(requestData.question) ?? stringValue(requestData.title) ?? "Copilot request",
      startedAt: createdAt,
      completedAt: null,
      updatedAt: createdAt,
    };
    let turnItem: OrchestrationV2TurnItem;
    if (kind === "user_input") {
      const question = stringValue(requestData.question) ?? "Copilot is asking for input.";
      const choices = Array.isArray(requestData.choices) ? requestData.choices : [];
      const options = choices.map((choice) => ({
        label: String(choice),
        description: String(choice),
      }));
      const questionValue: OrchestrationV2UserInputQuestion = {
        id: nativeRequestId,
        header: "Copilot",
        question,
        options,
        allowCustomAnswer: requestData.allowFreeform !== false,
        required: true,
      };
      turnItem = { ...itemBase, type: "user_input_request", requestId, questions: [questionValue] } as OrchestrationV2TurnItem;
    } else {
      const prompt = stringValue(asRecord(requestData.permissionRequest).fullCommandText) ?? stringValue(requestData.question);
      turnItem = {
        ...itemBase,
        type: "approval_request",
        requestId,
        requestKind,
        ...(prompt === undefined ? {} : { prompt }),
      } as OrchestrationV2TurnItem;
    }
    const pending: PendingRequest = { nativeRequestId, kind, requestData: requestData.permissionRequest === undefined ? requestData : asRecord(requestData.permissionRequest), runtimeRequest, node, turnItem };
    state.pendingRequests.set(requestId, pending);
    state.runtimeRequests.set(requestId, runtimeRequest);
    state.turnItems.set(turnItem.id, turnItem);
    emit(state, { type: "runtime_request.updated", driver: COPILOT_PROVIDER, threadId, runtimeRequest });
    emit(state, { type: "node.updated", driver: COPILOT_PROVIDER, node });
    emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem });
    emitProviderSession(state, "waiting");
  };

  const bindPendingCallback = (
    state: AdapterState,
    kind: "permission" | "user_input",
    nativeRequestId: string,
    requestData: Record<string, unknown>,
  ): void => {
    const callback = [...state.pendingCallbacks.values()].find(
      (entry) =>
        entry.kind === kind &&
        (entry.nativeRequestId === nativeRequestId ||
          (entry.nativeRequestId === undefined &&
            (kind === "user_input" || permissionRequestsMatch(entry.requestData, requestData)))),
    );
    if (callback !== undefined) callback.nativeRequestId = nativeRequestId;
  };

  const callbackForPending = (state: AdapterState, pending: PendingRequest): PendingCallback | undefined =>
    [...state.pendingCallbacks.values()].find(
      (entry) =>
        entry.kind === pending.kind &&
        (entry.nativeRequestId === pending.nativeRequestId ||
          (entry.nativeRequestId === undefined &&
            (pending.kind === "user_input" || permissionRequestsMatch(entry.requestData, pending.requestData)))),
    );

  const rejectPendingCallbacks = (state: AdapterState, cause: unknown): void => {
    const callbacks = [...state.pendingCallbacks.values()];
    state.pendingCallbacks.clear();
    for (const callback of callbacks) callback.reject(cause);
  };

  const cancelPendingRequests = (state: AdapterState): void => {
    const pending = [...state.pendingRequests.values()];
    state.pendingRequests.clear();
    for (const request of pending) updatePendingRequest(state, request, "cancelled", { requestId: request.runtimeRequest.id });
  };

  /** Rebuild pending SDK prompts after a cold `resumeSession`.
   *
   * The Copilot runtime intentionally does not re-emit restored requests when
   * `continuePendingWork` is true.  T3 therefore scans its durable event
   * history and the permissions pending-list RPC, preserving the same
   * deterministic runtime-request id used by live events.
   */
  const recoverPendingRequests = async (state: AdapterState, session: CopilotSdkSessionLike): Promise<void> => {
    const pending = new Map<string, { readonly kind: "permission" | "user_input"; readonly data: Record<string, unknown> }>();
    const history = session.getEvents === undefined ? [] : await session.getEvents();
    for (const entry of history) {
      const type = eventType(entry);
      const data = eventData(entry);
      const requestId = stringValue(data.requestId);
      if (requestId === undefined) continue;
      if (type === "permission.requested") pending.set(requestId, { kind: "permission", data });
      else if (type === "user_input.requested") pending.set(requestId, { kind: "user_input", data });
      else if (type === "permission.completed" || type === "user_input.completed") pending.delete(requestId);
    }
    const permissionPending = await session.rpc?.permissions?.pendingRequests?.();
    const pendingRecord = asRecord(permissionPending);
    const pendingItems = pendingRecord.items;
    const permissionItems: ReadonlyArray<unknown> = Array.isArray(permissionPending)
      ? permissionPending
      : Array.isArray(pendingItems)
        ? pendingItems
        : [];
    for (const entry of permissionItems) {
      const data = asRecord(entry);
      const requestId = stringValue(data.requestId);
      if (requestId !== undefined) {
        const permissionRequest = data.request ?? data.permissionRequest;
        pending.set(requestId, {
          kind: "permission",
          data: { requestId, permissionRequest },
        });
      }
    }
    for (const [requestId, entry] of pending) rememberRequest(state, null, requestId, entry.kind, entry.data);
  };

  const updatePendingRequest = (state: AdapterState, pending: PendingRequest, status: "resolved" | "cancelled", input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => {
    const resolvedAt = now();
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      ...pending.runtimeRequest,
      status,
      resolvedAt,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.answers === undefined ? {} : { answers: input.answers }),
    };
    const node: OrchestrationV2ExecutionNode = {
      ...pending.node,
      // Runtime requests have a `resolved` state; execution nodes use the
      // activity vocabulary and therefore close as `completed`.
      status: (status === "resolved" ? "completed" : "cancelled") as OrchestrationV2ExecutionNode["status"],
      completedAt: resolvedAt,
    };
    const turnItem = {
      ...pending.turnItem,
      status: status === "resolved" ? "completed" : "cancelled",
      completedAt: resolvedAt,
      updatedAt: resolvedAt,
    } as OrchestrationV2TurnItem;
    state.runtimeRequests.set(runtimeRequest.id, runtimeRequest);
    state.turnItems.set(turnItem.id, turnItem);
    emit(state, { type: "runtime_request.updated", driver: COPILOT_PROVIDER, threadId: node.threadId, runtimeRequest });
    emit(state, { type: "node.updated", driver: COPILOT_PROVIDER, node });
    emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem });
    if (state.activeTurn !== null) emitProviderSession(state, "running");
  };

  const handleEvent = (state: AdapterState, event: unknown): void => {
    const type = eventType(event);
    const data = eventData(event);
    const turn = state.activeTurn;
    if (type === "permission.requested") {
      const nativeRequestId = stringValue(data.requestId) ?? stringValue(data.id) ?? `permission-${Date.now()}`;
      bindPendingCallback(state, "permission", nativeRequestId, asRecord(data.permissionRequest));
      rememberRequest(state, turn, nativeRequestId, "permission", data);
      return;
    }
    if (type === "user_input.requested") {
      const nativeRequestId = stringValue(data.requestId) ?? stringValue(data.id) ?? `question-${Date.now()}`;
      bindPendingCallback(state, "user_input", nativeRequestId, data);
      rememberRequest(state, turn, nativeRequestId, "user_input", data);
      return;
    }
    if (type === "permission.completed" || type === "user_input.completed") {
      const nativeRequestId = stringValue(data.requestId);
      if (nativeRequestId === undefined) return;
      const pending = [...state.pendingRequests.values()].find((entry) => entry.nativeRequestId === nativeRequestId);
      if (pending !== undefined) {
        state.pendingRequests.delete(pending.runtimeRequest.id);
        updatePendingRequest(state, pending, "resolved", { requestId: pending.runtimeRequest.id });
      }
      return;
    }
    if (turn === null) return;
    const updatedAt = now();
    if (type === "assistant.turn_start") {
      const nativeTurnId = stringValue(data.turnId) ?? stringValue(data.id);
      if (nativeTurnId !== undefined && turn.providerTurn.nativeTurnRef === null) {
        turn.providerTurn = {
          ...turn.providerTurn,
          nativeTurnRef: providerRef(nativeTurnId),
        };
        emitTurn(state, turn);
      }
      return;
    }
    if (type === "assistant.message_start") {
      const nativeMessageId = stringValue(data.messageId) ?? `message-${turn.nextOrdinal}`;
      const startedAt = updatedAt;
      turn.messages.set(nativeMessageId, {
        messageId: idForProviderItem(options.idAllocator, `message:${nativeMessageId}`, "message") as MessageId,
        startedAt,
        text: "",
      });
      emitAssistant(state, turn, nativeMessageId, "", true, startedAt, updatedAt);
      return;
    }
    if (type === "assistant.message_delta") {
      const nativeMessageId = stringValue(data.messageId) ?? `message-${turn.nextOrdinal}`;
      const stateMessage = turn.messages.get(nativeMessageId) ?? { messageId: MessageId.make(`message:${nativeMessageId}`), startedAt: updatedAt, text: "" };
      stateMessage.text += textFrom(data.deltaContent);
      turn.messages.set(nativeMessageId, stateMessage);
      emitAssistant(state, turn, nativeMessageId, stateMessage.text, true, stateMessage.startedAt, updatedAt);
      return;
    }
    if (type === "assistant.message") {
      const nativeMessageId = stringValue(data.messageId) ?? `message-${turn.nextOrdinal}`;
      const previous = turn.messages.get(nativeMessageId);
      const text = stringValue(data.content) ?? previous?.text ?? "";
      const startedAt = previous?.startedAt ?? updatedAt;
      if (data.reasoningText !== undefined) emitReasoning(state, turn, `${nativeMessageId}:reasoning`, textFrom(data.reasoningText), false, startedAt, updatedAt);
      turn.messages.set(nativeMessageId, { messageId: previous?.messageId ?? MessageId.make(`message:${nativeMessageId}`), startedAt, text });
      emitAssistant(state, turn, nativeMessageId, text, false, startedAt, updatedAt);
      return;
    }
    if (type === "assistant.reasoning" || type === "assistant.reasoning_delta") {
      const nativeReasoningId = stringValue(data.reasoningId) ?? `reasoning-${turn.nextOrdinal}`;
      const previous = turn.items.get(idForProviderItem(options.idAllocator, `reasoning:${nativeReasoningId}`, "turnItem") as TurnItemId);
      const priorText = previous !== undefined && previous.type === "reasoning" ? previous.text : "";
      const text = type.endsWith("_delta") ? priorText + textFrom(data.deltaContent) : stringValue(data.content) ?? priorText;
      emitReasoning(state, turn, nativeReasoningId, text, type.endsWith("_delta"), previous?.startedAt ?? updatedAt, updatedAt);
      return;
    }
    if (type === "assistant.usage") {
      const inputTokens = numberValue(data.inputTokens);
      const cachedInputTokens = numberValue(data.cacheReadTokens);
      const outputTokens = numberValue(data.outputTokens);
      const reasoningOutputTokens = numberValue(data.reasoningTokens);
      const usedTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0);
      turn.providerTurn = {
        ...turn.providerTurn,
        tokenUsage: {
          usedTokens,
          ...(numberValue(data.maxPromptTokens) === undefined ? {} : { maxTokens: numberValue(data.maxPromptTokens) }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
          updatedAt: DateTime.formatIso(updatedAt),
        },
      };
      emitTurn(state, turn);
      return;
    }
    if (type === "tool.execution_start" || type === "tool.execution_progress" || type === "tool.shell_output" || type === "tool.execution_complete") {
      const toolCallId = stringValue(data.toolCallId) ?? `tool-${turn.nextOrdinal}`;
      const existing = turn.tools.get(toolCallId);
      const name = stringValue(data.toolName) ?? existing?.name ?? "tool";
      const tool = existing ?? { nativeItemId: `tool:${toolCallId}`, startedAt: updatedAt, name, args: data.arguments };
      turn.tools.set(toolCallId, tool);
      const complete = type === "tool.execution_complete";
      const errored = data.success === false || data.error !== undefined;
      const status = complete ? errored ? (turn.interrupted ? "interrupted" : "failed") : "completed" : "running";
      const output = textFrom(data.text ?? data.progressMessage ?? asRecord(data.result).detailedContent ?? asRecord(data.result).content ?? data.error);
      const isShell = name === "shell" || name === "bash" || name === "run_command" || name === "powershell";
      const base = baseItem(state, turn, tool.nativeItemId, tool.startedAt, updatedAt, status, name);
      const item: OrchestrationV2TurnItem = isShell
        ? ({ ...base, type: "command_execution", input: stringValue(asRecord(tool.args).command) ?? safeJson(tool.args), ...(output.length === 0 ? {} : { output }), ...(errored ? { outputIndicatesFailure: true } : {}) } as OrchestrationV2TurnItem)
        : ({ ...base, type: "dynamic_tool", toolName: name, input: tool.args ?? {}, ...(output.length === 0 ? {} : { output }) } as OrchestrationV2TurnItem);
      turn.items.set(item.id, item);
      emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
      emitNode(state, turn, tool.nativeItemId, "tool_call", status, tool.startedAt, complete ? updatedAt : null);
      return;
    }
    if (type === "session.error" || type === "assistant.error" || type === "model.call_failure") {
      const providerFailure = failure(data.message ?? data.error ?? "Copilot session failed");
      finishTurn(state, turn, "failed", providerFailure);
      return;
    }
    // Only session.idle is the SDK's strong turn boundary. Assistant-idle and
    // autopilot-stopped can occur while tools or queued work are still active.
    if (type === "session.idle") {
      finishTurn(state, turn, turn.interrupted ? "interrupted" : "completed");
    }
  };

  function finishTurn(state: AdapterState, turn: ActiveTurn, status: "completed" | "interrupted" | "failed", providerFailure?: OrchestrationV2ProviderFailure): void {
    if (turn.terminal) return;
    turn.terminal = true;
    if (status !== "completed") {
      rejectPendingCallbacks(state, new Error(providerFailure?.message ?? `Copilot SDK turn ${status}.`));
      cancelPendingRequests(state);
    }
    const completedAt = now();
    turn.providerTurn = {
      ...turn.providerTurn,
      status,
      completedAt,
    };
    emitTurn(state, turn);
    emitProviderSession(state, "ready");
    emitThread(state, { status: "idle" });
    if (providerFailure !== undefined) {
      const nativeItemId = `failure:${turn.providerTurn.id}`;
      const item: OrchestrationV2TurnItem = {
        ...baseItem(state, turn, nativeItemId, completedAt, completedAt, "failed", "Copilot error"),
        type: "error",
        failure: providerFailure,
      } as OrchestrationV2TurnItem;
      turn.items.set(item.id, item);
      emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
      emitNode(state, turn, nativeItemId, "system", "failed", completedAt, completedAt);
      emit(state, {
        type: "turn.terminal",
        driver: COPILOT_PROVIDER,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: Math.max(1, Math.trunc(turn.input.runOrdinal)),
        failureItemOrdinal: item.ordinal + 1,
        status: "failed",
        failure: providerFailure,
        threadDisposition: "reusable",
      } as ProviderAdapter.ProviderAdapterV2Event);
    } else {
      emit(state, {
        type: "turn.terminal",
        driver: COPILOT_PROVIDER,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: Math.max(1, Math.trunc(turn.input.runOrdinal)),
        status,
        failure: null,
        threadDisposition: "reusable",
      } as ProviderAdapter.ProviderAdapterV2Event);
    }
    state.activeTurn = null;
  }

  const makeProviderThread = (
    state: AdapterState,
    threadId: ThreadId,
    modelSelection: ModelSelection,
    existing: OrchestrationV2ProviderThread | undefined,
  ): OrchestrationV2ProviderThread => {
    const session = state.session;
    if (session === null) throw new Error("Copilot session is not open");
    const timestamp = now();
    const nativeThreadId = session.sessionId;
    if (existing !== undefined) {
      return {
        ...existing,
        providerSessionId: state.input.providerSessionId,
        appThreadId: threadId,
        nativeThreadRef: providerRef(nativeThreadId),
        status: "idle",
        nativeMetadata: {
          ...(existing.nativeMetadata ?? {}),
          modelSelection,
          itemIdentityVersion: 2,
        },
        updatedAt: timestamp,
      };
    }
    return {
      id: idForProviderThread(options.idAllocator, nativeThreadId, instanceId),
      driver: COPILOT_PROVIDER,
      providerInstanceId: instanceId,
      providerSessionId: state.input.providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: providerRef(nativeThreadId),
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: { modelSelection, itemIdentityVersion: 2 },
      goal: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  };

  const openNativeSession = (
    state: AdapterState,
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    nativeThreadId: string | undefined,
    existingProviderThread: OrchestrationV2ProviderThread | undefined,
  ): Effect.Effect<CopilotSdkSessionLike, ProviderAdapter.ProviderAdapterV2Error> =>
    Effect.tryPromise({
      try: async () => {
        await startClient();
        const configInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput = {
          threadId,
          providerSessionId: state.input.providerSessionId,
          modelSelection,
          runtimePolicy,
          ...(nativeThreadId === undefined ? {} : { initialNativeThreadId: nativeThreadId }),
        };
        const onEvent = (event: unknown): void => handleEvent(state, event);
        const config = mapSessionConfig(state, configInput, runtimePolicy.cwd ?? process.cwd(), nativeThreadId !== undefined, onEvent);
        const session = nativeThreadId === undefined ? await client.createSession(config as SessionConfig) : await client.resumeSession(nativeThreadId, config as ResumeSessionConfig);
        state.session = session;
        state.nativeSessionId = session.sessionId;
        state.latestModel = modelSelection.model;
        residentSessions.set(session.sessionId, session);
        if (existingProviderThread !== undefined && state.providerThread === null) state.providerThread = existingProviderThread;
        // The real SDK invokes `onEvent` before create/resume and keeps that
        // handler for the session lifetime.  Injectable fakes commonly ignore
        // that config callback, so only those fakes receive a second listener;
        // subscribing both against a real SDK would duplicate every event.
        if (options.client !== undefined) state.unsubscribe = session.on((event) => handleEvent(state, event));
        if (nativeThreadId !== undefined) await recoverPendingRequests(state, session);
        return session;
      },
      catch: (cause) => new ProviderAdapter.ProviderAdapterOpenSessionError({ driver: COPILOT_PROVIDER, providerSessionId: state.input.providerSessionId, cause }),
    });

  const adapter = ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver: COPILOT_PROVIDER,
    getCapabilities: () => Effect.succeed(CopilotSdkProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CopilotSdkAdapterV2.openSession")(function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
      const timestamp = now();
      const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: COPILOT_PROVIDER,
        providerInstanceId: instanceId,
        status: "starting",
        cwd: input.runtimePolicy.cwd ?? process.cwd(),
        model: input.modelSelection.model,
        capabilities: CopilotSdkProviderCapabilitiesV2,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastError: null,
      };
      const state: AdapterState = {
        input,
        queue,
        providerSession,
        providerTurns: new Map(),
        messages: new Map(),
        runtimeRequests: new Map(),
        turnItems: new Map(),
        pendingRequests: new Map(),
        pendingCallbacks: new Map(),
        sessionsByNativeId: residentSessions,
        session: null,
        nativeSessionId: null,
        providerThread: null,
        activeTurn: null,
        unsubscribe: null,
        latestModel: input.modelSelection.model,
        historyContext: null,
      };
      openStates.add(state);
      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: async () => {
            rejectPendingCallbacks(state, new Error("Copilot SDK adapter session closed."));
            state.unsubscribe?.();
            state.unsubscribe = null;
            const session = state.session;
            state.session = null;
            state.nativeSessionId = null;
            if (session !== null && residentSessions.get(session.sessionId) === session) {
              residentSessions.delete(session.sessionId);
              await session.disconnect();
            }
            openStates.delete(state);
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined)),
      );
      yield* Effect.tryPromise({ try: () => startClient(), catch: (cause) => new ProviderAdapter.ProviderAdapterOpenSessionError({ driver: COPILOT_PROVIDER, providerSessionId: input.providerSessionId, cause }) });
      state.providerSession = { ...state.providerSession, status: "ready", updatedAt: now() };
      if (input.initialNativeThreadId !== undefined) {
        yield* openNativeSession(state, input.threadId, input.modelSelection, input.runtimePolicy, input.initialNativeThreadId, undefined).pipe(
          Effect.mapError((cause) => cause instanceof ProviderAdapter.ProviderAdapterOpenSessionError ? cause : new ProviderAdapter.ProviderAdapterOpenSessionError({ driver: COPILOT_PROVIDER, providerSessionId: input.providerSessionId, cause })),
        );
        state.providerThread = makeProviderThread(state, input.threadId, input.modelSelection, undefined);
      }
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver: COPILOT_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return state.providerSession;
        },
        events: Stream.fromQueue(queue),
        getModelContextWindow: () => undefined,
        canReuseContextUsage: (previous, next) => previous.model === next.model,
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const existingNativeId = threadInput.existingProviderThread?.nativeThreadRef?.nativeId ?? state.providerThread?.nativeThreadRef?.nativeId ?? undefined;
            if (state.session === null || (existingNativeId !== undefined && state.session.sessionId !== existingNativeId)) {
              yield* openNativeSession(state, threadInput.threadId, threadInput.modelSelection, threadInput.runtimePolicy, existingNativeId, threadInput.existingProviderThread);
            }
            const providerThread = makeProviderThread(state, threadInput.threadId, threadInput.modelSelection, threadInput.existingProviderThread);
            state.providerThread = providerThread;
            emit(state, { type: "provider_thread.updated", driver: COPILOT_PROVIDER, providerThread });
            return providerThread;
          }).pipe(Effect.mapError((cause) => cause instanceof ProviderAdapter.ProviderAdapterEnsureThreadError ? cause : new ProviderAdapter.ProviderAdapterEnsureThreadError({ driver: COPILOT_PROVIDER, threadId: threadInput.threadId, cause }))),
        resumeThread: (threadInput) =>
          Effect.gen(function* () {
            const threadId = threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId;
            const nativeId = threadInput.providerThread.nativeThreadRef?.nativeId;
            if (nativeId === null || nativeId === undefined) return yield* new ProviderAdapter.ProviderAdapterResumeThreadError({ driver: COPILOT_PROVIDER, providerSessionId: input.providerSessionId, providerThreadId: threadInput.providerThread.id });
            if (state.session === null || state.session.sessionId !== nativeId) {
              yield* openNativeSession(state, threadId, threadInput.modelSelection ?? input.modelSelection, threadInput.runtimePolicy ?? input.runtimePolicy, nativeId, threadInput.providerThread);
            }
            const providerThread = makeProviderThread(state, threadId, threadInput.modelSelection ?? input.modelSelection, threadInput.providerThread);
            state.providerThread = providerThread;
            emit(state, { type: "provider_thread.updated", driver: COPILOT_PROVIDER, providerThread });
            return providerThread;
          }).pipe(Effect.mapError((cause) => cause instanceof ProviderAdapter.ProviderAdapterResumeThreadError ? cause : new ProviderAdapter.ProviderAdapterResumeThreadError({ driver: COPILOT_PROVIDER, providerSessionId: input.providerSessionId, providerThreadId: threadInput.providerThread.id, cause }))),
        injectHistory: (history) =>
          Effect.gen(function* () {
            if (state.session === null) return false;
            // Handoff context is prepended to the next managed user turn. A
            // standalone SDK send would create an unintended extra LLM turn
            // and would not preserve T3's turn accounting.
            state.historyContext = state.historyContext === null
              ? history.context
              : `${state.historyContext}\n\n${history.context}`;
            return true;
          }),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            if (state.session === null) return yield* new ProviderAdapter.ProviderAdapterTurnStartError({ driver: COPILOT_PROVIDER, threadId: turnInput.threadId, providerThreadId: turnInput.providerThread.id, runId: turnInput.runId });
            const startedAt = now();
            const nativeTurnId = `${turnInput.runId}:turn:${turnInput.providerTurnOrdinal}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idForProviderTurn(options.idAllocator, nativeTurnId),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: null,
              ordinal: Math.max(1, Math.trunc(turnInput.providerTurnOrdinal)) as OrchestrationV2ProviderTurn["ordinal"],
              status: "running",
              startedAt,
              completedAt: null,
            };
            const active: ActiveTurn = { input: turnInput, providerTurn, startedAt, itemOrdinals: new Map(), messages: new Map(), tools: new Map(), items: new Map(), nextOrdinal: 0, interrupted: false, terminal: false };
            state.activeTurn = active;
            emitProviderSession(state, "running");
            state.providerThread = { ...turnInput.providerThread, status: "active", lastRunOrdinal: Math.max(1, Math.trunc(turnInput.runOrdinal)) as OrchestrationV2ProviderThread["lastRunOrdinal"], updatedAt: startedAt };
            emit(state, { type: "provider_thread.updated", driver: COPILOT_PROVIDER, providerThread: state.providerThread });
            emitTurn(state, active);
            const userItemId = options.idAllocator?.derive.userTurnItem({ messageId: turnInput.message.messageId }) ?? TurnItemId.make(`user-message:${turnInput.message.messageId}`);
            const userItem: OrchestrationV2TurnItem = {
              id: userItemId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: providerTurn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt,
              completedAt: startedAt,
              updatedAt: startedAt,
              type: "user_message",
              messageId: turnInput.message.messageId,
              ...(turnInput.message.scheduledTaskId === undefined ? {} : { scheduledTaskId: turnInput.message.scheduledTaskId }),
              ...(turnInput.message.senderThreadId === undefined ? {} : { senderThreadId: turnInput.message.senderThreadId }),
              inputIntent: "turn_start",
              text: turnInput.message.text,
              attachments: [...turnInput.message.attachments],
              createdBy: turnInput.message.createdBy,
              creationSource: turnInput.message.creationSource,
            } as OrchestrationV2TurnItem;
            active.items.set(userItem.id, userItem);
            emit(state, { type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: userItem });
            const currentModel = turnInput.modelSelection.model;
            if (state.latestModel !== currentModel && state.session.setModel !== undefined) {
              yield* Effect.tryPromise({ try: () => state.session!.setModel!(currentModel, turnInput.runtimePolicy.reasoningEffort === undefined ? undefined : { reasoningEffort: turnInput.runtimePolicy.reasoningEffort }), catch: (cause) => new ProviderAdapter.ProviderAdapterTurnStartError({ driver: COPILOT_PROVIDER, threadId: turnInput.threadId, providerThreadId: turnInput.providerThread.id, runId: turnInput.runId, cause }) });
              state.latestModel = currentModel;
            }
            const historyContext = state.historyContext;
            const prompt = historyContext === null
              ? turnInput.message.text
              : `${historyContext}\n\n${turnInput.message.text}`;
            const sdkAttachments = yield* Effect.tryPromise({
              try: () => attachmentList(turnInput.message.attachments, options.resolveAttachmentPath),
              catch: (cause) => new ProviderAdapter.ProviderAdapterTurnStartError({ driver: COPILOT_PROVIDER, threadId: turnInput.threadId, providerThreadId: turnInput.providerThread.id, runId: turnInput.runId, cause }),
            });
            yield* Effect.tryPromise({
              try: () => state.session!.send({ prompt, source: "user", mode: turnInput.nativeThreadHasTurns === true ? "enqueue" : "immediate", attachments: sdkAttachments, agentMode: turnInput.appThread.interactionMode === "plan" ? "plan" : "interactive" }),
              catch: (cause) => new ProviderAdapter.ProviderAdapterTurnStartError({ driver: COPILOT_PROVIDER, threadId: turnInput.threadId, providerThreadId: turnInput.providerThread.id, runId: turnInput.runId, cause }),
            });
            // Keep the buffered context if admission failed, but clear it as
            // soon as the SDK accepts this managed turn.
            state.historyContext = null;
          }),
        steerTurn: (steerInput) =>
          Effect.gen(function* () {
            if (state.session === null) return yield* new ProviderAdapter.ProviderAdapterSteerRunError({ driver: COPILOT_PROVIDER, providerThreadId: steerInput.providerThread.id, providerTurnId: steerInput.providerTurnId });
            yield* Effect.tryPromise({ try: () => state.session!.send({ prompt: steerInput.message.text, source: "user", mode: "immediate" }), catch: (cause) => new ProviderAdapter.ProviderAdapterSteerRunError({ driver: COPILOT_PROVIDER, providerThreadId: steerInput.providerThread.id, providerTurnId: steerInput.providerTurnId, cause }) });
          }),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            if (state.session === null) return;
            if (state.activeTurn !== null) state.activeTurn.interrupted = true;
            rejectPendingCallbacks(state, new Error("Copilot SDK turn interrupted."));
            cancelPendingRequests(state);
            yield* Effect.tryPromise({ try: () => state.session!.abort(), catch: (cause) => new ProviderAdapter.ProviderAdapterInterruptError({ driver: COPILOT_PROVIDER, providerThreadId: interruptInput.providerThread.id, providerTurnId: interruptInput.providerTurnId, cause }) });
          }),
        unloadThread: (threadInput) =>
          Effect.gen(function* () {
            const nativeId = threadInput.providerThread.nativeThreadRef?.nativeId;
            if (nativeId === undefined || nativeId === null) return;
            const session = residentSessions.get(nativeId);
            if (session === undefined) return;
            yield* Effect.tryPromise({ try: () => session.disconnect(), catch: (cause) => new ProviderAdapter.ProviderAdapterCloseSessionError({ driver: COPILOT_PROVIDER, providerSessionId: input.providerSessionId, cause }) });
            residentSessions.delete(nativeId);
            if (state.session === session) {
              rejectPendingCallbacks(state, new Error("Copilot SDK session unloaded."));
              state.unsubscribe?.();
              state.unsubscribe = null;
              state.session = null;
              state.nativeSessionId = null;
            }
          }),
        respondToRuntimeRequest: (responseInput) =>
          Effect.gen(function* () {
            const pending = state.pendingRequests.get(responseInput.requestId);
            if (pending === undefined || state.session === null) return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver: COPILOT_PROVIDER, requestId: responseInput.requestId });
            if (pending.kind === "permission") {
              const result = responseInput.decision === "accept"
                ? { kind: "approve-once", approvedInteractively: true }
                : responseInput.decision === "acceptForSession"
                  ? { kind: "approve-for-session" }
                  : responseInput.decision === "acceptAlways"
                    ? { kind: "approve-for-session" }
                    : responseInput.decision === "cancel"
                      ? { kind: "cancelled" }
                      : { kind: "reject", feedback: "Permission declined by the user." };
              const callback = callbackForPending(state, pending);
              if (callback !== undefined) {
                for (const [key, entry] of state.pendingCallbacks) {
                  if (entry === callback) {
                    state.pendingCallbacks.delete(key);
                    break;
                  }
                }
                if (responseInput.decision === "cancel") callback.reject(new Error("Permission request cancelled by the user."));
                else callback.resolve(result);
              } else {
                const handler = state.session.rpc?.permissions?.handlePendingPermissionRequest;
                if (handler === undefined) return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver: COPILOT_PROVIDER, requestId: responseInput.requestId });
                yield* Effect.tryPromise({ try: () => handler({ requestId: pending.nativeRequestId, result }), catch: (cause) => new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver: COPILOT_PROVIDER, requestId: responseInput.requestId, cause }) });
              }
            } else {
              const answer = responseInput.answers === undefined ? textFrom(responseInput.response) : Object.values(responseInput.answers).map(textFrom).join(", ");
              const callback = callbackForPending(state, pending);
              if (callback !== undefined) {
                for (const [key, entry] of state.pendingCallbacks) {
                  if (entry === callback) {
                    state.pendingCallbacks.delete(key);
                    break;
                  }
                }
                if (responseInput.decision === "cancel") callback.reject(new Error("User input request cancelled by the user."));
                else callback.resolve({ answer, wasFreeform: true });
              } else {
                const handler = state.session.rpc?.ui?.handlePendingUserInput;
                if (handler === undefined) return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver: COPILOT_PROVIDER, requestId: responseInput.requestId });
                yield* Effect.tryPromise({ try: () => handler({ requestId: pending.nativeRequestId, response: { answer, wasFreeform: true } }), catch: (cause) => new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({ driver: COPILOT_PROVIDER, requestId: responseInput.requestId, cause }) });
              }
            }
            state.pendingRequests.delete(responseInput.requestId);
            updatePendingRequest(state, pending, responseInput.decision === "cancel" ? "cancelled" : "resolved", responseInput);
          }),
        readThreadSnapshot: (snapshotInput) =>
          Effect.succeed({
            providerThread: state.providerThread ?? snapshotInput.providerThread,
            providerTurns: [...state.providerTurns.values()],
            messages: [...state.messages.values()],
            runtimeRequests: [...state.runtimeRequests.values()],
          }),
        rollbackThread: (rollbackInput) => Effect.fail(new ProviderAdapter.ProviderAdapterRollbackThreadError({ driver: COPILOT_PROVIDER, providerThreadId: rollbackInput.providerThread.id, checkpointId: rollbackInput.target.checkpointId })),
        forkThread: (forkInput) => Effect.fail(new ProviderAdapter.ProviderAdapterForkThreadError({ driver: COPILOT_PROVIDER, providerThreadId: forkInput.sourceProviderThread.id })),
      };
      emit(state, { type: "provider_session.updated", driver: COPILOT_PROVIDER, providerSession: state.providerSession });
      return runtime;
    }),
  });
  return {
    ...adapter,
    close: async () => {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const state of openStates) {
        rejectPendingCallbacks(state, new Error("Copilot SDK adapter closed."));
        state.unsubscribe?.();
        state.unsubscribe = null;
        state.session = null;
        state.nativeSessionId = null;
        state.historyContext = null;
        openStates.delete(state);
      }
      const sessions = [...residentSessions.values()];
      residentSessions.clear();
      for (const session of sessions) {
        try {
          await session.disconnect();
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (clientStart !== undefined) {
        try {
          const stopErrors = await client.stop();
          errors.push(...stopErrors);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close Copilot SDK runtime.");
      }
    },
  };
}

/** Alias retained for headless composition code that names the SDK directly. */
export const makeCopilotSdkAdapter = makeCopilotSdkAdapterV2;
