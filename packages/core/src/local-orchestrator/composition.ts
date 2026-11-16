/**
 * Headless, local-only composition for the extracted orchestrator.
 *
 * This module deliberately composes the same orchestration-v2 runtime used by
 * the server.  It supplies only the application services that a transportless
 * process needs: a single provider adapter, an in-process MCP credential
 * registry, and bounded no-op implementations for features that are not part
 * of the local CLI (remote scheduling, secret cards, and provider discovery).
 * No HTTP, WebSocket, relay, tunnel, or remote worker is started here.
 */

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderContinuationRequests from "../orchestration-v2/ProviderContinuationRequests.ts";
import * as ProviderContinuationService from "../orchestration-v2/ProviderContinuationService.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderDriver from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

/** Provider input required by the local composition. */
export interface LocalProviderInput {
  /** The real adapter at the ProviderAdapterV2 seam (Copilot SDK in production). */
  readonly adapter: ProviderAdapter.ProviderAdapterV2Shape;
  /** Model shown to the orchestration target resolver and used for new threads. */
  readonly model: string;
  readonly displayName?: string;
  readonly models?: ReadonlyArray<ServerProviderModel>;
}

export interface LocalOrchestratorCompositionOptions {
  /** Workspace used for project/thread creation and provider runtime policy. */
  readonly cwd: string;
  /** Base directory for this process's state. Never defaults to ~/.t3. */
  readonly dataDir: string;
  readonly provider: LocalProviderInput;
  readonly environmentId?: EnvironmentId;
}

/** Services exposed to a local CLI/runtime boundary. */
export interface LocalOrchestratorServices {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly projects: ProjectService.ProjectService["Service"];
  readonly mcp: OrchestratorMcpService.OrchestratorMcpService["Service"];
}

/** A local context/scope used by MCP service methods from the CLI. */
export const localInvocationScope = (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: import("@t3tools/contracts").ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
}): McpInvocationContext.McpInvocationScope => ({
  environmentId: input.environmentId,
  requestNamespace: "local-cli",
  issuedAt: 0,
  capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
  thread:
    input.threadId === undefined
      ? undefined
      : {
          threadId: input.threadId,
          providerSessionId: `local-mcp:${input.threadId}`,
          providerInstanceId: input.providerInstanceId ?? ProviderInstanceId.make("copilot"),
        },
  client:
    input.threadId === undefined
      ? {
          sessionId: "local-cli",
          label: "local CLI",
          runtimeModeCeiling: "full-access",
        }
      : undefined,
});

const unsupported = (operation: string): Effect.Effect<never> =>
  Effect.die(`The local composition does not provide ${operation}.`);

const makeTextGeneration = () => ({
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Text generation is provided by the Copilot adapter, not the local catalog stub.",
      }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail: "Text generation is provided by the Copilot adapter, not the local catalog stub.",
      }),
    ),
  generateBranchName: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail: "Text generation is provided by the Copilot adapter, not the local catalog stub.",
      }),
    ),
  generateThreadTitle: () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Text generation is provided by the Copilot adapter, not the local catalog stub.",
      }),
    ),
});

const makeProviderSnapshot = (
  input: LocalProviderInput,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
): ServerProvider => {
  const models =
    input.models === undefined || input.models.length === 0
      ? [
          {
            slug: input.model,
            name: input.model,
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ]
      : input.models;
  return {
    instanceId,
    driver,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    continuation: { groupKey: `local:${instanceId}` },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "1970-01-01T00:00:00.000Z",
    availability: "available",
    models,
    slashCommands: [],
    skills: [],
  };
};

const makeProviderShape = (provider: ServerProvider) => ({
  resolveMaintenance: () =>
    Effect.succeed({
      provider: provider.driver,
      packageName: null,
      update: null,
    }),
  getSnapshot: Effect.succeed(provider),
  refresh: Effect.succeed(provider),
  streamChanges: Stream.empty,
  applyUsageLimits: () => Effect.void,
});

const makeProviderInstanceRegistryLayer = (input: LocalProviderInput) => {
  return Layer.effect(
    ProviderInstanceRegistry.ProviderInstanceRegistry,
    Effect.gen(function* () {
      const instanceId = input.adapter.instanceId;
      const provider = makeProviderSnapshot(input, instanceId, input.adapter.driver);
      const providerInstance: ProviderDriver.ProviderInstance = {
        instanceId,
        driverKind: input.adapter.driver,
        continuationIdentity: {
          driverKind: input.adapter.driver,
          continuationKey: `local:${instanceId}`,
        },
        displayName: input.displayName ?? String(input.adapter.driver),
        enabled: true,
        snapshot: makeProviderShape(provider),
        orchestrationAdapter: input.adapter,
        textGeneration: makeTextGeneration(),
      };
      // Keep the local registry's subscription contract real even though the
      // static local catalog never publishes changes. This prevents a caller
      // that eagerly acquires the subscription from hanging forever.
      const changes = yield* PubSub.unbounded<void>();
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes).pipe(Effect.asVoid));
      return ProviderInstanceRegistry.ProviderInstanceRegistry.of({
        getInstance: (id) => Effect.succeed(id === instanceId ? providerInstance : undefined),
        listInstances: Effect.succeed([providerInstance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes),
      });
    }),
  );
};

