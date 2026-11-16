import { CopilotClient, RuntimeConnection, type ModelInfo } from "@github/copilot-sdk";
import {
  CommandId,
  ChatAttachment,
  getProviderAttachmentLimitError,
  EnvironmentId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
  ProjectId,
  ProviderInstanceId,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeMode,
  ProviderInteractionMode,
  VcsCreateWorktreeInput,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from 'effect/Stream';
import * as Fiber from 'effect/Fiber';
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";

import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from '../orchestration-v2/EventSink.ts';
import * as ServerConfig from '../config.ts';
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitWorkflow from '../git/GitWorkflowService.ts';
import * as LocalComposition from "./composition.ts";
import {
  COPILOT_DEFAULT_INSTANCE_ID,
  makeCopilotSdkAdapterV2,
  type CopilotSdkClientLike,
} from "./sdk-adapter.ts";
import { localCopilotInvocationScope, makeOrchestratorTools, type LocalCopilotToolSession, type LocalToolRunner } from "./tools.ts";
import {loadLocalMcpConfig} from './mcp-config.ts';
import {makeJsonLineWriter,makeEventEnvelope} from './transport.ts';
import {importAttachment} from './attachments.ts';
import {resolveAttachmentPathById} from '../attachmentStore.ts';

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment:local");
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;

interface CliOptions {
  cwd: string;
  dataDir?: string;
  model?: string;
  timeoutMs?: number;
  events?: boolean;
  mcpConfig?: string;
  eventsAfter?: number;
}

interface ParsedArgs {
  readonly command: string;
  readonly options: CliOptions;
  readonly positional: ReadonlyArray<string>;
}

type CallerRecord = LocalCopilotToolSession;

function randomId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function stableId(prefix: string, key: string): string {
  return `${prefix}:cli:${createHash('sha256').update(key).digest('hex')}`;
}

function parseArgs(args: ReadonlyArray<string>): ParsedArgs {
  const [command = "help", ...rest] = args;
  const options: CliOptions = { cwd: process.cwd() };
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === "--cwd") options.cwd = rest[++index] ?? "";
    else if (value === "--data-dir") options.dataDir = rest[++index] ?? "";
    else if (value === "--model") options.model = rest[++index] ?? "";
    else if (value === "--timeout-ms") options.timeoutMs = Number(rest[++index]);
    else if (value === '--events') options.events = true;
    else if (value === '--mcp-config') options.mcpConfig = rest[++index] ?? '';
    else if (value === '--events-after') { options.eventsAfter = Number(rest[++index]); options.events = true; }
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else positional.push(value);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive finite number.");
  }
  if(options.eventsAfter!==undefined&&(!Number.isSafeInteger(options.eventsAfter)||options.eventsAfter<0))throw new Error('--events-after must be a nonnegative safe integer.');
  return { command, options, positional };
}

function helpText(): string {
  return [
    "copilot-orchestrator — local T3 orchestration with GitHub Copilot",
    "",
    "Usage:",
    "  copilot-orchestrator doctor [--cwd PATH]",
    "  copilot-orchestrator models [--cwd PATH]",
    "  copilot-orchestrator run <prompt> [--cwd PATH] [--data-dir PATH] [--model ID] [--timeout-ms MS]",
    "  copilot-orchestrator serve [--cwd PATH] [--data-dir PATH] [--model ID] [--events]",
    "  Additional options: --mcp-config PATH (stdio or loopback MCP tools); --events-after SEQUENCE (replay and follow)",
    "",
    "The default state directory is <cwd>/.copilot-orchestrator. No T3 server or network listener is started.",
    "serve reads newline-delimited JSON requests from stdin and writes matching {id,result|error} responses to stdout.",
  ].join("\n");
}

function resolveOptions(options: CliOptions): CliOptions & { cwd: string; dataDir: string } {
  const cwd = NodePath.resolve(options.cwd || process.cwd());
  const dataDir = NodePath.resolve(options.dataDir || NodePath.join(cwd, ".copilot-orchestrator"));
  return { ...options, cwd, dataDir };
}

