import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runMakaEvalCli } from '../cli.js';
import { expandExperiment } from '../experiment.js';
import { createExternalSubjectAdapter } from '../external-subject.js';
import { createMakaSubjectAdapter } from '../maka-subject.js';
import type { ExperimentExecutor, SubjectAdapter } from '../runner.js';
import { parseExperimentSpec } from '../spec.js';

const execFileAsync = promisify(execFile);

test('maka eval publishes only immutable attempts from one spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-cli-'));
  const specPath = join(root, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec()));
  const output: string[] = [];
  const executor: ExperimentExecutor = {
    kind: 'harbor',
    runAttempt: async (_input, operation) => ({
      kind: 'settled',
      value: await operation({
        context: {
          cwd: '/app',
          taskInput: 'solve',
          metadata: {},
          execute: async () => ({ termination: 'exited', exitCode: 0, stdout: '' }),
        },
        verify: async () => ({
          status: 'completed',
          score: 1,
          failureReason: null,
          artifacts: [],
        }),
      }),
    }),
  };
  const subject: SubjectAdapter = {
    kind: 'maka',
    execute: async () => ({
      usage: null,
      costUsd: null,
      durationMs: 1,
      status: 'completed',
      failureReason: null,
      artifacts: [],
    }),
  };

  assert.equal(
    await runMakaEvalCli(['run', specPath, '--out', join(root, 'run')], {
      loadExecutor: () => executor,
      subjects: [subject],
      stdout: (text) => output.push(text),
      stderr: assert.fail,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(output[0] ?? ''), {
    experimentId: 'cli-test',
    cells: 1,
    incomplete: 0,
  });
  await assert.rejects(stat(join(root, 'run', 'results.json')), { code: 'ENOENT' });
});

test('competitor wrapper installs declared containment and provider policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-profiles-'));
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const env = { ...process.env, OPENAI_API_KEY: 'test-only-secret' };
  await execFileAsync(
    process.execPath,
    [wrapper.pathname, 'codex', 'https://provider.test', root, '/usr/bin/true'],
    { env },
  );
  await execFileAsync(
    process.execPath,
    [wrapper.pathname, 'zcode', 'https://provider.test/v1', root, '/usr/bin/true'],
    { env },
  );
  await execFileAsync(
    process.execPath,
    [wrapper.pathname, 'claude-code', 'https://provider.test', root, '/usr/bin/true'],
    { env },
  );
  await execFileAsync(
    process.execPath,
    [
      wrapper.pathname,
      'reasonix',
      'https://provider.test',
      root,
      '/usr/bin/true',
      '--model',
      'maka-proxy/model',
      '--effort',
      'max',
    ],
    { env },
  );

  assert.match(await readFile(join(root, 'etc/codex/requirements.toml'), 'utf8'), /disabled/u);
  assert.match(
    await readFile(join(root, 'etc/claude-code/managed-settings.json'), 'utf8'),
    /WebSearch/u,
  );
  assert.match(
    await readFile(join(root, 'tmp/maka-eval-reasonix/config.toml'), 'utf8'),
    /bash = "off"/u,
  );
  await assert.rejects(stat(join(root, 'tmp/maka-eval-reasonix/.env')), { code: 'ENOENT' });
  const zcode = JSON.parse(
    await readFile(join(root, 'tmp/maka-eval-zcode/.zcode/cli/config.json'), 'utf8'),
  );
  assert.equal(zcode.model, 'deepseek/deepseek-v4-flash');
  assert.equal(zcode.provider.deepseek.models['deepseek-v4-flash'].reasoning.defaultLevel, 'max');
});

test('competitor wrapper publishes one newline-terminated result envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-result-envelope-'));
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const { stdout } = await execFileAsync(
    process.execPath,
    [wrapper.pathname, 'codex', 'https://provider.test', root, '/usr/bin/true'],
    { env: { ...process.env, OPENAI_API_KEY: 'test-only-secret' } },
  );

  assert.equal(stdout.endsWith('\n'), true);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(stdout).schemaVersion, 'maka.external_subject_result.v2');
});

test('Reasonix wrapper removes its credential before cancellation settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-reasonix-cancel-'));
  const credential = join(root, 'tmp/maka-eval-reasonix/.env');
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const child = spawn(
    process.execPath,
    [
      wrapper.pathname,
      'reasonix',
      'https://provider.test',
      root,
      '/bin/sh',
      '-c',
      'trap "exit 0" TERM; while :; do sleep 1; done',
      '--model',
      'maka-proxy/model',
      '--effort',
      'max',
    ],
    { env: { ...process.env, OPENAI_API_KEY: 'test-only-secret' }, stdio: 'ignore' },
  );
  while (
    await stat(credential).then(
      () => false,
      () => true,
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });

  await assert.rejects(stat(credential), { code: 'ENOENT' });
});

test('checked-in cohort is one fully expanded six-arm experiment', async () => {
  const path = new URL(
    '../../experiments/terminal-bench-2.1-deepseek-v4-flash-six-arm.json',
    import.meta.url,
  );
  const parsed = parseExperimentSpec(JSON.parse(await readFile(path, 'utf8')) as unknown);
  assert.equal(parsed.tasks.length, 89);
  assert.deepEqual(
    parsed.subjects.map(({ id }) => id),
    ['maka', 'codex', 'claude-code', 'reasonix', 'opencode', 'kimi-code'],
  );
  assert.equal(parsed.execution.maxConcurrentTaskGroups, 12);
  assert.equal(expandExperiment(parsed).length, 534);
  const adapters = [createMakaSubjectAdapter(), createExternalSubjectAdapter()];
  for (const cell of expandExperiment(parsed).slice(0, 6)) {
    adapters.find(({ kind }) => kind === cell.subject.kind)?.validate?.(cell);
  }
});

test('checked-in ZCode cohort adds one pinned seventh arm', async () => {
  const path = new URL(
    '../../experiments/terminal-bench-2.1-deepseek-v4-flash-seven-arm.json',
    import.meta.url,
  );
  const parsed = parseExperimentSpec(JSON.parse(await readFile(path, 'utf8')) as unknown);
  assert.equal(parsed.tasks.length, 89);
  assert.deepEqual(
    parsed.subjects.map(({ id }) => id),
    ['maka', 'codex', 'claude-code', 'reasonix', 'opencode', 'kimi-code', 'zcode'],
  );
  assert.equal(parsed.execution.maxConcurrentTaskGroups, 10);
  assert.equal(expandExperiment(parsed).length, 623);
});

function spec() {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'cli-test',
    benchmark: { id: 'benchmark', version: 'version', config: {} },
    executor: { kind: 'harbor', config: {} },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'maka', kind: 'maka', credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: {} }],
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}
