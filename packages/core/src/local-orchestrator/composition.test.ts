import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it } from "vite-plus/test";

import * as Mcp from "../mcp/OrchestratorMcpService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  layer,
  localInvocationScope,
  type LocalProviderInput,
} from "./composition.ts";

const providerInstanceId = ProviderInstanceId.make("copilot");
const driver = ProviderDriverKind.make("copilot");
const environmentId = EnvironmentId.make("environment:local-test");

// Keep this fixture local to the composition test so the boot check does not
// import a provider SDK adapter merely to satisfy capability decoding.
const testCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: false,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "none",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
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
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

/** A transport-free adapter: this test only exercises durable project/thread state. */
const provider: LocalProviderInput = {
  model: "gpt-5",
  adapter: {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(testCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("provider session is not used by this composition test"),
  },
};

describe("local orchestration composition", () => {
  it("boots durable services and persists a project and thread", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "t3-local-composition-"));
    const workspaceRoot = join(dataDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const runtime = ManagedRuntime.make(
      layer({
        cwd: workspaceRoot,
        dataDir,
        environmentId,
        provider,
      }),
    );

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const projects = yield* ProjectService.ProjectService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const mcp = yield* Mcp.OrchestratorMcpService;
          const projectId = ProjectId.make("project:local-composition");
          // The project id is explicit and stable so a caller can safely retry
          // the same command against this durable local store.
          const created = yield* projects.bootstrap({
            commandId: CommandId.make("local-composition-project-create"),
            projectId,
            title: "Local composition test",
            workspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: providerInstanceId,
              model: provider.model,
            },
          });
          const threadId = ThreadId.make("thread:local-composition");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("local-composition-thread-create"),
            threadId,
            projectId: created.project.id,
            title: "Local thread",
            modelSelection: {
              instanceId: providerInstanceId,
              model: provider.model,
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceRoot,
            createdBy: "user",
            creationSource: "server",
          });
          const listed = yield* mcp.listThreads(
            localInvocationScope({ environmentId }),
            { projectId: created.project.id },
          );
          const read = yield* mcp.readThread(
            localInvocationScope({
              environmentId,
              threadId,
              providerInstanceId,
            }),
            { threadId },
          );
          return {
            projectId: created.project.id,
            listed: listed.total,
            readThreadId: read.thread.threadId,
            dispatchType: typeof orchestrator.dispatch,
          };
        }),
      );

      expect(result.listed).toBe(1);
      expect(result.readThreadId).toBe("thread:local-composition");
      expect(result.dispatchType).toBe("function");
    } finally {
      await runtime.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
