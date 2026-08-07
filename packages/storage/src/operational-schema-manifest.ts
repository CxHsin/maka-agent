import { SQLITE_ARTIFACT_SCHEMA_VERSION } from './sqlite-artifact-schema.js';
import { SQLITE_AUTOMATION_SCHEMA_VERSION } from './sqlite-automation-schema.js';
import { SQLITE_CORE_EXECUTION_SCHEMA_VERSION } from './sqlite-core-execution-schema.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';
import { SQLITE_USAGE_SCHEMA_VERSION } from './sqlite-usage-schema.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from './sqlite-workflow-schema.js';
import operationalSchemaHistory from './operational-schema-history.json' with { type: 'json' };

export const OPERATIONAL_STATE_SCHEMA_VERSION = 1;

export type OperationalSchemaCompatibility = 'compatible' | 'breaking';

export interface OperationalSchemaChange {
  readonly version: number;
  readonly compatibility: OperationalSchemaCompatibility;
  readonly minimumReaderEpoch: number;
  readonly summary: string;
}

export interface OperationalSchemaScope {
  readonly scope: string;
  readonly baselineVersion: number;
  readonly currentVersion: number;
  readonly changes: readonly OperationalSchemaChange[];
}

interface OperationalSchemaHistory {
  readonly readerEpoch: number;
  readonly scopes: readonly Omit<OperationalSchemaScope, 'currentVersion'>[];
}

const history = operationalSchemaHistory as OperationalSchemaHistory;
const currentVersions = new Map<string, number>([
  ['runtime', SQLITE_RUNTIME_SCHEMA_VERSION],
  ['session_metadata', SQLITE_SESSION_METADATA_SCHEMA_VERSION],
  ['core_execution', SQLITE_CORE_EXECUTION_SCHEMA_VERSION],
  ['workflow', SQLITE_WORKFLOW_SCHEMA_VERSION],
  ['usage', SQLITE_USAGE_SCHEMA_VERSION],
  ['artifact', SQLITE_ARTIFACT_SCHEMA_VERSION],
  ['automation', SQLITE_AUTOMATION_SCHEMA_VERSION],
  ['operational', OPERATIONAL_STATE_SCHEMA_VERSION],
]);

export const OPERATIONAL_STATE_READER_EPOCH = history.readerEpoch;

/**
 * The epoch-one versions are immutable compatibility anchors. Every later
 * version must append one declaration instead of replacing history.
 */
export const OPERATIONAL_SCHEMA_MANIFEST: readonly OperationalSchemaScope[] = [
  ...history.scopes.map((scope) => ({
    ...scope,
    currentVersion: requireCurrentVersion(scope.scope),
  })),
];

export function validateOperationalSchemaManifest(
  manifest: readonly OperationalSchemaScope[],
  readerEpoch: number,
): void {
  assertPositiveInteger(readerEpoch, 'Operational reader epoch');
  const scopes = new Set<string>();
  let requiredReaderEpoch = 1;
  for (const scope of manifest) {
    if (!scope.scope || scopes.has(scope.scope)) {
      throw new Error(`Operational schema scope is empty or duplicated: ${scope.scope}`);
    }
    scopes.add(scope.scope);
    assertPositiveInteger(scope.baselineVersion, `${scope.scope} baseline version`);
    let expectedVersion = scope.baselineVersion;
    let scopeReaderEpoch = 1;
    for (const change of scope.changes) {
      expectedVersion += 1;
      if (change.version !== expectedVersion) {
        throw new Error(
          `Operational schema ${scope.scope} must declare contiguous version ${expectedVersion}`,
        );
      }
      assertPositiveInteger(
        change.minimumReaderEpoch,
        `${scope.scope} version ${change.version} minimum reader epoch`,
      );
      if (change.compatibility === 'compatible') {
        if (change.minimumReaderEpoch !== scopeReaderEpoch) {
          throw new Error(
            `Compatible operational schema ${scope.scope} version ${change.version} cannot raise its reader epoch`,
          );
        }
      } else if (change.compatibility !== 'breaking') {
        throw new Error(
          `Operational schema ${scope.scope} version ${change.version} compatibility is invalid`,
        );
      } else if (change.minimumReaderEpoch <= scopeReaderEpoch) {
        throw new Error(
          `Breaking operational schema ${scope.scope} version ${change.version} must raise its reader epoch`,
        );
      }
      scopeReaderEpoch = change.minimumReaderEpoch;
      requiredReaderEpoch = Math.max(requiredReaderEpoch, scopeReaderEpoch);
    }
    if (scope.currentVersion !== expectedVersion) {
      throw new Error(
        `Operational schema ${scope.scope} version ${scope.currentVersion} is missing a compatibility declaration for version ${expectedVersion + 1}`,
      );
    }
  }
  if (readerEpoch !== requiredReaderEpoch) {
    throw new Error(
      `Operational reader epoch ${readerEpoch} does not match manifest requirement ${requiredReaderEpoch}`,
    );
  }
}

function requireCurrentVersion(scope: string): number {
  const currentVersion = currentVersions.get(scope);
  if (currentVersion === undefined) {
    throw new Error(`Operational schema scope has no current version: ${scope}`);
  }
  return currentVersion;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}
