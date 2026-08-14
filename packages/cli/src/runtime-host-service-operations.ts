import {
  consumeAccessCredentialDelivery,
  readRuntimeHostProjectDetails,
} from '@maka/runtime-host/client';
import {
  REMOTE_OWNER_OPERATION_GRANTS,
  type AccessCredentialMetadata,
  type AccessCredentialQueryInput,
  type AccessCredentialQueryResult,
  type AccessCredentialPrincipalKind,
  type OperationKey,
  type ProjectCatalogProjectDetails,
} from '@maka/runtime-host/protocol';
import type { ManagedRuntimeHostServiceConfig } from './runtime-host-service-catalog.js';
import { RUNTIME_HOST_ACCESS_PRESET_POLICIES } from './runtime-host-access-policy.js';
import { connectManagedRuntimeHostOwner } from './runtime-host-service-manager.js';

export type RuntimeHostPermissionPackId =
  | 'observer'
  | 'terminal-owner'
  | 'desktop-owner'
  | 'capability-provider';

export interface RuntimeHostPermissionPack {
  readonly id: RuntimeHostPermissionPackId;
  readonly name: string;
  readonly description: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export type IssuedRuntimeHostCredentialMetadata = Omit<
  AccessCredentialMetadata,
  'createdAt' | 'revokedAt'
>;

const OBSERVER_GRANTS = [
  'host.status',
  'host.diagnostics.query',
  'project.catalog.query',
  'session.catalog.query',
  'session.turns.query',
  'session.turn_landmarks.query',
  'goal.query',
  'plan.query',
  'usage.query',
] as const satisfies readonly OperationKey[];

export const RUNTIME_HOST_PERMISSION_PACKS = Object.freeze([
  {
    id: 'observer',
    name: 'Observer',
    description: 'Read Host, Project, Session, plan, goal, and usage state',
    principalKind: 'remote_owner',
    operationGrants: OBSERVER_GRANTS,
    canPublishClientCapabilities: false,
    canUseHostPaths: false,
  },
  {
    id: 'terminal-owner',
    name: 'Terminal owner',
    description: 'Run agents and manage normal Runtime Host state without Host paths',
    ...RUNTIME_HOST_ACCESS_PRESET_POLICIES['terminal-client'],
  },
  {
    id: 'desktop-owner',
    name: 'Desktop owner',
    description: 'Terminal owner permissions plus Client Capability publication',
    ...RUNTIME_HOST_ACCESS_PRESET_POLICIES['desktop-client'],
  },
  {
    id: 'capability-provider',
    name: 'Capability provider',
    description: 'Publish and withdraw Client Capabilities only',
    principalKind: 'capability_provider',
    operationGrants: ['host.status', 'client.capability.replace', 'client.capability.unregister'],
    canPublishClientCapabilities: true,
    canUseHostPaths: false,
  },
] as const satisfies readonly RuntimeHostPermissionPack[]);

export async function listManagedRuntimeHostProjects(
  config: ManagedRuntimeHostServiceConfig,
): Promise<readonly ProjectCatalogProjectDetails[]> {
  const connection = await connectManagedRuntimeHostOwner(config);
  try {
    return await readRuntimeHostProjectDetails(connection);
  } finally {
    await connection.close();
  }
}

export async function addManagedRuntimeHostProject(
  config: ManagedRuntimeHostServiceConfig,
  path: string,
): Promise<void> {
  const connection = await connectManagedRuntimeHostOwner(config);
  try {
    await connection.request('project.catalog.mutate', { kind: 'register', path });
  } finally {
    await connection.close();
  }
}

export async function listManagedRuntimeHostCredentials(
  config: ManagedRuntimeHostServiceConfig,
): Promise<readonly AccessCredentialMetadata[]> {
  const connection = await connectManagedRuntimeHostOwner(config);
  try {
    let input: AccessCredentialQueryInput = { kind: 'list_start' };
    const credentials: AccessCredentialMetadata[] = [];
    let revisionRestarts = 0;
    while (true) {
      const result: AccessCredentialQueryResult = await connection.request(
        'access.credential.query',
        input,
      );
      if (result.kind === 'revision_changed') {
        revisionRestarts += 1;
        if (revisionRestarts > 3) {
          throw new Error('Access credential metadata kept changing during the query');
        }
        input = { kind: 'list_start' };
        credentials.length = 0;
        continue;
      }
      credentials.push(...result.credentials);
      if (result.nextCursor === null) return credentials;
      input = {
        kind: 'list_continue' as const,
        revision: result.revision,
        cursor: result.nextCursor,
      };
    }
  } finally {
    await connection.close();
  }
}

export async function issueManagedRuntimeHostCredential(
  config: ManagedRuntimeHostServiceConfig,
  input: {
    readonly principalId: string;
    readonly packId?: RuntimeHostPermissionPackId;
    readonly operationGrants?: readonly OperationKey[];
    readonly canPublishClientCapabilities?: boolean;
    readonly canUseHostPaths?: boolean;
  },
): Promise<{
  readonly metadata: IssuedRuntimeHostCredentialMetadata;
  readonly credential: string;
}> {
  const authority = resolveCredentialAuthority(input);
  const connection = await connectManagedRuntimeHostOwner(config);
  try {
    const issued = await connection.request('access.credential.issue', {
      principalId: input.principalId,
      ...authority,
    });
    const credential = await consumeAccessCredentialDelivery(
      config.rootPath,
      issued.deliveryId,
      issued.credentialId,
    );
    return {
      metadata: {
        credentialId: issued.credentialId,
        principalId: issued.principalId,
        principalKind: issued.principalKind,
        status: 'active',
        operationGrants: issued.operationGrants,
        canPublishClientCapabilities: issued.canPublishClientCapabilities,
        canUseHostPaths: issued.canUseHostPaths,
      },
      credential,
    };
  } finally {
    await connection.close();
  }
}

export async function revokeManagedRuntimeHostCredential(
  config: ManagedRuntimeHostServiceConfig,
  credentialId: string,
): Promise<boolean> {
  const connection = await connectManagedRuntimeHostOwner(config);
  try {
    return (await connection.request('access.credential.revoke', { credentialId })).revoked;
  } finally {
    await connection.close();
  }
}

function resolveCredentialAuthority(input: {
  readonly packId?: RuntimeHostPermissionPackId;
  readonly operationGrants?: readonly OperationKey[];
  readonly canPublishClientCapabilities?: boolean;
  readonly canUseHostPaths?: boolean;
}): Pick<
  RuntimeHostPermissionPack,
  'principalKind' | 'operationGrants' | 'canPublishClientCapabilities' | 'canUseHostPaths'
> {
  if (input.packId !== undefined) {
    const pack = RUNTIME_HOST_PERMISSION_PACKS.find(({ id }) => id === input.packId);
    if (!pack) throw new Error(`Unknown Runtime Host permission pack: ${input.packId}`);
    return {
      principalKind: pack.principalKind,
      operationGrants: pack.operationGrants,
      canPublishClientCapabilities: pack.canPublishClientCapabilities,
      canUseHostPaths: pack.canUseHostPaths,
    };
  }
  const operationGrants = [...new Set(input.operationGrants ?? [])];
  if (operationGrants.length === 0) {
    throw new Error('A custom Runtime Host credential requires at least one operation');
  }
  const allowed = new Set<OperationKey>(REMOTE_OWNER_OPERATION_GRANTS);
  if (operationGrants.some((operation) => !allowed.has(operation))) {
    throw new Error('A custom Runtime Host credential contains a local-owner operation');
  }
  return {
    principalKind: 'remote_owner',
    operationGrants,
    canPublishClientCapabilities: input.canPublishClientCapabilities === true,
    canUseHostPaths: input.canUseHostPaths === true,
  };
}
