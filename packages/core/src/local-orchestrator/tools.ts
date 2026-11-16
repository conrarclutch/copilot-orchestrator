import { defineTool } from "@github/copilot-sdk";
import {
  EnvironmentId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type * as OrchestratorMcpServiceModule from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { CopilotSdkAdapterSessionConfigInput } from "./sdk-adapter.ts";

export type LocalCopilotToolSession = Pick<
  CopilotSdkAdapterSessionConfigInput,
  "threadId" | "providerSessionId" | "modelSelection" | "cwd"
>;

export type LocalToolRunner = (effect: Effect.Effect<unknown, unknown>) => Promise<unknown>;

const string = { type: "string" } as const;
const optionalString = { type: "string" } as const;
const noAdditionalProperties = { additionalProperties: false } as const;

const schemas = {
  delegate: {
    type: "object",
    properties: {
      task: { type: "string", description: "Self-contained task for a child agent." },
      title: optionalString,
      mode: { type: "string", enum: ["async", "wait"] },
      timeoutMs: { type: "number" },
      clientRequestId: optionalString,
      role: { type: "string", enum: ["implementation", "research", "review", "design", "test", "general"] },
      runtimeMode: { type: "string", enum: ["inherit", "approval-required", "auto-accept-edits", "auto", "full-access"] },
      interactionMode: { type: "string", enum: ["inherit", "default", "plan"] },
      target: {
        type: "object",
        properties: {
          providerInstanceId: string,
          driverKind: string,
          model: string,
          options: {
            oneOf: [
              { type: "object", additionalProperties: { type: ["string", "boolean"] } },
              {
                type: "array",
                items: {
                  type: "object",
                  properties: { id: string, value: { type: ["string", "boolean"] } },
                  required: ["id", "value"],
                  additionalProperties: false,
                },
              },
            ],
          },
        },
        additionalProperties: false,
      },
    },
    required: ["task"],
    ...noAdditionalProperties,
  },
  taskStatus: {
    type: "object",
    properties: { taskId: string },
    required: ["taskId"],
    ...noAdditionalProperties,
  },
  taskCancel: {
    type: "object",
    properties: { taskId: string, reason: optionalString, clientRequestId: optionalString },
    required: ["taskId"],
    ...noAdditionalProperties,
  },
  threadSend: {
    type: "object",
    properties: {
      threadId: string,
      message: { type: "string", description: "Message to send to the target thread." },
      mode: { type: "string", enum: ["auto", "queue", "steer", "restart"] },
      clientRequestId: optionalString,
    },
    required: ["threadId", "message"],
    ...noAdditionalProperties,
  },
  threadRead: {
    type: "object",
    properties: {
      threadId: string,
      itemId: string,
      textOffset: { type: "integer", minimum: 0 },
      view: { type: "string", enum: ["messages", "activity"] },
      afterPosition: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      runLimit: { type: "integer", minimum: 1, maximum: 50 },
      maxCharsPerItem: { type: "integer", minimum: 1, maximum: 50000 },
    },
    required: ["threadId"],
    ...noAdditionalProperties,
  },
  threadWait: {
    type: "object",
    properties: { threadId: string, runId: string, timeoutMs: { type: "number" } },
    required: ["threadId"],
    ...noAdditionalProperties,
  },
  capabilities: { type: "object", properties: {}, ...noAdditionalProperties },
} as const;

export function localCopilotInvocationScope(input: LocalCopilotToolSession): McpInvocationScope {
  return {
    environmentId: EnvironmentId.make("environment:local"),
    requestNamespace: `copilot-sdk:${input.providerSessionId}`,
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
    thread: {
      threadId: input.threadId,
      providerSessionId: input.providerSessionId,
      providerInstanceId: input.modelSelection.instanceId,
    },
    client: undefined,
  };
}

function errorResult(error: unknown): { readonly error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * Creates the SDK's real local tools for this exact provider session. A tool
 * never invents a caller ID: the adapter supplies the session identity and
 * the T3 service still checks that delegations come from an active parent.
 */
export function makeOrchestratorTools(input: {
  readonly session: LocalCopilotToolSession;
  readonly service: OrchestratorMcpServiceModule.OrchestratorMcpService["Service"];
  readonly runEffect: (effect: Effect.Effect<unknown, unknown>) => Promise<unknown>;
  readonly onCaller?: (session: LocalCopilotToolSession) => void;
}): ReadonlyArray<unknown> {
  input.onCaller?.(input.session);
  const scope = localCopilotInvocationScope(input.session);
  const safe = (run: (payload: unknown) => Promise<unknown>) => async (payload: unknown) => {
    try {
      return await run(payload);
    } catch (error) {
      return errorResult(error);
    }
  };

  return [
    defineTool("delegate_task", {
      title: "Delegate a task",
      description:
        "Start or wait for a child task managed by the local orchestrator. Delegation requires this exact Copilot thread to have an active T3 run.",
      parameters: schemas.delegate,
      handler: safe(async (payload) => {
        const args = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput)(payload);
        return input.runEffect(input.service.delegateTask(scope, args));
      }),
    }),
    defineTool("task_status", {
      title: "Read delegated task status",
      description: "Read a task's durable status, latest result, and completion state.",
      parameters: schemas.taskStatus,
      handler: safe(async (payload) => {
        const args = Schema.decodeUnknownSync(OrchestratorMcpTaskStatusInput)(payload);
        return input.runEffect(input.service.taskStatus(scope, args.taskId));
      }),
    }),
    defineTool("task_cancel", {
      title: "Cancel delegated task",
      description: "Cancel an app-managed child task and its nested delegated work.",
      parameters: schemas.taskCancel,
      handler: safe(async (payload) => {
        const args = Schema.decodeUnknownSync(OrchestratorMcpTaskCancelInput)(payload);
        return input.runEffect(input.service.cancelTask(scope, args));
      }),
    }),
    defineTool("t3_thread_send", {
      title: "Send a thread message",
      description: "Send a follow-up message to another thread in this local environment.",
      parameters: schemas.threadSend,
      handler: safe(async (payload) => {
        const args = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput)(payload);
        return input.runEffect(input.service.sendToThread(scope, args));
      }),
    }),
    defineTool("t3_thread_read", {
      title: "Read thread history",
      description: "Read a page of durable messages or activity from a thread.",
      parameters: schemas.threadRead,
      handler: safe(async (payload) => {
        const args = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput)(payload);
        return input.runEffect(input.service.readThread(scope, args));
      }),
    }),
    defineTool("t3_thread_wait", {
      title: "Wait for a thread",
      description: "Wait for a thread's current or selected run to settle.",
      parameters: schemas.threadWait,
      handler: safe(async (payload) => {
        const args = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput)(payload);
        return input.runEffect(input.service.waitForThread(scope, args));
      }),
    }),
    defineTool("orchestrator_capabilities", {
      title: "List orchestration capabilities",
      description: "Read available local providers, models, and orchestration limits.",
      parameters: schemas.capabilities,
      handler: safe(async () => input.runEffect(input.service.capabilities(scope))),
    }),
  ];
}
