import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import {
  connectExistingRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostLifecycleState,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import {
  discoverMarkedStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  clearRuntimeHostServiceStartAttempt,
  createRuntimeHostServiceCatalog,
  publishRuntimeHostServiceStartAttempt,
  runtimeHostServiceConfigRevision,
  withRuntimeHostServiceConfigOperation,
  type ManagedRuntimeHostServiceConfig,
  type RuntimeHostServiceCatalog,
  type RuntimeHostServiceCatalogDocument,
} from './runtime-host-service-catalog.js';

const SERVICE_TRANSITION_TIMEOUT_MS = 30_000;
const SERVICE_TRANSITION_POLL_MS = 50;
const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

export type ManagedRuntimeHostServiceState =
  | { readonly kind: 'stopped' }
  | {
      readonly kind: 'running';
      readonly hostEpoch: string;
      readonly pid: number;
      readonly lifecycleState: HostLifecycleState;
    }
  | {
      readonly kind: 'stopping';
      readonly hostEpoch: string;
      readonly pid: number;
    }
  | {
      readonly kind: 'root_drift';
      readonly expectedRootId: string;
      readonly actualRootId?: string;
    }
  | {
      readonly kind: 'config_drift';
      readonly hostEpoch: string;
      readonly runningRevision?: string;
      readonly expectedRevision: string;
    }
  | {
      readonly kind: 'external';
      readonly hostEpoch: string;
      readonly serviceConfigId?: string;
    }
  | {
      readonly kind: 'unreachable';
      readonly reason: Exclude<
        ConnectRuntimeHostResult extends infer Result
          ? Result extends { kind: 'unavailable'; reason: infer Reason }
            ? Reason
            : never
          : never,
        'not_registered' | 'root_mismatch'
      >;
      readonly recoverable?: true;
      readonly hostEpoch?: string;
      readonly pid?: number;
    };

export type ManagedRuntimeHostServiceStartResult =
  | {
      readonly kind: 'started';
      readonly state: Extract<ManagedRuntimeHostServiceState, { kind: 'running' }>;
    }
  | {
      readonly kind: 'already_running';
      readonly state: Extract<ManagedRuntimeHostServiceState, { kind: 'running' }>;
    }
  | {
      readonly kind: 'refused';
      readonly state: Exclude<
        ManagedRuntimeHostServiceState,
        { kind: 'running' } | { kind: 'stopped' }
      >;
    }
  | { readonly kind: 'startup_failed' };

export type ManagedRuntimeHostServiceStopResult =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'already_stopped' }
  | {
      readonly kind: 'refused';
      readonly state: Exclude<
        ManagedRuntimeHostServiceState,
        { kind: 'running' } | { kind: 'stopped' }
      >;
    }
  | { readonly kind: 'stop_unconfirmed' };

type RegisteredManagedRuntimeHostServiceState = Extract<
  ManagedRuntimeHostServiceState,
  { kind: 'running' | 'root_drift' | 'config_drift' | 'external' }
>;

interface RuntimeHostServiceManagerDeps {
  readonly connect: typeof connectExistingRuntimeHost;
  readonly launch: (
    configId: string,
    expectedRevision: `sha256:${string}`,
    startAttemptId: string,
    clientDataRoot: string,
  ) => Promise<{
    readonly pid: number;
    readonly exited: Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>;
  }>;
  readonly discoverRoot: typeof discoverMarkedStorageRoot;
  readonly acquireOwner: typeof tryAcquireInteractiveRootOwner;
  readonly clearStartAttempt: typeof clearRuntimeHostServiceStartAttempt;
  readonly publishStartAttempt: typeof publishRuntimeHostServiceStartAttempt;
  readonly readCatalog: (clientDataRoot: string) => Promise<RuntimeHostServiceCatalogDocument>;
  readonly runConfigOperation: typeof withRuntimeHostServiceConfigOperation;
  readonly now: () => number;
  readonly delay: (durationMs: number) => Promise<void>;
}

export class ManagedRuntimeHostServiceUnavailableError extends Error {
  constructor(readonly state: ManagedRuntimeHostServiceState) {
    super(`Managed Runtime Host service is not available (${state.kind})`);
    this.name = 'ManagedRuntimeHostServiceUnavailableError';
  }
}