const makeProviderRegistryLayer = (input: LocalProviderInput) => {
  const instanceId = input.adapter.instanceId;
  const provider = makeProviderSnapshot(input, instanceId, input.adapter.driver);
  const service = ProviderRegistry.ProviderRegistry.of({
    getProviders: Effect.succeed([provider]),
    refresh: () => Effect.succeed([provider]),
    refreshInstance: () => Effect.succeed([provider]),
    refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
    getProviderMaintenanceCapabilitiesForInstance: () =>
      Effect.succeed({ provider: provider.driver, packageName: null, update: null }),
    setProviderMaintenanceActionState: () => Effect.succeed([provider]),
    streamChanges: Stream.empty,
  });
  return Layer.succeed(ProviderRegistry.ProviderRegistry, service);
};

const layerMcpSessionRegistry = (environmentId: EnvironmentId) =>
  Layer.succeed(
    McpSessionRegistry.McpSessionRegistry,
    McpSessionRegistry.McpSessionRegistry.of({
      issue: ({ threadId, providerInstanceId }) =>
        Effect.succeed({
          config: {
            environmentId,
            threadId,
            providerSessionId: `local-mcp:${threadId}`,
            providerInstanceId,
            endpoint: "http://127.0.0.1/mcp",
            authorizationHeader: `Bearer local-only:${threadId}`,
            browserToolsAvailable: false,
            capabilities: new Set<string>(["orchestration"]),
          },
        }),
      resolve: () => Effect.succeed(undefined),
      touch: () => Effect.void,
      revokeProviderSession: () => Effect.void,
      revokeThread: () => Effect.void,
      revokeAll: Effect.void,
    }),
  );

const layerProjectEnrichment = Layer.effect(
  ProjectEnrichmentService.ProjectEnrichmentService,
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<ProjectEnrichmentService.ProjectEnrichmentChange>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes).pipe(Effect.asVoid));
    return ProjectEnrichmentService.ProjectEnrichmentService.of({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        }),
      request: () => Effect.void,
      invalidate: () => Effect.void,
      subscribeChanges: PubSub.subscribe(changes),
    });
  }),
);

/** The schedule/secret surfaces are intentionally explicit no-op boundaries. */
const layerOptionalAppServices = Layer.mergeAll(
  Layer.succeed(
    ScheduledTaskService.ScheduledTaskService,
    ScheduledTaskService.ScheduledTaskService.of({
      list: () => Effect.succeed({ tasks: [] }),
      subscribeList: () => Stream.empty,
      upsert: () => unsupported("scheduled tasks"),
      setEnabled: () => unsupported("scheduled tasks"),
      delete: () => unsupported("scheduled tasks"),
      runNow: () => unsupported("scheduled tasks"),
      rotateWebhookToken: () => unsupported("scheduled tasks"),
      listWebhookDeliveries: () => unsupported("scheduled tasks"),
      getWebhookDelivery: () => unsupported("scheduled tasks"),
      triggerWebhook: () => unsupported("scheduled tasks"),
    }),
  ),
  Layer.succeed(
    SecretRequests.SecretRequests,
    SecretRequests.SecretRequests.of({
      answer: () => unsupported("secret requests"),
      savedRef: () => Effect.succeed(Option.none()),
      consume: () => unsupported("secret requests"),
    }),
  ),
);

/**
 * Thread-title regeneration is optional in a headless process.  Keeping a
 * small source-control facade here avoids loading provider-specific network
 * integrations while preserving the real TextGeneration/worker wiring.
 */
const layerSourceControlProviderRegistry = Layer.succeed(
  SourceControlProviderRegistry.SourceControlProviderRegistry,
  SourceControlProviderRegistry.SourceControlProviderRegistry.of({
    resolveLink: () => Effect.die("Source-control links are unavailable in local mode."),
    get: () => Effect.die("Source-control providers are unavailable in local mode."),
    resolveHandle: () => Effect.die("Source-control providers are unavailable in local mode."),
    resolve: () => Effect.die("Source-control providers are unavailable in local mode."),
    discover: Effect.succeed([]),
  }),
);

