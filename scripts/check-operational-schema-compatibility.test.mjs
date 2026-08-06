import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateOperationalProbeChanges } from './check-operational-schema-compatibility.mjs';

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

test('requires exactly the new epoch probe when reader compatibility breaks', () => {
  assert.throws(
    () => validateOperationalProbeChanges({ baseEpoch: 1, currentEpoch: 2, changes: [] }),
    /requires a new frozen epoch-2 probe/,
  );
  assert.doesNotThrow(() =>
    validateOperationalProbeChanges({
      baseEpoch: 1,
      currentEpoch: 2,
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