function makeClient(cwd: string, dataDir=NodePath.join(cwd,'.copilot-orchestrator')): CopilotClient {
  return new CopilotClient({
    connection: RuntimeConnection.forStdio(),
    workingDirectory: cwd,
    baseDirectory: NodePath.join(dataDir,'copilot'),
    logLevel: "error",
    env: { ...process.env, COPILOT_TELEMETRY_DISABLED: "true" },
  });
}

async function withClient<A>(cwd: string, run: (client: CopilotClient) => Promise<A>, dataDir?:string): Promise<A> {
  const client = makeClient(cwd,dataDir);
  try {
    await client.start();
    return await run(client);
  } finally {
    await client.stop().catch(() => []);
  }
}

async function listModels(client: CopilotClient): Promise<ReadonlyArray<ModelInfo>> {
  const models = await client.listModels();
  if (models.length === 0) throw new Error("Copilot returned no available models.");
  return models;
}

function selectModel(models: ReadonlyArray<ModelInfo>, requested?: string): string {
  const selected = requested ?? process.env.COPILOT_MODEL ??
    (models.some((model) => model.id === "auto") ? "auto" : models[0]?.id);
  if (!selected) throw new Error("No Copilot model is available.");
  if (!models.some((model) => model.id === selected)) {
    throw new Error(`Model '${selected}' is not available. Run 'copilot-orchestrator models' to list choices.`);
  }
  return selected;
}

export async function doctor(options: CliOptions): Promise<void> {
  const resolved = resolveOptions(options);
  const report = await withClient(resolved.cwd, async (client) => {
    const [auth, models] = await Promise.all([client.getAuthStatus(), listModels(client)]);
    return {
      connected: true,
      authenticated: auth.isAuthenticated,
      authType: auth.authType ?? null,
      login: auth.login ?? null,
      status: auth.statusMessage ?? null,
      modelCount: models.length,
      defaultModel: models.some((model) => model.id === "auto") ? "auto" : models[0]?.id,
    };
  }, resolved.dataDir);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.authenticated) throw new Error(report.status ?? "Copilot is not authenticated.");
}

export async function models(options: CliOptions): Promise<void> {
  const resolved = resolveOptions(options);
  await withClient(resolved.cwd, async (client) => {
    const available = await listModels(client);
    for (const model of available) process.stdout.write(`${model.id}\t${model.name}\n`);
  }, resolved.dataDir);
}

async function openHost(options: CliOptions) {
  const resolved = resolveOptions(options);
  const externalMcp=resolved.mcpConfig ? await loadLocalMcpConfig(resolved.mcpConfig) : {};
  await NodeFS.mkdir(resolved.dataDir, { recursive: true });
  const client = makeClient(resolved.cwd,resolved.dataDir);
  let disposeRuntime: (() => Promise<void>) | undefined;
  try {
    await client.start();
    const availableModels = await listModels(client);
    const model = selectModel(availableModels, resolved.model);
    const modelSelection = { instanceId: COPILOT_DEFAULT_INSTANCE_ID, model } satisfies ModelSelection;
    const callers = new Map<string, CallerRecord>();
    let attachmentsDir:string|undefined;
    let mcp: OrchestratorMcpService.OrchestratorMcpService["Service"] | undefined;
    let runEffect: LocalToolRunner = async () => {
      throw new Error("Local orchestrator services are not initialized yet.");
    };
    const adapter = makeCopilotSdkAdapterV2({
      client: client as unknown as CopilotSdkClientLike,
      // All orchestration tools are host callbacks; never configure the
      // composition's placeholder MCP endpoint as if it were a live server.
      mcpServers: () => structuredClone(externalMcp),
      resolveAttachmentPath: attachment=>{
        if(!attachmentsDir)throw new Error('Attachment storage is not initialized.');
        const file=resolveAttachmentPathById({attachmentsDir,attachmentId:attachment.id});
        if(!file)throw new Error('Attachment was not found in this orchestrator state directory.');
        return file;
      },
      tools: (session) => makeOrchestratorTools({
        session,
        service: mcp!,
        runEffect: (effect) => runEffect(effect),
        onCaller: (caller) => callers.set(String(caller.threadId), caller),
      }),
    });
    const runtime = ManagedRuntime.make(LocalComposition.layer({
      cwd: resolved.cwd,
      dataDir: resolved.dataDir,
      provider: {
        adapter,
        model,
        displayName: "GitHub Copilot",
        models: availableModels.map((available) => ({
          slug: available.id,
          name: available.name,
          isCustom: false,
          isDefault: available.id === model,
          capabilities: null,
        })),
      },
    }).pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(Logger.LogToStderr, true),
      Layer.succeed(References.MinimumLogLevel, 'Warn'),
    ))));
    disposeRuntime = runtime.dispose;
    runEffect = (effect) => runtime.runPromise(effect);
    const services = await runtime.runPromise(Effect.gen(function* () {
      return {
        projects: yield* ProjectService.ProjectService,
        orchestrator: yield* Orchestrator.OrchestratorV2,
        threads: yield* ThreadManagementService.ThreadManagementService,
        mcp: yield* OrchestratorMcpService.OrchestratorMcpService,
        git: yield* GitWorkflow.GitWorkflowService,
        eventSink: yield* EventSink.EventSinkV2,
        config: yield* ServerConfig.ServerConfig,
      };
    }));
    const { projects, orchestrator, threads } = services;
    mcp = services.mcp;
    attachmentsDir=services.config.attachmentsDir;
    return {
      client,
      adapter,
      runtime,
      projects,
      orchestrator,
      threads,
      mcp,
      git: services.git,
      eventSink: services.eventSink,
      attachmentsDir: services.config.attachmentsDir,
      model,
      modelSelection,
      dataDir: resolved.dataDir,
      cwd: resolved.cwd,
      callers,
    };
  } catch (error) {
    try {
      await disposeRuntime?.();
    } finally {
      await client.stop().catch(() => []);
    }
    throw error;
  }
}

