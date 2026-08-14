import {
  REMOTE_OWNER_OPERATION_GRANTS,
  type AccessCredentialPrincipalKind,
  type OperationKey,
} from '@maka/runtime-host/protocol';

export type RuntimeHostAccessPreset = 'desktop-client' | 'terminal-client';

export interface RuntimeHostCredentialAuthorityPolicy {
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

const CLIENT_CAPABILITY_PUBLICATION_OPERATIONS = new Set<OperationKey>([
  'client.capability.replace',
  'client.capability.unregister',
]);

const TERMINAL_CLIENT_POLICY = credentialPolicy({
  operationGrants: REMOTE_OWNER_OPERATION_GRANTS.filter(
    (operation) => !CLIENT_CAPABILITY_PUBLICATION_OPERATIONS.has(operation),
  ),
  canPublishClientCapabilities: false,
});

const DESKTOP_CLIENT_POLICY = credentialPolicy({
  operationGrants: REMOTE_OWNER_OPERATION_GRANTS,
  canPublishClientCapabilities: true,
});

export const RUNTIME_HOST_ACCESS_PRESET_POLICIES = Object.freeze({
  'terminal-client': TERMINAL_CLIENT_POLICY,
  'desktop-client': DESKTOP_CLIENT_POLICY,
} satisfies Readonly<Record<RuntimeHostAccessPreset, RuntimeHostCredentialAuthorityPolicy>>);

export function resolveRuntimeHostAccessPreset(
  preset: RuntimeHostAccessPreset,
): RuntimeHostCredentialAuthorityPolicy {
  return RUNTIME_HOST_ACCESS_PRESET_POLICIES[preset];
}

function credentialPolicy(input: {
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
}): RuntimeHostCredentialAuthorityPolicy {
  return Object.freeze({
    principalKind: 'remote_owner',
    operationGrants: Object.freeze([...input.operationGrants]),
    canPublishClientCapabilities: input.canPublishClientCapabilities,
    canUseHostPaths: false,
  });
}