/**
 * The local composition keeps Git's durable worktree behavior while omitting
 * the remote/source-control application services.  In particular,
 * `createWorktree` delegates to the same Git driver used by the server and
 * supplies the isolated local worktrees directory when callers omit a path.
 * Methods that require provider remotes/PRs are explicit unsupported edges;
 * they cannot silently fabricate a worktree result.
 */
const layerGitWorkflow = (input: {
  // These layers retain the platform error from their Node-backed process
  // services. Keep the helper generic over that error so callers can pass the
  // concrete graph without forcing an artificial `never` requirement.
  readonly git: Layer.Layer<GitVcsDriver.GitVcsDriver, unknown, never>;
  readonly serverConfig: Layer.Layer<ServerConfig.ServerConfig, unknown, never>;
}) =>
  Layer.effect(
    GitWorkflow.GitWorkflowService,
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const config = yield* ServerConfig.ServerConfig;
      const unsupportedGitWorkflow = (operation: string): Effect.Effect<never> =>
        Effect.die(`The local composition does not provide ${operation}.`);
      const isRepository = (cwd: string) =>
        git
          .execute({
            operation: "local.git.isRepository",
            cwd,
            args: ["rev-parse", "--is-inside-work-tree"],
            allowNonZeroExit: true,
            timeoutMs: 5_000,
            maxOutputBytes: 4_096,
          })
          .pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));
      const localWorktreeOptions = (
        options: GitVcsDriver.CreateWorktreeOptions | undefined,
      ): GitVcsDriver.CreateWorktreeOptions => ({
        ...(options ?? {}),
        worktreesDirectory: options?.worktreesDirectory ?? config.worktreesDir,
      });

      return GitWorkflow.GitWorkflowService.of({
        isRepository,
        hasCommit: (input) =>
          git
            .execute({
              operation: "local.git.hasCommit",
              cwd: input.cwd,
              args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
              allowNonZeroExit: true,
            })
            .pipe(Effect.map((result) => result.exitCode === 0)),
        status: (input) => git.status(input),
        localStatus: (input) => git.status(input),
        remoteStatus: () => unsupportedGitWorkflow("remote Git status"),
        invalidateLocalStatus: () => Effect.void,
        invalidateRemoteStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
        pullCurrentBranch: (cwd) => git.pullCurrentBranch(cwd),
        runStackedAction: () => unsupportedGitWorkflow("stacked Git actions"),
        resolvePullRequest: () => unsupportedGitWorkflow("pull-request resolution"),
        preparePullRequestThread: () => unsupportedGitWorkflow("pull-request threads"),
        listRefs: (input) => git.listRefs(input),
        createWorktree: (createInput, options) =>
          git.createWorktree(createInput, localWorktreeOptions(options)),
        listLocalBranchNames: (cwd) => git.listLocalBranchNames(cwd),
        fetchRemote: (fetchInput) => git.fetchRemote(fetchInput),
        remoteExists: (remoteInput) => git.remoteExists(remoteInput),
        remoteBranchExists: (remoteInput) => git.remoteBranchExists(remoteInput),
        resolveRemoteTrackingCommit: (resolveInput) => git.resolveRemoteTrackingCommit(resolveInput),
        removeWorktree: (removeInput) => git.removeWorktree(removeInput),
        pruneWorktrees: (pruneInput) => git.pruneWorktrees(pruneInput),
        deleteLocalBranch: (deleteInput) => git.deleteLocalBranch(deleteInput),
        createRef: (refInput) => git.createRef(refInput),
        switchRef: (switchInput) => git.switchRef(switchInput),
        renameBranch: (renameInput) => git.renameBranch(renameInput),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(input.git, input.serverConfig)));

/**
 * Build the full local runtime. The returned layer has no network listener;
 * callers own the `ManagedRuntime`/scope and may keep it alive for async work.
 */