async function closeHost(host: Awaited<ReturnType<typeof openHost>>): Promise<void> {
  try {
    await host.runtime.dispose();
  } finally {
    const adapter = host.adapter as typeof host.adapter & { close?: () => Promise<void> };
    try {
      if (adapter.close) await adapter.close();
    } finally {
      // The host starts the injected client before the adapter's first turn.
      await host.client.stop().catch(() => []);
    }
  }
}

async function ensureProject(host: Awaited<ReturnType<typeof openHost>>) {
  return host.runtime.runPromise(host.projects.bootstrap({
    commandId: CommandId.make(randomId("project-bootstrap")),
    projectId: ProjectId.make(randomId("project")),
    title: NodePath.basename(host.cwd) || host.cwd,
    workspaceRoot: host.cwd,
    createWorkspaceRootIfMissing: false,
    defaultModelSelection: host.modelSelection,
  }));
}

async function createThread(
  host: Awaited<ReturnType<typeof openHost>>,
  input: { readonly projectId: ProjectId; readonly title: string; readonly prompt?: string; readonly attachments?: ReadonlyArray<ChatAttachment>; readonly worktreePath?: string; readonly branch?: string; readonly clientRequestId?: string; readonly runtimeMode?: RuntimeMode; readonly interactionMode?: ProviderInteractionMode },
) {
  const key = input.clientRequestId ?? randomId('thread-request');
  const threadId = ThreadId.make(stableId('thread', key));
  await host.runtime.runPromise(host.orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "server",
    commandId: CommandId.make(stableId('thread-create', key)),
    threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: host.modelSelection,
    runtimeMode: input.runtimeMode ?? 'approval-required',
    interactionMode: input.interactionMode ?? 'default',
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
  }));
  if (input.prompt !== undefined) {
    const sent = await host.runtime.runPromise(host.threads.sendToThread({
      projectId: input.projectId,
      commandId: CommandId.make(stableId('initial-message', key)),
      threadId,
      messageId: MessageId.make(stableId('message', key)),
      text: input.prompt,
      attachments: input.attachments ?? [],
      modelSelection: host.modelSelection,
      mode: "auto",
      createdBy: "user",
      creationSource: "server",
    }));
    return { threadId, runId: sent.run.id };
  }
  return { threadId, runId: undefined };
}

