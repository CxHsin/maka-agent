import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import {
  connectExistingRuntimeHost,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostLifecycleState,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import { discoverMarkedStorageRoot } from '@maka/storage/root-authority';
import {
  runtimeHostServiceConfigRevision,
  type ManagedRuntimeHostServiceConfig,
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
    clientDataRoot?: string,
  ) => Promise<{
    readonly pid: number;
    readonly exited: Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>;
  }>;
  readonly discoverRoot: typeof discoverMarkedStorageRoot;
  readonly now: () => number;
  readonly delay: (durationMs: number) => Promise<void>;
}

export class ManagedRuntimeHostServiceUnavailableError extends Error {
  constructor(readonly state: ManagedRuntimeHostServiceState) {
    super(`Managed Runtime Host service is not available (${state.kind})`);
    this.name = 'ManagedRuntimeHostServiceUnavailableError';
  }
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
    return { kind: 'unreachable', reason: connected.reason };
  }
  return { kind: 'unreachable', reason: 'handshake_failed' };
}

export async function startManagedRuntimeHostService(
  config: ManagedRuntimeHostServiceConfig,
  input: {
    readonly entrypoint?: string;
    readonly clientDataRoot?: string;
    readonly timeoutMs?: number;
  } = {},
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<ManagedRuntimeHostServiceStartResult> {
  const deps = managerDeps(overrides, input.entrypoint);
  const initial = await inspectManagedRuntimeHostService(config, deps);
  if (initial.kind === 'running' && initial.lifecycleState === 'ready') {
    return { kind: 'already_running', state: initial };
  }
  if (initial.kind !== 'stopped' && initial.kind !== 'running') {
    return { kind: 'refused', state: initial };
  }

  const child =
    initial.kind === 'stopped' ? await deps.launch(config.id, input.clientDataRoot) : undefined;
  const deadline = deps.now() + (input.timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  while (deps.now() < deadline) {
    const state = await inspectManagedRuntimeHostService(config, deps);
    if (state.kind === 'running' && state.lifecycleState === 'ready') {
      return child ? { kind: 'started', state } : { kind: 'already_running', state };
    }
    if (state.kind === 'running') {
      await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
      continue;
    }
    if (state.kind !== 'stopped') return { kind: 'refused', state };
    if (child) {
      const exit = await settleWithin(child.exited, 0);
      if (exit !== undefined) return { kind: 'startup_failed' };
    }
    await deps.delay(Math.min(SERVICE_TRANSITION_POLL_MS, deadline - deps.now()));
  }
  return { kind: 'startup_failed' };
}

export async function stopManagedRuntimeHostService(
  config: ManagedRuntimeHostServiceConfig,
  input: { readonly timeoutMs?: number } = {},
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<ManagedRuntimeHostServiceStopResult> {
  const deps = managerDeps(overrides);
  const connected = await connectManagedRuntimeHost(config, deps.connect);
  if (connected.kind === 'unavailable' && connected.reason === 'not_registered') {
    return { kind: 'already_stopped' };
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
  await connected.connection.request('host.service.stop', {
    expectedHostEpoch: state.hostEpoch,
  });
  await connected.connection.close().catch(() => undefined);

  const deadline = deps.now() + (input.timeoutMs ?? SERVICE_TRANSITION_TIMEOUT_MS);
  while (deps.now() < deadline) {
    const current = await inspectManagedRuntimeHostService(config, deps);
    if (current.kind === 'stopped') return { kind: 'stopped' };
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

function managerDeps(
  overrides: Partial<RuntimeHostServiceManagerDeps>,
  entrypoint = process.argv[1],
): RuntimeHostServiceManagerDeps {
  return {
    connect: connectExistingRuntimeHost,
    discoverRoot: discoverMarkedStorageRoot,
    launch: (configId, clientDataRoot) =>
      launchManagedRuntimeHostService(entrypoint, configId, clientDataRoot),
    now: Date.now,
    delay: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    ...overrides,
  };
}

function launchManagedRuntimeHostService(
  entrypoint: string | undefined,
  configId: string,
  clientDataRoot?: string,
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
    [entrypoint, 'runtime-host', 'serve', '--managed-config', configId],
    {
      cwd: dirname(isAbsolute(entrypoint) ? entrypoint : process.execPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(clientDataRoot ? { MAKA_RUNTIME_HOST_MANAGED_CLIENT_DATA_ROOT: clientDataRoot } : {}),
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
