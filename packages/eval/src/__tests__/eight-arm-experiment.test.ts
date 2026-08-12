import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseExperimentSpec } from '../spec.js';

const experiments = new URL('../../experiments/', import.meta.url);

test('eight-arm comparison freezes one cohort and model condition', async () => {
  const eightArm = await load('terminal-bench-2.1-deepseek-v4-flash-eight-arm.json');
  const originalCohort = await load('terminal-bench-2.1-deepseek-v4-flash-four-arm.json');

  assert.equal(eightArm.execution.maxConcurrentTaskGroups, 9);
  assert.deepEqual(eightArm.benchmark, originalCohort.benchmark);
  assert.deepEqual(eightArm.tasks, originalCohort.tasks);
  assert.deepEqual(eightArm.budget, originalCohort.budget);
  assert.deepEqual(eightArm.verifier, { reward: 'reward' });
  assert.equal(eightArm.tasks.length, 89);

  assert.deepEqual(
    eightArm.subjects.map(({ id }) => id),
    ['maka', 'codex', 'claude-code', 'pi', 'reasonix', 'opencode', 'kimi-code', 'zcode'],
  );
  assert.deepEqual(
    Object.fromEntries(eightArm.subjects.map(({ id, credentials }) => [id, credentials])),
    {
      maka: ['DEEPSEEK_API_KEY'],
      codex: ['OPENAI_API_KEY'],
      'claude-code': ['ANTHROPIC_API_KEY'],
      pi: ['OPENAI_API_KEY'],
      reasonix: ['OPENAI_API_KEY'],
      opencode: ['OPENAI_API_KEY'],
      'kimi-code': ['OPENAI_API_KEY'],
      zcode: ['OPENAI_API_KEY'],
    },
  );

  const maka = eightArm.subjects[0];
  assert.equal(maka?.config.model, 'deepseek-v4-flash');
  assert.equal(maka?.config.thinkingLevel, 'max');
  const externalArgs = eightArm.subjects.slice(1).map(({ config }) => config.args);
  assert.ok(
    externalArgs.every(
      (args) =>
        Array.isArray(args) &&
        args[0] === '/opt/maka-agent/packages/eval/dist/harbor-external-subject.js',
    ),
  );
  assert.deepEqual(
    externalArgs.map((args) => (Array.isArray(args) ? args[1] : undefined)),
    ['codex', 'claude-code', 'pi', 'reasonix', 'opencode', 'kimi-code', 'zcode'],
  );

  const mounts = eightArm.executor.config.mounts;
  assert.ok(Array.isArray(mounts));
  assert.deepEqual(
    mounts.map((mount) =>
      mount && typeof mount === 'object' && !Array.isArray(mount) ? mount.sourceEnv : undefined,
    ),
    [
      'MAKA_EVAL_MAKA_BUNDLE_PATH',
      'MAKA_EVAL_NODE_TOOLCHAIN_PATH',
      'MAKA_EVAL_CODEX_TOOLCHAIN_PATH',
      'MAKA_EVAL_CLAUDE_CODE_TOOLCHAIN_PATH',
      'MAKA_EVAL_PI_TOOLCHAIN_PATH',
      'MAKA_EVAL_REASONIX_TOOLCHAIN_PATH',
      'MAKA_EVAL_OPENCODE_TOOLCHAIN_PATH',
      'MAKA_EVAL_KIMI_CODE_TOOLCHAIN_PATH',
      'MAKA_EVAL_ZCODE_TOOLCHAIN_PATH',
    ],
  );
});

async function load(name: string) {
  return parseExperimentSpec(JSON.parse(await readFile(new URL(name, experiments), 'utf8')));
}