/** Keep the one-shot host alive until durable app-owned child work settles. */
async function drainManagedWork(
  host: Awaited<ReturnType<typeof openHost>>,
  projectId: ProjectId,
  threadId: ThreadId,
  deadline: number,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (ancestors.has(String(threadId))) throw new Error(`Delegation cycle detected at ${threadId}.`);
  const nextAncestors = new Set(ancestors).add(String(threadId));
  for (;;) {
    const projection = await host.runtime.runPromise(host.threads.getThreadProjection(threadId));
    const activeRun = projection.runs
      .filter(ThreadManagementService.isActiveRun)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (activeRun !== undefined) {
      const timeoutMs = Math.max(1, deadline - Date.now());
      const waited = await host.runtime.runPromise(host.threads.waitForThread({
        projectId,
        threadId,
        runId: activeRun.id,
        timeoutMs,
      }));
      if (waited.timedOut) throw new Error(`Run ${activeRun.id} did not finish before the timeout.`);
      continue;
    }

    for (const task of projection.subagents) {
      if (task.origin !== "app_owned" || task.childThreadId === null) continue;
      await drainManagedWork(host, projectId, task.childThreadId, deadline, nextAncestors);
    }

    const refreshed = await host.runtime.runPromise(host.threads.getThreadProjection(threadId));
    if (refreshed.runs.some(ThreadManagementService.isActiveRun)) continue;
    break;
  }
}

async function runPrompt(options: CliOptions, prompt: string): Promise<void> {
  if (!prompt.trim()) throw new Error("run requires a non-empty prompt.");
  const host = await openHost(options);
  try {
    const { project } = await ensureProject(host);
    const created = await createThread(host, {
      projectId: project.id,
      title: prompt.slice(0, 80),
      prompt,
      runtimeMode:'full-access',
    });
    if (created.runId === undefined) throw new Error("The initial prompt did not create a run.");
    const waited = await host.runtime.runPromise(host.threads.waitForThread({
      projectId: project.id,
      threadId: created.threadId,
      runId: created.runId,
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    }));
    if (waited.timedOut) throw new Error(`Run ${created.runId} did not finish before the timeout.`);
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    await drainManagedWork(host, project.id, created.threadId, deadline);
    const projection = await host.runtime.runPromise(host.threads.getThreadProjection(created.threadId));
    const finalRun = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? waited.run;
    const answer = projection.messages.filter((message) =>
      message.role === "assistant" && message.runId === finalRun?.id,
    ).at(-1)?.text;
    process.stderr.write(`projectId=${project.id} threadId=${created.threadId} runId=${finalRun?.id ?? created.runId}\n`);
    if (answer) process.stdout.write(`${answer}\n`);
    if (finalRun?.status !== "completed") {
      throw new Error(`Run finished with status '${finalRun?.status ?? "unknown"}'.`);
    }
  } finally {
    await closeHost(host);
  }
}

function cliScope(): McpInvocationScope {
  return {
    environmentId: LOCAL_ENVIRONMENT_ID,
    requestNamespace: "copilot-orchestrator-cli",
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
    thread: undefined,
    client: { sessionId: "local-cli", label: "local CLI", runtimeModeCeiling: "full-access" },
  };
}

function activeCallerScope(
  host: Awaited<ReturnType<typeof openHost>>,
  threadId: string,
  providerSessionId?: string,
): McpInvocationScope {
  const caller = host.callers.get(threadId);
  const exactSessionId = providerSessionId ?? caller?.providerSessionId;
  if (!exactSessionId) {
    throw new Error(`Thread ${threadId} has no known Copilot provider session. Provide its exact providerSessionId.`);
  }
  const session = caller?.providerSessionId === exactSessionId ? caller : undefined;
  if (session === undefined) {
    throw new Error("The providerSessionId does not match a session opened by this local host.");
  }
  return localCopilotInvocationScope(session);
}