export async function saveStoppedManagedRuntimeHostServiceConfig(
  catalog: RuntimeHostServiceCatalog,
  current: ManagedRuntimeHostServiceConfig,
  next: ManagedRuntimeHostServiceConfig,
  clientDataRoot: string,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostServiceCatalogDocument> {
  const deps = managerDeps(overrides);
  return withRuntimeHostServiceConfigOperation(clientDataRoot, current.id, async () => {
    const revision = await requireCurrentManagedRuntimeHostServiceConfig(
      current,
      clientDataRoot,
      deps,
    );
    await deps.clearStartAttempt(clientDataRoot, current.id, { configRevision: revision });
    const acquired = await acquireManagedRuntimeHostRootOwner(current, deps);
    if (acquired.kind === 'refused') {
      throw new ManagedRuntimeHostServiceUnavailableError(acquired.state);
    }
    if (!acquired.owner) {
      throw new Error(
        'Runtime Host service config cannot be changed while its State Root is owned',
      );
    }
    try {
      return await catalog.save(next, runtimeHostServiceConfigRevision(current));
    } finally {
      await acquired.owner.close();
    }
  });
}

export async function removeStoppedManagedRuntimeHostServiceConfig(
  catalog: RuntimeHostServiceCatalog,
  config: ManagedRuntimeHostServiceConfig,
  clientDataRoot: string,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostServiceCatalogDocument> {
  const deps = managerDeps(overrides);
  return withRuntimeHostServiceConfigOperation(clientDataRoot, config.id, async () => {
    const revision = await requireCurrentManagedRuntimeHostServiceConfig(
      config,
      clientDataRoot,
      deps,
    );
    await deps.clearStartAttempt(clientDataRoot, config.id, { configRevision: revision });
    const acquired = await acquireManagedRuntimeHostRootOwner(config, deps);
    if (acquired.kind === 'refused') {
      throw new ManagedRuntimeHostServiceUnavailableError(acquired.state);
    }
    if (!acquired.owner) {
      throw new Error(
        'Runtime Host service config cannot be removed while its State Root is owned',
      );
    }
    try {
      return await catalog.remove(config.id, runtimeHostServiceConfigRevision(config));
    } finally {
      await acquired.owner.close();
    }
  });
}

export async function connectManagedRuntimeHostOwner(
  config: ManagedRuntimeHostServiceConfig,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostConnection> {
  const deps = managerDeps(overrides);
  const root = await deps.discoverRoot({ path: config.rootPath }).catch(() => undefined);
  if (!root || root.rootId !== config.expectedRootId) {
    throw new ManagedRuntimeHostServiceUnavailableError({
      kind: 'root_drift',
      expectedRootId: config.expectedRootId,
      ...(root ? { actualRootId: root.rootId } : {}),
    });
  }
  const connected = await connectManagedRuntimeHost(config, deps.connect);
  if (connected.kind !== 'connected') {
    const state = await inspectManagedRuntimeHostService(config, deps);
    throw new ManagedRuntimeHostServiceUnavailableError(state);
  }
  const state = classifyRegistration(config, connected.registration);
  if (state.kind !== 'running' || state.lifecycleState !== 'ready') {
    await connected.connection.close().catch(() => undefined);
    throw new ManagedRuntimeHostServiceUnavailableError(state);
  }
  return connected.connection;
}

export async function inspectManagedRuntimeHostService(
  config: ManagedRuntimeHostServiceConfig,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<ManagedRuntimeHostServiceState> {
  const deps = managerDeps(overrides);
  const root = await deps.discoverRoot({ path: config.rootPath }).catch(() => undefined);
  if (!root) return { kind: 'root_drift', expectedRootId: config.expectedRootId };
  if (root.rootId !== config.expectedRootId) {
    return {
      kind: 'root_drift',
      expectedRootId: config.expectedRootId,
      actualRootId: root.rootId,
    };
  }
  const connected = await connectManagedRuntimeHost(config, deps.connect);
  if (connected.kind === 'connected') {
    try {
      return classifyRegistration(config, connected.registration);
    } finally {
      await connected.connection.close().catch(() => undefined);
    }
  }
  if (connected.kind === 'draining') {
    const classified = classifyRegistration(config, connected.registration);
    return classified.kind === 'running'
      ? {
          kind: 'stopping',
          hostEpoch: classified.hostEpoch,
          pid: classified.pid,
        }
      : classified;
  }
  if (connected.kind === 'unavailable') {
    if (connected.reason === 'not_registered') return { kind: 'stopped' };
    if (connected.reason === 'root_mismatch') {
      return { kind: 'root_drift', expectedRootId: config.expectedRootId };
    }
    if (connected.reason === 'connect_failed' && connected.registration) {
      const classified = classifyRegistration(config, connected.registration);
      if (classified.kind !== 'running') return classified;
      return {
        kind: 'unreachable',
        reason: connected.reason,
        recoverable: true,
        hostEpoch: classified.hostEpoch,
        pid: classified.pid,
      };
    }
    return { kind: 'unreachable', reason: connected.reason };
  }
  return { kind: 'unreachable', reason: 'handshake_failed' };
}

export async function startManagedRuntimeHostService(
  config: ManagedRuntimeHostServiceConfig,
  input: {
    readonly entrypoint?: string;
    readonly clientDataRoot: string;
    readonly timeoutMs?: number;
  },
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<ManagedRuntimeHostServiceStartResult> {
  const deps = managerDeps(overrides, input.entrypoint);
  const deadlineMs = deps.now() + (input.timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  const prepared = await deps.runConfigOperation(input.clientDataRoot, config.id, async () => {
    await requireCurrentManagedRuntimeHostServiceConfig(config, input.clientDataRoot, deps);
    return prepareManagedRuntimeHostServiceStart(config, input.clientDataRoot, deadlineMs, deps);
  });
  return prepared.kind === 'result'
    ? prepared.result
    : waitForManagedRuntimeHostStart(config, input.clientDataRoot, deadlineMs, prepared, deps);
}

type ManagedRuntimeHostServiceStartPreparation =
  | { readonly kind: 'result'; readonly result: ManagedRuntimeHostServiceStartResult }
  | {
      readonly kind: 'wait';
      readonly child?: Awaited<ReturnType<RuntimeHostServiceManagerDeps['launch']>>;
      readonly startAttemptId?: string;
    };

async function prepareManagedRuntimeHostServiceStart(
  config: ManagedRuntimeHostServiceConfig,
  clientDataRoot: string,
  deadlineMs: number,
  deps: RuntimeHostServiceManagerDeps,
): Promise<ManagedRuntimeHostServiceStartPreparation> {
  const initial = await inspectManagedRuntimeHostService(config, deps);
  if (initial.kind === 'running' && initial.lifecycleState === 'ready') {
    return { kind: 'result', result: { kind: 'already_running', state: initial } };
  }
  const recoverable = initial.kind === 'unreachable' && initial.recoverable === true;
  if (initial.kind !== 'stopped' && initial.kind !== 'running' && !recoverable) {
    return { kind: 'result', result: { kind: 'refused', state: initial } };
  }
  if (deps.now() >= deadlineMs) {
    return { kind: 'result', result: { kind: 'startup_failed' } };
  }

  if (initial.kind !== 'stopped' && !recoverable) return { kind: 'wait' };
  const revision = runtimeHostServiceConfigRevision(config);
  const attempt = await deps.publishStartAttempt(
    clientDataRoot,
    config.id,
    revision,
    new Date(deadlineMs).toISOString(),
  );
  try {
    const child = await deps.launch(config.id, revision, attempt.attemptId, clientDataRoot);
    return { kind: 'wait', child, startAttemptId: attempt.attemptId };
  } catch (error) {
    await deps.clearStartAttempt(clientDataRoot, config.id, {
      attemptId: attempt.attemptId,
      configRevision: revision,
    });
    throw error;
  }
}

async function waitForManagedRuntimeHostStart(
  config: ManagedRuntimeHostServiceConfig,
  clientDataRoot: string,
  deadline: number,
  preparation: Extract<ManagedRuntimeHostServiceStartPreparation, { kind: 'wait' }>,
  deps: RuntimeHostServiceManagerDeps,
): Promise<ManagedRuntimeHostServiceStartResult> {
  const { child, startAttemptId } = preparation;
  while (deps.now() < deadline) {
    const state = await inspectManagedRuntimeHostService(config, deps);
    if (state.kind === 'running' && state.lifecycleState === 'ready') {
      return child?.pid === state.pid
        ? { kind: 'started', state }
        : { kind: 'already_running', state };
    }
    if (state.kind === 'running') {
      await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
      continue;
    }
    if (state.kind === 'unreachable' && state.recoverable === true) {
      if (child) {
        const exit = await settleWithin(child.exited, 0);
        if (exit !== undefined) {
          await cancelManagedRuntimeHostStartAttempt(config, clientDataRoot, startAttemptId, deps);
          return { kind: 'startup_failed' };
        }
      }
      await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
      continue;
    }
    if (state.kind !== 'stopped') return { kind: 'refused', state };
    if (child) {
      const exit = await settleWithin(child.exited, 0);
      if (exit !== undefined) {
        await cancelManagedRuntimeHostStartAttempt(config, clientDataRoot, startAttemptId, deps);
        return { kind: 'startup_failed' };
      }
    }
    await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
  }
  await cancelManagedRuntimeHostStartAttempt(config, clientDataRoot, startAttemptId, deps);
  return { kind: 'startup_failed' };
}

async function cancelManagedRuntimeHostStartAttempt(
  config: ManagedRuntimeHostServiceConfig,
  clientDataRoot: string,
  startAttemptId: string | undefined,
  deps: RuntimeHostServiceManagerDeps,
): Promise<void> {
  if (!startAttemptId) return;
  await deps.runConfigOperation(clientDataRoot, config.id, () =>
    deps.clearStartAttempt(clientDataRoot, config.id, {
      attemptId: startAttemptId,
      configRevision: runtimeHostServiceConfigRevision(config),
    }),
  );
}

export async function stopManagedRuntimeHostService(
  config: ManagedRuntimeHostServiceConfig,
  input: { readonly timeoutMs?: number; readonly clientDataRoot: string },
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<ManagedRuntimeHostServiceStopResult> {
  const deps = managerDeps(overrides);
  return deps.runConfigOperation(input.clientDataRoot, config.id, async () => {
    const revision = await requireCurrentManagedRuntimeHostServiceConfig(
      config,
      input.clientDataRoot,
      deps,
    );
    await deps.clearStartAttempt(input.clientDataRoot, config.id, {
      configRevision: revision,
    });
    return stopManagedRuntimeHostServiceLocked(config, input, deps, true);
  });
}

export async function restartManagedRuntimeHostService(
  config: ManagedRuntimeHostServiceConfig,
  input: {
    readonly entrypoint?: string;
    readonly clientDataRoot: string;
    readonly timeoutMs?: number;
  },
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<ManagedRuntimeHostServiceStartResult | ManagedRuntimeHostServiceStopResult> {
  const deps = managerDeps(overrides, input.entrypoint);
  const deadlineMs = deps.now() + (input.timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  const transaction = await deps.runConfigOperation(input.clientDataRoot, config.id, async () => {
    const revision = await requireCurrentManagedRuntimeHostServiceConfig(
      config,
      input.clientDataRoot,
      deps,
    );
    await deps.clearStartAttempt(input.clientDataRoot, config.id, {
      configRevision: revision,
    });
    const stopped = await stopManagedRuntimeHostServiceLocked(config, input, deps, true);
    if (stopped.kind !== 'stopped' && stopped.kind !== 'already_stopped') {
      return { kind: 'stop-result' as const, result: stopped };
    }
    const prepared = await prepareManagedRuntimeHostServiceStart(
      config,
      input.clientDataRoot,
      deadlineMs,
      deps,
    );
    return { kind: 'start' as const, prepared };
  });
  if (transaction.kind === 'stop-result') return transaction.result;
  return transaction.prepared.kind === 'result'
    ? transaction.prepared.result
    : waitForManagedRuntimeHostStart(
        config,
        input.clientDataRoot,
        deadlineMs,
        transaction.prepared,
        deps,
      );
}

async function stopManagedRuntimeHostServiceLocked(
  config: ManagedRuntimeHostServiceConfig,
  input: { readonly timeoutMs?: number },
  deps: RuntimeHostServiceManagerDeps,
  requireOwnerProof: boolean,
): Promise<ManagedRuntimeHostServiceStopResult> {
  const connected = await connectManagedRuntimeHost(config, deps.connect);
  if (connected.kind === 'unavailable' && connected.reason === 'not_registered') {
    if (!requireOwnerProof) return { kind: 'already_stopped' };
    const proof = await confirmManagedRuntimeHostRootIsUnowned(config, deps);
    return proof.kind === 'refused'
      ? { kind: 'refused', state: proof.state }
      : proof.confirmed
        ? { kind: 'already_stopped' }
        : { kind: 'stop_unconfirmed' };
  }
  if (connected.kind === 'draining') {
    const state = classifyRegistration(config, connected.registration);
    return state.kind === 'running'
      ? waitForManagedRuntimeHostStop(config, input.timeoutMs, deps, requireOwnerProof)
      : { kind: 'refused', state };
  }
  if (connected.kind !== 'connected') {
    const state = await inspectManagedRuntimeHostService(config, deps);
    return state.kind === 'stopped'
      ? { kind: 'already_stopped' }
      : state.kind === 'running'
        ? { kind: 'stop_unconfirmed' }
        : { kind: 'refused', state };
  }

  const state = classifyRegistration(config, connected.registration);
  if (state.kind !== 'running') {
    await connected.connection.close().catch(() => undefined);
    return { kind: 'refused', state };
  }
  try {
    await connected.connection.request('host.service.stop', {
      expectedHostEpoch: state.hostEpoch,
    });
  } catch (error) {
    if (
      !(
        (error instanceof RuntimeHostOperationError && error.code === 'host_draining') ||
        (error instanceof RuntimeHostRequestInterruptedError && error.dispatch === 'dispatched')
      )
    ) {
      throw error;
    }
  } finally {
    await connected.connection.close().catch(() => undefined);
  }

  return waitForManagedRuntimeHostStop(config, input.timeoutMs, deps, requireOwnerProof);
}

async function waitForManagedRuntimeHostStop(
  config: ManagedRuntimeHostServiceConfig,
  timeoutMs: number | undefined,
  deps: RuntimeHostServiceManagerDeps,
  requireOwnerProof: boolean,
): Promise<ManagedRuntimeHostServiceStopResult> {
  const deadline = deps.now() + (timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  while (deps.now() < deadline) {
    const current = await inspectManagedRuntimeHostService(config, deps);
    if (current.kind === 'stopped') {
      if (!requireOwnerProof) return { kind: 'stopped' };
      const proof = await confirmManagedRuntimeHostRootIsUnowned(config, deps);
      if (proof.kind === 'refused') return { kind: 'refused', state: proof.state };
      if (proof.confirmed) return { kind: 'stopped' };
      await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
      continue;
    }
    if (current.kind === 'stopping') {
      await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
      continue;
    }
    if (current.kind !== 'running') return { kind: 'refused', state: current };
    await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
  }
  return { kind: 'stop_unconfirmed' };
}

function classifyRegistration(
  config: ManagedRuntimeHostServiceConfig,
  registration: HostRegistration,
): RegisteredManagedRuntimeHostServiceState {
  if (registration.rootId !== config.expectedRootId) {
    return {
      kind: 'root_drift',
      expectedRootId: config.expectedRootId,
      actualRootId: registration.rootId,
    };
  }
  if (registration.lifecycleMode !== 'service' || registration.serviceConfigId !== config.id) {
    return {
      kind: 'external',
      hostEpoch: registration.hostEpoch,
      ...(registration.serviceConfigId ? { serviceConfigId: registration.serviceConfigId } : {}),
    };
  }
  const expectedRevision = runtimeHostServiceConfigRevision(config);
  if (registration.serviceConfigRevision !== expectedRevision) {
    return {
      kind: 'config_drift',
      hostEpoch: registration.hostEpoch,
      ...(registration.serviceConfigRevision
        ? { runningRevision: registration.serviceConfigRevision }
        : {}),
      expectedRevision,
    };
  }
  return {
    kind: 'running',
    hostEpoch: registration.hostEpoch,
    pid: registration.pid,
    lifecycleState: registration.state,
  };
}

async function requireCurrentManagedRuntimeHostServiceConfig(
  config: ManagedRuntimeHostServiceConfig,
  clientDataRoot: string,
  deps: RuntimeHostServiceManagerDeps,
): Promise<`sha256:${string}`> {
  const expectedRevision = runtimeHostServiceConfigRevision(config);
  const catalog = await deps.readCatalog(clientDataRoot);
  const current = catalog.configs.find(({ id }) => id === config.id);
  if (!current || runtimeHostServiceConfigRevision(current) !== expectedRevision) {
    throw new Error('Runtime Host service config changed before the operation started');
  }
  return expectedRevision;
}

async function connectManagedRuntimeHost(
  config: ManagedRuntimeHostServiceConfig,
  connect: typeof connectExistingRuntimeHost,
): Promise<ConnectRuntimeHostResult> {
  try {
    return await connect({
      rootPath: config.rootPath,
      surface: 'inspect',
      protocol: CURRENT_PROTOCOL,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      connectTimeoutMs: 250,
      handshakeTimeoutMs: 1_000,
    });
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: causedByNodeError(error, 'ENOENT') ? 'not_registered' : 'connect_failed',
    };
  }
}

function causedByNodeError(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return false;
    if ('code' in current && (current as NodeJS.ErrnoException).code === code) return true;
    current = current.cause;
  }
  return false;
}

type ManagedRuntimeHostRootOwnerAcquisition =
  | { readonly kind: 'acquired'; readonly owner?: InteractiveRootOwner }
  | {
      readonly kind: 'refused';
      readonly state: Extract<ManagedRuntimeHostServiceState, { kind: 'root_drift' }>;
    };

async function acquireManagedRuntimeHostRootOwner(
  config: ManagedRuntimeHostServiceConfig,
  deps: RuntimeHostServiceManagerDeps,
): Promise<ManagedRuntimeHostRootOwnerAcquisition> {
  const root = await deps.discoverRoot({ path: config.rootPath }).catch(() => undefined);
  if (!root || root.rootId !== config.expectedRootId) {
    return {
      kind: 'refused',
      state: {
        kind: 'root_drift',
        expectedRootId: config.expectedRootId,
        ...(root ? { actualRootId: root.rootId } : {}),
      },
    };
  }
  const owner = await deps.acquireOwner(root);
  return { kind: 'acquired', ...(owner ? { owner } : {}) };
}

async function confirmManagedRuntimeHostRootIsUnowned(
  config: ManagedRuntimeHostServiceConfig,
  deps: RuntimeHostServiceManagerDeps,
): Promise<
  | { readonly kind: 'confirmed'; readonly confirmed: true }
  | { readonly kind: 'busy'; readonly confirmed: false }
  | Extract<ManagedRuntimeHostRootOwnerAcquisition, { kind: 'refused' }>
> {
  const acquired = await acquireManagedRuntimeHostRootOwner(config, deps);
  if (acquired.kind === 'refused') return acquired;
  if (!acquired.owner) return { kind: 'busy', confirmed: false };
  await acquired.owner.close();
  return { kind: 'confirmed', confirmed: true };
}

function managerDeps(
  overrides: Partial<RuntimeHostServiceManagerDeps>,
  entrypoint = process.argv[1],
): RuntimeHostServiceManagerDeps {
  return {
    connect: connectExistingRuntimeHost,
    acquireOwner: tryAcquireInteractiveRootOwner,
    clearStartAttempt: clearRuntimeHostServiceStartAttempt,
    discoverRoot: discoverMarkedStorageRoot,
    launch: (configId, expectedRevision, startAttemptId, clientDataRoot) =>
      launchManagedRuntimeHostService(
        entrypoint,
        configId,
        expectedRevision,
        startAttemptId,
        clientDataRoot,
      ),
    now: Date.now,
    publishStartAttempt: publishRuntimeHostServiceStartAttempt,
    readCatalog: (clientDataRoot) => createRuntimeHostServiceCatalog(clientDataRoot).read(),
    runConfigOperation: withRuntimeHostServiceConfigOperation,
    delay: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    ...overrides,
  };
}

function launchManagedRuntimeHostService(
  entrypoint: string | undefined,
  configId: string,
  expectedRevision: `sha256:${string}`,
  startAttemptId: string,
  clientDataRoot: string,
): Promise<{
  readonly pid: number;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}> {
  if (!entrypoint) throw new Error('Unable to locate the Maka CLI entrypoint');
  const env = { ...process.env };
  delete env.MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL;
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      'runtime-host',
      'serve',
      '--managed-config',
      configId,
      '--expected-config-revision',
      expectedRevision,
      '--start-attempt',
      startAttemptId,
    ],
    {
      cwd: dirname(isAbsolute(entrypoint) ? entrypoint : process.execPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        MAKA_RUNTIME_HOST_MANAGED_CLIENT_DATA_ROOT: clientDataRoot,
      },
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('Managed Runtime Host did not receive a process id'));
        return;
      }
      child.unref();
      resolve({ pid, exited });
    });
    child.once('error', reject);
  });
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let settleTimeout: (() => void) | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    settleTimeout = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    settleTimeout?.();
  }
}
