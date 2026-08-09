import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveComputerUseCommand } from './computer-use.mjs';

test('maps scenario-only wrappers to one launcher plus explicit environment', () => {
  const observe = resolveComputerUseCommand('real-ax-observe');
  assert.equal(observe.script.pathname.endsWith('/cu-real-ax-model-e2e-launcher.mjs'), true);
  assert.deepEqual(observe.env, { MAKA_CU_AX_MODEL_SCENARIO: 'observe-only' });

  const anthropicRecovery = resolveComputerUseCommand('real-ax-anthropic-recovery');
  assert.deepEqual(anthropicRecovery.env, {
    MAKA_CU_MODEL_PROVIDER: 'anthropic',
    MAKA_CU_AX_MODEL_SCENARIO: 'intervention-recovery',
  });
});

test('rejects unknown commands with the canonical command inventory', () => {
  assert.throws(
    () => resolveComputerUseCommand('missing'),
    /Unknown computer-use command 'missing'.*real-ax-model/,
  );
});