function requireObject(value: unknown, name = "params"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

async function findThreadProject(host: Awaited<ReturnType<typeof openHost>>, threadId: ThreadId) {
  const projection = await host.runtime.runPromise(host.threads.getThreadProjection(threadId));
  return projection;
}

async function handleRequest(host: Awaited<ReturnType<typeof openHost>>, request: unknown): Promise<unknown> {
  const envelope = requireObject(request, "request");
  const id = envelope.id;
  const method = requireString(envelope, "method");
  const params = envelope.params === undefined ? {} : requireObject(envelope.params);
  if (params.clientRequestId !== undefined &&
    (typeof params.clientRequestId !== 'string' || !params.clientRequestId.trim())) {
    throw new Error('clientRequestId must be a non-empty string.');
  }
  const mutationKey = typeof params.clientRequestId === 'string' ? params.clientRequestId : randomId('request');
  switch (method) {
    case "project.list":
      return host.runtime.runPromise(host.projects.listShells());
    case "project.get": {
      const projectId = ProjectId.make(requireString(params, "projectId"));
      const project = await host.runtime.runPromise(host.projects.getById(projectId));
      return Option.getOrNull(project);
    }
    case "project.create": {
      const title = requireString(params, "title");
      const workspaceRoot = NodePath.resolve(requireString(params, "workspaceRoot"));
      const created = await host.runtime.runPromise(host.projects.bootstrap({
        commandId: CommandId.make(stableId('project-create', mutationKey)),
        projectId: ProjectId.make(stableId('project', mutationKey)),
        title,
        workspaceRoot,
        createWorkspaceRootIfMissing: params.createWorkspaceRootIfMissing === true,
        defaultModelSelection: host.modelSelection,
      }));
      return created;
    }
    case "thread.create": {
      const projectId = ProjectId.make(requireString(params, "projectId"));
      const title = typeof params.title === "string" ? params.title : "New thread";
      const prompt = typeof params.prompt === "string" ? params.prompt : undefined;
      const attachments=Schema.decodeUnknownSync(Schema.Array(ChatAttachment))(params.attachments??[]);
      const limitError=getProviderAttachmentLimitError(attachments);
      if(limitError)throw new Error(limitError);
      if(attachments.length&&!prompt)throw new Error('A prompt is required when attaching files to a new thread.');
      return createThread(host, { projectId, title, ...(prompt === undefined ? {} : { prompt }),
        attachments,
        clientRequestId: mutationKey,
        ...(typeof params.worktreePath === 'string' ? { worktreePath: NodePath.resolve(params.worktreePath) } : {}),
        ...(typeof params.branch === 'string' ? { branch: params.branch } : {}),
        ...(params.runtimeMode === undefined ? {} : { runtimeMode: Schema.decodeUnknownSync(RuntimeMode)(params.runtimeMode) }),
        ...(params.interactionMode === undefined ? {} : { interactionMode: Schema.decodeUnknownSync(ProviderInteractionMode)(params.interactionMode) }),
      });
    }
    case 'thread.list':
      return host.runtime.runPromise(host.mcp.listThreads(cliScope(), Schema.decodeUnknownSync(OrchestratorMcpThreadListInput)(params)));
    case 'worktree.create': {
      const args = Schema.decodeUnknownSync(VcsCreateWorktreeInput)({ ...params, path: params.path ?? null });
      return host.runtime.runPromise(host.git.createWorktree(args));
    }
    case 'attachment.import': {
      const input=Schema.decodeUnknownSync(Schema.Struct({path:Schema.String,name:Schema.optional(Schema.String),mimeType:Schema.optional(Schema.String)}))(params);
      return importAttachment(host.attachmentsDir,{path:input.path,...(input.name===undefined?{}:{name:input.name}),...(input.mimeType===undefined?{}:{mimeType:input.mimeType})});
    }
    case "thread.status": {
      const threadId = ThreadId.make(requireString(params, "threadId"));
      const projection = await findThreadProject(host, threadId);
      return {
        thread: projection.thread,
        latestRun: projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null,
        tasks: projection.subagents,
      };
    }
    case "thread.send": {
      const args = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput)({
        ...params,
        message: params.message,
        threadId: params.threadId,
      });
      return host.runtime.runPromise(host.mcp.sendToThread(cliScope(), {
        ...args,
        clientRequestId: args.clientRequestId ?? randomId("thread-send"),
      }));
    }
    case "thread.wait": {
      const args = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput)(params);
      return host.runtime.runPromise(host.mcp.waitForThread(cliScope(), args));
    }
    case "thread.read": {
      const args = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput)(params);
      const caller = host.callers.get(String(args.threadId));
      const scope = caller ? localCopilotInvocationScope(caller) : cliScope();
      return host.runtime.runPromise(host.mcp.readThread(scope, args));
    }
    case "thread.cancel": {
      const threadId = ThreadId.make(requireString(params, "threadId"));
      return host.runtime.runPromise(host.mcp.interruptThread(cliScope(), {
        threadId,
        ...(typeof params.runId === "string" ? { runId: RunId.make(params.runId) } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        clientRequestId: mutationKey,
      }));
    }
    case "task.delegate": {
      const args = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput)(params);
      const scope = activeCallerScope(host, requireString(params, "threadId"), typeof params.providerSessionId === "string" ? params.providerSessionId : undefined);
      return host.runtime.runPromise(host.mcp.delegateTask(scope, args));
    }
    case "task.status": {
      const args = Schema.decodeUnknownSync(Schema.Struct({ taskId: NodeId }))(params);
      const scope = activeCallerScope(host, requireString(params, "threadId"), typeof params.providerSessionId === "string" ? params.providerSessionId : undefined);
      return host.runtime.runPromise(host.mcp.taskStatus(scope, args.taskId));
    }
    case "task.cancel": {
      const args = Schema.decodeUnknownSync(OrchestratorMcpTaskCancelInput)(params);
      const scope = activeCallerScope(host, requireString(params, "threadId"), typeof params.providerSessionId === "string" ? params.providerSessionId : undefined);
      return host.runtime.runPromise(host.mcp.cancelTask(scope, args));
    }
    case "orchestrator.capabilities": {
      const caller = typeof params.threadId === "string"
        ? activeCallerScope(host, params.threadId, typeof params.providerSessionId === "string" ? params.providerSessionId : undefined)
        : cliScope();
      return host.runtime.runPromise(host.mcp.capabilities(caller));
    }
    case "runtime.respond": {
      const threadId = ThreadId.make(requireString(params, "threadId"));
      const requestId = RuntimeRequestId.make(requireString(params, "requestId"));
      const response = Schema.decodeUnknownSync(Schema.Struct({
        decision: Schema.optional(ProviderApprovalDecision),
        answers: Schema.optional(ProviderUserInputAnswers),
      }))(params);
      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make(stableId('runtime-respond', mutationKey)),
        threadId,
        requestId,
        ...response,
      };
      return host.runtime.runPromise(host.orchestrator.dispatch(command));
    }
    default:
      throw new Error(`Unknown method '${method}'.`);
  }
}

