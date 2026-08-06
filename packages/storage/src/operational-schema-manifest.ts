import { SQLITE_ARTIFACT_SCHEMA_VERSION } from './sqlite-artifact-schema.js';
import { SQLITE_AUTOMATION_SCHEMA_VERSION } from './sqlite-automation-schema.js';
import { SQLITE_CORE_EXECUTION_SCHEMA_VERSION } from './sqlite-core-execution-schema.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';
import { SQLITE_USAGE_SCHEMA_VERSION } from './sqlite-usage-schema.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from './sqlite-workflow-schema.js';

export const OPERATIONAL_STATE_READER_EPOCH = 1;
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

/**
 * The epoch-one versions are immutable compatibility anchors. Every later
 * version must append one declaration instead of replacing history.
 */
export const OPERATIONAL_SCHEMA_MANIFEST: readonly OperationalSchemaScope[] = [
  schemaScope('runtime', 11, SQLITE_RUNTIME_SCHEMA_VERSION),
  schemaScope('session_metadata', 22, SQLITE_SESSION_METADATA_SCHEMA_VERSION),
  schemaScope('core_execution', 1, SQLITE_CORE_EXECUTION_SCHEMA_VERSION),
  schemaScope('workflow', 3, SQLITE_WORKFLOW_SCHEMA_VERSION),
  schemaScope('usage', 3, SQLITE_USAGE_SCHEMA_VERSION),
  schemaScope('artifact', 1, SQLITE_ARTIFACT_SCHEMA_VERSION),
  schemaScope('automation', 1, SQLITE_AUTOMATION_SCHEMA_VERSION),
  schemaScope('operational', 1, OPERATIONAL_STATE_SCHEMA_VERSION),
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

function schemaScope(
  scope: string,
  baselineVersion: number,
  currentVersion: number,
): OperationalSchemaScope {
  return { scope, baselineVersion, currentVersion, changes: [] };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}
