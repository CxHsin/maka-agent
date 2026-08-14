import { resolveStorageRoot, tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import type { VerifiedGitRuntimeInput } from '@maka/storage/managed-workspace-owner';
import {
  createExecutionRuntimeHostCompositionSource,
  type ExecutionRuntimeHostCompositionDependencies,
} from './execution-composition-factory.js';
import { RuntimeHostKernel, type RuntimeHostServiceIdentity } from './host-kernel.js';
import { openRuntimeHostAccessAuthority } from './access-authority.js';
import { startRuntimeHostServiceListenerSet } from './listener-set.js';
import type { StartRuntimeHostWebSocketListenerOptions } from './websocket-listener.js';

export interface ExecutionRuntimeHostServiceOptions {
  readonly rootPath: string;
  readonly expectedRootId?: string;
  readonly managedWorkspaceGitRuntime?: VerifiedGitRuntimeInput;
  readonly bundledGitResourcesRoot?: string;
  readonly handshakeTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly serviceIdentity?: RuntimeHostServiceIdentity;
  readonly websocket?: Omit<
    StartRuntimeHostWebSocketListenerOptions,
    'accessAuthority' | 'accept' | 'isReady'
  >;
}

export type ExecutionRuntimeHostServiceDependencies = ExecutionRuntimeHostCompositionDependencies;

export class RuntimeHostRootAlreadyOwnedError extends Error {
  readonly code = 'root_already_owned';

  constructor(readonly rootPath: string) {
    super(`Runtime Host root is already owned: ${rootPath}`);
    this.name = 'RuntimeHostRootAlreadyOwnedError';
  }
}

export class RuntimeHostRootIdentityMismatchError extends Error {
  readonly code = 'root_identity_mismatch';

  constructor(
    readonly expectedRootId: string,
    readonly actualRootId: string,
  ) {
    super('Runtime Host State Root identity does not match the managed service config');
    this.name = 'RuntimeHostRootIdentityMismatchError';
  }
}

export async function startExecutionRuntimeHostService(
  options: ExecutionRuntimeHostServiceOptions,
  dependencies: ExecutionRuntimeHostServiceDependencies = {},
): Promise<RuntimeHostKernel> {
  const composition = await createExecutionRuntimeHostCompositionSource(options, dependencies);
  const capability = await resolveStorageRoot({ path: options.rootPath, kind: 'interactive' });
  if (options.expectedRootId !== undefined && capability.rootId !== options.expectedRootId) {
    throw new RuntimeHostRootIdentityMismatchError(options.expectedRootId, capability.rootId);
  }
  const owner = await tryAcquireStateRootOwner(capability);
  if (!owner) throw new RuntimeHostRootAlreadyOwnedError(capability.canonicalPath);
  try {
    const accessAuthority = await openRuntimeHostAccessAuthority(owner.controlDirectory);
    return await RuntimeHostKernel.start({
      owner,
      lifecycleMode: 'service',
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      shutdownGraceMs: options.shutdownGraceMs,
      serviceIdentity: options.serviceIdentity,
      composition,
      accessAuthority,
      ...(options.websocket
        ? {
            listenerSetFactory: (input) =>
              startRuntimeHostServiceListenerSet(input, {
                ...options.websocket!,
                accessAuthority,
              }),
          }
        : {}),
    });
  } catch (error) {
    if (!owner.closed) await owner.close();
    throw error;
  }
}
