import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPERATIONAL_SCHEMA_MANIFEST,
  OPERATIONAL_STATE_READER_EPOCH,
  validateOperationalSchemaManifest,
} from '../operational-schema-manifest.js';

const EPOCH_ONE_BASELINE_VERSIONS = new Map<string, number>([
  ['runtime', 11],
  ['session_metadata', 22],
  ['core_execution', 1],
  ['workflow', 3],
  ['usage', 3],
  ['artifact', 1],
  ['automation', 1],
  ['operational', 1],
]);

test('freezes every operational scope at the epoch-one compatibility baseline', () => {
  assert.deepEqual(
    new Map(OPERATIONAL_SCHEMA_MANIFEST.map((scope) => [scope.scope, scope.baselineVersion])),
    EPOCH_ONE_BASELINE_VERSIONS,
  );
});

test('requires every post-baseline schema version to declare compatibility and reader epoch', () => {
  const [runtime, ...otherScopes] = OPERATIONAL_SCHEMA_MANIFEST;
  assert.throws(
    () =>
      validateOperationalSchemaManifest(
        [{ ...runtime!, currentVersion: runtime!.currentVersion + 1 }, ...otherScopes],
        OPERATIONAL_STATE_READER_EPOCH,
      ),
    /missing a compatibility declaration/,
  );
});

test('rejects a compatible declaration that raises its reader epoch', () => {
  const [runtime, ...otherScopes] = OPERATIONAL_SCHEMA_MANIFEST;
  assert.throws(
    () =>
      validateOperationalSchemaManifest(
        [
          {
            ...runtime!,
            currentVersion: runtime!.currentVersion + 1,
            changes: [
              {
                version: runtime!.currentVersion + 1,
                compatibility: 'compatible',
                minimumReaderEpoch: 2,
                summary: 'invalid compatible change',
              },
            ],
          },
          ...otherScopes,
        ],
        2,
      ),
    /cannot raise its reader epoch/,
  );
});

test('requires a breaking declaration to raise the global reader epoch', () => {
  const [runtime, ...otherScopes] = OPERATIONAL_SCHEMA_MANIFEST;
  assert.throws(
    () =>
      validateOperationalSchemaManifest(
        [
          {
            ...runtime!,
            currentVersion: runtime!.currentVersion + 1,
            changes: [
              {
                version: runtime!.currentVersion + 1,
                compatibility: 'breaking',
                minimumReaderEpoch: 2,
                summary: 'breaking change',
              },
            ],
          },
          ...otherScopes,
        ],
        1,
      ),
    /does not match manifest requirement 2/,
  );
});