export const layer = (options: LocalOrchestratorCompositionOptions) => {
  const environmentId = options.environmentId ?? EnvironmentId.make("environment:local");
  // Build dependency layers together.  `Layer.provide` intentionally hides
  // the dependency output, so a layer such as SqlitePersistence.layerConfig
  // must receive ServerConfig and NodeServices in the same dependency graph.
  const nodePlatform = NodeServices.layer;
  const processRunner = ProcessRunner.layer.pipe(Layer.provide(nodePlatform));
  const platform = Layer.mergeAll(nodePlatform, processRunner);
  const serverConfig = ServerConfig.layerTest(options.cwd, options.dataDir).pipe(
    Layer.provide(platform),
  );
  const persistence = SqlitePersistence.layerConfig.pipe(
    Layer.provide(Layer.mergeAll(serverConfig, platform)),
  );
  const providerInstances = makeProviderInstanceRegistryLayer(options.provider);
  const providerCatalog = makeProviderRegistryLayer(options.provider);
  const providerAdapters = ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
    Layer.provide(providerInstances),
  );
  const vcsProcess = VcsProcess.layer.pipe(Layer.provide(platform));
  const vcsProjectConfig = VcsProjectConfig.layer.pipe(Layer.provide(platform));
  const gitVcs = GitVcsDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(vcsProcess, platform, serverConfig)),
  );
  const gitWorkflow = layerGitWorkflow({ git: gitVcs, serverConfig });
  const vcsRegistry = VcsDriverRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(vcsProcess, vcsProjectConfig, serverConfig, platform)),
  );
  const checkpointStore = CheckpointStore.layer.pipe(
    Layer.provide(Layer.mergeAll(vcsRegistry, serverConfig, platform)),
  );
  const workspacePaths = WorkspacePaths.layer.pipe(
    Layer.provide(Layer.mergeAll(serverConfig, platform)),
  );
  const projectEnrichment = layerProjectEnrichment;
  const projectService = RuntimeLayer.layerProjectService.pipe(
    Layer.provide(Layer.mergeAll(projectEnrichment, workspacePaths, persistence)),
  );
  // RuntimeLayer.layer owns the durable event store, receipts, projections,
  // effect worker, provider sessions, and run execution.  The continuation
  // worker uses the exact exported request queue also used by that layer.
  const runtimeCore = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerMcpSessionRegistry(environmentId),
        layerOptionalAppServices,
        providerCatalog,
        providerInstances,
        ServerSettings.layerTest(),
        layerSourceControlProviderRegistry,
        checkpointStore,
        persistence,
        serverConfig,
        platform,
        projectEnrichment,
        workspacePaths,
        projectService,
        gitWorkflow,
      ),
    ),
  );
  // Keep the public management service explicit.  RuntimeLayer embeds a
  // management layer for its effect executor; rebuilding this facade from the
  // same durable orchestrator makes it available to the headless boundary as
  // well and avoids relying on an implementation layer's hidden output.
  const threadManagement = ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(runtimeCore),
  );
  const continuationWorker = ProviderContinuationService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeCore,
        threadManagement,
        ProviderContinuationRequests.layer,
        IdAllocator.layer,
      ),
    ),
  );
  // RuntimeLayer builds the durable effect executor but intentionally leaves
  // process startup to its host. Start recovery before the daemon claims any
  // outbox item, then keep the worker scoped to ManagedRuntime so send/delegate
  // commands remain live until the caller disposes the runtime.
  const localRuntimeStartup = Layer.effectDiscard(
    Effect.gen(function* () {
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* recovery.recover;
      yield* orchestrator.recoverDelegatedTasks;
      // Shutdown is ordered after the scoped worker's interrupt (the worker is
      // forked below), matching serverRuntimeStartup's process-loss protocol.
      yield* Effect.addFinalizer(() =>
        recovery.prepareForShutdown.pipe(
          Effect.ensuring(providerSessions.shutdown),
          Effect.ignoreCause,
        ),
      );
      yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
    }),
  ).pipe(Layer.provide(runtimeCore));
  const mcpService = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeCore,
        threadManagement,
        layerMcpSessionRegistry(environmentId),
        layerOptionalAppServices,
        providerCatalog,
        providerInstances,
        ServerSettings.layerTest(),
        projectService,
        platform,
        providerAdapters,
      ),
    ),
  );
  const localServices = Layer.mergeAll(
    // Expose the resolved config as part of the local runtime as well. The
    // real Git workflow and a few durable project helpers may request it
    // after construction (for example while recreating a missing worktree).
    serverConfig,
    runtimeCore,
    gitWorkflow,
    projectService,
    threadManagement,
    continuationWorker,
    localRuntimeStartup,
    mcpService,
  );

  // The repeated `provide` calls are deliberate: RuntimeLayer.layer contains
  // internal services whose requirements are not exported as a public server
  // layer. Supplying the shared infrastructure here keeps the graph local and
  // lets Effect memoize one SQL/event-store instance for the whole runtime.
  return localServices;
};
