import { invalidProtocolFrame } from './errors.js';
import {
  requireCount,
  requireEncodedByteLimit,
  requireExactRecord,
  requireId,
  requireRecord,
  requireString,
  requireUtf8String,
} from './codec.js';
import { defineOperation } from './operation-spec.js';
import type { OperationKey } from './operations.js';

export const ACCESS_CREDENTIAL_MAX_GRANTS = 256;
export const ACCESS_CREDENTIAL_QUERY_PAGE_MAX_ITEMS = 16;
export const ACCESS_CREDENTIAL_QUERY_PAGE_MAX_BYTES = 64 * 1024;

export type AccessCredentialPrincipalKind = 'remote_owner' | 'capability_provider';

const ACCESS_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;

export interface AccessCredentialIssueInput {
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export interface AccessCredentialIssueResult {
  readonly credentialId: string;
  readonly deliveryId: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
}

export interface AccessCredentialRevokeInput {
  readonly credentialId: string;
}

export interface AccessCredentialRevokeResult {
  readonly credentialId: string;
  readonly revoked: boolean;
}

export interface AccessCredentialMetadata {
  readonly credentialId: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly principalId: string;
  readonly status: 'active' | 'revoked';
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export type AccessCredentialQueryInput =
  | { readonly kind: 'list_start' }
  | {
      readonly kind: 'list_continue';
      readonly revision: `sha256:${string}`;
      readonly cursor: string;
    };

export type AccessCredentialQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: `sha256:${string}`;
      readonly credentialCount: number;
      readonly credentials: readonly AccessCredentialMetadata[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: `sha256:${string}`;
      readonly actual: `sha256:${string}`;
    };

export const ACCESS_AUTHORITY_OPERATION_SPECS = {
  'access.credential.query': defineOperation<
    AccessCredentialQueryInput,
    AccessCredentialQueryResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialQueryInput,
    decodeOutput: decodeAccessCredentialQueryResult,
  }),
  'access.credential.issue': defineOperation<
    AccessCredentialIssueInput,
    AccessCredentialIssueResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialIssueInput,
    decodeOutput: decodeAccessCredentialIssueResult,
  }),
  'access.credential.revoke': defineOperation<
    AccessCredentialRevokeInput,
    AccessCredentialRevokeResult,
    (typeof ACCESS_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ACCESS_ERRORS,
    decodeInput: decodeAccessCredentialRevokeInput,
    decodeOutput: decodeAccessCredentialRevokeResult,
  }),
} as const;

export function decodeAccessCredentialQueryInput(value: unknown): AccessCredentialQueryInput {
  const record = requireRecord(value, 'access credential query input');
  if (record.kind === 'list_start') {
    requireExactRecord(record, 'access credential list start input', ['kind']);
    return { kind: 'list_start' };
  }
  if (record.kind !== 'list_continue') {
    throw invalidProtocolFrame('Invalid access credential query kind');
  }
  const continuation = requireExactRecord(record, 'access credential list continuation input', [
    'kind',
    'revision',
    'cursor',
  ]);
  return {
    kind: 'list_continue',
    revision: revision(continuation.revision),
    cursor: cursor(continuation.cursor),
  };
}

