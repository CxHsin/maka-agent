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
  assert.doesNotThrow(() =>
    validateOperationalSchemaManifest(OPERATIONAL_SCHEMA_MANIFEST, OPERATIONAL_STATE_READER_EPOCH),
  );
});
