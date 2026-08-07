import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseOperationalProbeChanges,
  validateCurrentProbeTestSource,
  validateOperationalSchemaHistory,
  validateOperationalProbeChanges,
} from './check-operational-schema-compatibility.mjs';

const epochOneProbe = 'packages/storage/src/__tests__/fixtures/operational-epoch-1-probe.ts';

test('keeps every existing operational epoch probe immutable', () => {
  for (const status of ['M', 'D']) {
    assert.throws(
      () =>
        validateOperationalProbeChanges({
          baseEpoch: 1,
          currentEpoch: 1,
          changes: [{ status, path: epochOneProbe }],
        }),
      /cannot be modified or deleted/,
    );
  }
});

test('treats the old side of a rename as deleting a frozen probe', () => {
  const changes = parseOperationalProbeChanges(
    `R100\t${epochOneProbe}\tpackages/storage/src/__tests__/fixtures/renamed-probe.ts\n`,
  );
  assert.throws(
    () => validateOperationalProbeChanges({ baseEpoch: 1, currentEpoch: 1, changes }),
    /cannot be modified or deleted/,
  );
});

test('requires exactly the new epoch probe when reader compatibility breaks', () => {
  assert.throws(
    () =>
      validateOperationalProbeChanges({
        baseEpoch: 1,
        currentEpoch: 2,
        baseBreakingChanges: 0,
        currentBreakingChanges: 1,
        changes: [],
      }),
    /requires a new frozen epoch-2 probe/,
  );
  assert.doesNotThrow(() =>
    validateOperationalProbeChanges({
      baseEpoch: 1,
      currentEpoch: 2,
      baseBreakingChanges: 0,
      currentBreakingChanges: 1,
      changes: [
        {
          status: 'A',
          path: 'packages/storage/src/__tests__/fixtures/operational-epoch-2-probe.ts',
        },
      ],
    }),
  );
});

test('rejects adding a probe without changing the reader epoch', () => {
  assert.throws(
    () =>
      validateOperationalProbeChanges({
        baseEpoch: 1,
        currentEpoch: 1,
        changes: [
          {
            status: 'A',
            path: 'packages/storage/src/__tests__/fixtures/operational-epoch-2-probe.ts',
          },
        ],
      }),
    /requires a reader epoch increase/,
  );
});

test('requires a new breaking declaration and epoch increase together', () => {
  assert.throws(
    () =>
      validateOperationalProbeChanges({
        baseEpoch: 1,
        currentEpoch: 1,
        baseBreakingChanges: 0,
        currentBreakingChanges: 1,
        changes: [],
      }),
    /must raise the reader epoch/,
  );
  assert.throws(
    () =>
      validateOperationalProbeChanges({
        baseEpoch: 1,
        currentEpoch: 2,
        baseBreakingChanges: 0,
        currentBreakingChanges: 0,
        changes: [
          {
            status: 'A',
            path: 'packages/storage/src/__tests__/fixtures/operational-epoch-2-probe.ts',
          },
        ],
      }),
    /requires a new breaking declaration/,
  );
});

test('keeps published operational schema history append-only', () => {
  const baseScopes = [
    {
      scope: 'runtime',
      baselineVersion: 11,
      changes: [
        {
          version: 12,
          compatibility: 'breaking',
          minimumReaderEpoch: 2,
          summary: 'published change',
        },
      ],
    },
  ];
  assert.throws(
    () =>
      validateOperationalSchemaHistory({
        baseScopes,
        currentScopes: [
          {
            ...baseScopes[0],
            changes: [
              {
                ...baseScopes[0].changes[0],
                compatibility: 'compatible',
                minimumReaderEpoch: 1,
              },
              {
                version: 13,
                compatibility: 'breaking',
                minimumReaderEpoch: 2,
                summary: 'replacement change',
              },
            ],
          },
        ],
      }),
    /cannot rewrite published version 12/,
  );
});

test('allows operational schema history to append new declarations', () => {
  const baseScopes = [{ scope: 'runtime', baselineVersion: 11, changes: [] }];
  assert.doesNotThrow(() =>
    validateOperationalSchemaHistory({
      baseScopes,
      currentScopes: [
        {
          ...baseScopes[0],
          changes: [
            {
              version: 12,
              compatibility: 'compatible',
              minimumReaderEpoch: 1,
              summary: 'new declaration',
            },
          ],
        },
      ],
    }),
  );
});

test('requires the probe test to select the current reader epoch', () => {
  assert.throws(
    () =>
      validateCurrentProbeTestSource(
        "new URL('./fixtures/operational-epoch-1-probe.js', import.meta.url)",
      ),
    /current reader epoch/,
  );
  assert.doesNotThrow(() =>
    validateCurrentProbeTestSource(
      'new URL(`./fixtures/operational-epoch-${OPERATIONAL_STATE_READER_EPOCH}-probe.js`, import.meta.url)',
    ),
  );
});