async function serve(options: CliOptions): Promise<void> {
  const host = await openHost(options);
  const pending = new Set<Promise<void>>();
  const write=makeJsonLineWriter(process.stdout);
  const afterSequence=options.eventsAfter ?? await host.runtime.runPromise(host.eventSink.latestSequence());
  const events = options.events ? host.runtime.runFork(host.eventSink.stream({afterSequence,bounded:true}).pipe(
    Stream.runForEach(stored=>Effect.tryPromise(()=>write(makeEventEnvelope(stored)))),
    Effect.catchCause(()=>Effect.promise(()=>write({method:'event',params:{type:'events.resyncRequired',resyncRequired:true,message:'Event subscription ended; resume from your last processed sequence or refresh thread state.'}})).pipe(Effect.ignore)),
  )) : undefined;
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const task = (async () => {
        let id: unknown = null;
        try {
          const request = JSON.parse(line) as Record<string, unknown>;
          id = request.id ?? null;
          const result = await handleRequest(host, request);
          await write({id,result});
        } catch (error) {
          await write({id,error:error instanceof Error ? error.message : String(error)});
        }
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
    }
    await Promise.all([...pending]);
  } finally {
    input.close();
    if (events) await Effect.runPromise(Fiber.interrupt(events));
    await closeHost(host);
  }
}

/** Command-line entry used by bin/copilot-orchestrator.mjs. */
export async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (["help", "--help", "-h"].includes(parsed.command)) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const options = resolveOptions(parsed.options);
  await NodeFS.access(options.cwd);
  switch (parsed.command) {
    case "doctor":
      return doctor(options);
    case "models":
      return models(options);
    case "run":
      return runPrompt(options, parsed.positional.join(" "));
    case "serve":
      return serve(options);
    default:
      throw new Error(`Unknown command '${parsed.command}'.\n\n${helpText()}`);
  }
}