export function decodeAccessCredentialQueryResult(value: unknown): AccessCredentialQueryResult {
  const record = requireRecord(value, 'access credential query result');
  if (record.kind === 'revision_changed') {
    const changed = requireExactRecord(record, 'access credential revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: revision(changed.expected),
      actual: revision(changed.actual),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid access credential query result');
  const page = requireExactRecord(record, 'access credential query page', [
    'kind',
    'revision',
    'credentialCount',
    'credentials',
    'nextCursor',
  ]);
  if (
    !Array.isArray(page.credentials) ||
    page.credentials.length > ACCESS_CREDENTIAL_QUERY_PAGE_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid access credential query page items');
  }
  const decoded: AccessCredentialQueryResult = {
    kind: 'page',
    revision: revision(page.revision),
    credentialCount: requireCount(page.credentialCount, 'access credential count'),
    credentials: page.credentials.map(decodeAccessCredentialMetadata),
    nextCursor: page.nextCursor === null ? null : cursor(page.nextCursor),
  };
  requireEncodedByteLimit(
    decoded,
    'access credential query result',
    ACCESS_CREDENTIAL_QUERY_PAGE_MAX_BYTES,
  );
  return decoded;
}

export function decodeAccessCredentialIssueInput(value: unknown): AccessCredentialIssueInput {
  const record = requireExactRecord(value, 'access credential issue input', [
    'principalKind',
    'principalId',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
  ]);
  return {
    principalKind: principalKind(record.principalKind),
    principalId: principalId(record.principalId),
    operationGrants: operationGrants(record.operationGrants),
    canPublishClientCapabilities: boolean(
      record.canPublishClientCapabilities,
      'canPublishClientCapabilities',
    ),
    canUseHostPaths: boolean(record.canUseHostPaths, 'canUseHostPaths'),
  };
}

export function decodeAccessCredentialIssueResult(value: unknown): AccessCredentialIssueResult {
  const record = requireExactRecord(value, 'access credential issue result', [
    'credentialId',
    'deliveryId',
    'principalKind',
    'principalId',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
  ]);
  return {
    credentialId: requireId(record.credentialId, 'credentialId'),
    deliveryId: requireId(record.deliveryId, 'deliveryId'),
    principalKind: principalKind(record.principalKind),
    principalId: principalId(record.principalId),
    operationGrants: operationGrants(record.operationGrants),
    canPublishClientCapabilities: boolean(
      record.canPublishClientCapabilities,
      'canPublishClientCapabilities',
    ),
    canUseHostPaths: boolean(record.canUseHostPaths, 'canUseHostPaths'),
  };
}

function principalKind(value: unknown): AccessCredentialPrincipalKind {
  if (value !== 'remote_owner' && value !== 'capability_provider') {
    throw invalidProtocolFrame('Invalid access credential principalKind');
  }
  return value;
}

function decodeAccessCredentialMetadata(value: unknown): AccessCredentialMetadata {
  const record = requireRecord(value, 'access credential metadata');
  const exact = requireExactRecord(record, 'access credential metadata', [
    'credentialId',
    'principalKind',
    'principalId',
    'status',
    'operationGrants',
    'canPublishClientCapabilities',
    'canUseHostPaths',
    'createdAt',
    ...(record.revokedAt === undefined ? [] : ['revokedAt']),
  ]);
  if (exact.status !== 'active' && exact.status !== 'revoked') {
    throw invalidProtocolFrame('Invalid access credential status');
  }
  return {
    credentialId: requireId(exact.credentialId, 'credentialId'),
    principalKind: principalKind(exact.principalKind),
    principalId: principalId(exact.principalId),
    status: exact.status,
    operationGrants: operationGrants(exact.operationGrants),
    canPublishClientCapabilities: boolean(
      exact.canPublishClientCapabilities,
      'canPublishClientCapabilities',
    ),
    canUseHostPaths: boolean(exact.canUseHostPaths, 'canUseHostPaths'),
    createdAt: requireString(exact.createdAt, 'access credential createdAt', 64),
    ...(exact.revokedAt === undefined
      ? {}
      : { revokedAt: requireString(exact.revokedAt, 'access credential revokedAt', 64) }),
  };
}

function revision(value: unknown): `sha256:${string}` {
  const decoded = requireString(value, 'access credential revision', 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(decoded)) {
    throw invalidProtocolFrame('Invalid access credential revision');
  }
  return decoded as `sha256:${string}`;
}

function cursor(value: unknown): string {
  const decoded = requireString(value, 'access credential cursor', 16);
  if (!/^(?:0|[1-9][0-9]{0,14})$/u.test(decoded)) {
    throw invalidProtocolFrame('Invalid access credential cursor');
  }
  return decoded;
}

export function decodeAccessCredentialRevokeInput(value: unknown): AccessCredentialRevokeInput {
  const record = requireExactRecord(value, 'access credential revoke input', ['credentialId']);
  return { credentialId: requireId(record.credentialId, 'credentialId') };
}

export function decodeAccessCredentialRevokeResult(value: unknown): AccessCredentialRevokeResult {
  const record = requireExactRecord(value, 'access credential revoke result', [
    'credentialId',
    'revoked',
  ]);
  return {
    credentialId: requireId(record.credentialId, 'credentialId'),
    revoked: boolean(record.revoked, 'revoked'),
  };
}

function operationGrants(value: unknown): readonly OperationKey[] {
  if (!Array.isArray(value) || value.length > ACCESS_CREDENTIAL_MAX_GRANTS) {
    throw invalidProtocolFrame('Invalid access credential operation grants');
  }
  const grants = value.map((grant) =>
    requireString(grant, 'access credential operation grant', 128),
  );
  if (new Set(grants).size !== grants.length) {
    throw invalidProtocolFrame('Duplicate access credential operation grant');
  }
  return grants as OperationKey[];
}

function principalId(value: unknown): string {
  const principal = requireUtf8String(value, 'access credential principalId', 128);
  if (!/^[A-Za-z0-9_.:-]+$/u.test(principal)) {
    throw invalidProtocolFrame('Invalid access credential principalId');
  }
  return principal;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}
