import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileAttemptStore } from '../attempt-store.js';
import { createHarborExecutor } from '../harness-executor.js';
import type { ExperimentSpec } from '../experiment.js';
import { runExperiment, type ExperimentExecutor, type SubjectAdapter } from '../runner.js';

const TEST_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';

test('harness spawn failure releases its relay listener and process', async () => {
  const child = spawn(
    process.execPath,
    [new URL('./fixtures/harness-preparation-worker.js', import.meta.url).pathname],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const exited = await new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(false), 1_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  if (!exited) child.kill('SIGKILL');

  assert.equal(exited, true);
  assert.equal(output, 'SETTLED\n');
});

test('Harbor rejects unresolved Git revisions before attempt admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-harbor-revision-'));
  const previousPython = process.env.MAKA_TEST_PYTHON;
  const previousTrials = process.env.MAKA_TEST_TRIALS;
  process.env.MAKA_TEST_PYTHON = process.execPath;
  process.env.MAKA_TEST_TRIALS = root;
  try {
    const executor = testExecutor(root) as ExperimentExecutor & {
      validate(cell: ReturnType<typeof harnessCell>): void;
    };
    assert.throws(() => executor.validate(harnessCell([], 'main')), /complete Git commit/u);
  } finally {
    if (previousPython === undefined) delete process.env.MAKA_TEST_PYTHON;
    else process.env.MAKA_TEST_PYTHON = previousPython;
    if (previousTrials === undefined) delete process.env.MAKA_TEST_TRIALS;
    else process.env.MAKA_TEST_TRIALS = previousTrials;
    await rm(root, { recursive: true, force: true });
  }
});

test('preparation failure persists only safe structured facts on the attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-preparation-diagnostic-'));
  const executable = join(root, 'fake-python.mjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stderr.write('argv: /private/subject --token=test-only-sensitive-value\\nError: raw diagnostic\\n');
process.exitCode = process.env.MAKA_TEST_SECRET || process.env.MAKA_OTHER_SECRET || process.env.MAKA_UNRELATED_SECRET ? 8 : process.env.MAKA_TEST_CONTROL === 'declared-control-plane' ? 9 : 7;
`,
  );
  await chmod(executable, 0o755);
  const previousPython = process.env.MAKA_TEST_PYTHON;
  const previousTrials = process.env.MAKA_TEST_TRIALS;
  const previousSecret = process.env.MAKA_TEST_SECRET;
  const previousOtherSecret = process.env.MAKA_OTHER_SECRET;
  const previousUnrelatedSecret = process.env.MAKA_UNRELATED_SECRET;
  const previousControl = process.env.MAKA_TEST_CONTROL;
  process.env.MAKA_TEST_PYTHON = executable;
  process.env.MAKA_TEST_TRIALS = root;
  process.env.MAKA_TEST_SECRET = 'test-only-sensitive-value';
  process.env.MAKA_OTHER_SECRET = 'other-test-only-secret';
  process.env.MAKA_UNRELATED_SECRET = 'unrelated-test-only-secret';
  process.env.MAKA_TEST_CONTROL = 'declared-control-plane';
  try {
    const spec: ExperimentSpec = {
      schemaVersion: 'maka.eval.v1',
      id: 'experiment',
      benchmark: { id: 'benchmark', version: TEST_REVISION, config: { repository: 'repo' } },
      executor: { kind: 'harbor', config: {} },
      execution: { maxConcurrentTaskGroups: 1 },
      subjects: [
        { id: 'subject', kind: 'external', credentials: ['MAKA_TEST_SECRET'], config: {} },
        { id: 'other', kind: 'external', credentials: ['MAKA_OTHER_SECRET'], config: {} },
      ],
      tasks: [{ id: 'task', input: 'solve', config: { harbor: { path: 'tasks/task' } } }],
      repetitions: 1,
      budget: { timeoutMultiplier: 1 },
      verifier: { reward: 'reward' },
    };
    const executor = testExecutor(root, ['MAKA_TEST_CONTROL', 'MAKA_TEST_SECRET']);
    const subject: SubjectAdapter = {
      kind: 'external',
      execute: async () => assert.fail('subject must not run'),
    };
    const store = new FileAttemptStore(join(root, 'attempts'));

    await runExperiment({
      spec,
      store,
      executor,
      subjects: [subject],
      cellIds: ['task::1::subject'],
    });

    const attempt = (await store.list('task::1::subject'))[0]!;
    assert.equal(attempt.result.failureReason, 'executor preparation failed');
    const artifact = attempt.result.artifacts[0]!;
    assert.equal(artifact.kind, 'executor-preparation');
    const diagnosticText = await readFile(
      join(root, String(artifact.trialName), String(artifact.path)),
      'utf8',
    );
    const diagnostic = JSON.parse(diagnosticText) as {
      stage: string;
      code: string;
      errorCode: string | null;
      exitCode: number | null;
    };
    assert.equal(diagnostic.stage, 'exit-before-ready');
    assert.equal(diagnostic.code, 'exit-before-ready');
    assert.equal(diagnostic.errorCode, null);
    assert.equal(diagnostic.exitCode, 9);
    assert.deepEqual(Object.keys(diagnostic).sort(), [
      'code',
      'errorCode',
      'exitCode',
      'framework',
      'signal',
      'stage',
    ]);
    assert.doesNotMatch(diagnosticText, /subject|token|sensitive|diagnostic/u);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith('.json')),
      [],
    );
  } finally {
    if (previousPython === undefined) delete process.env.MAKA_TEST_PYTHON;
    else process.env.MAKA_TEST_PYTHON = previousPython;
    if (previousTrials === undefined) delete process.env.MAKA_TEST_TRIALS;
    else process.env.MAKA_TEST_TRIALS = previousTrials;
    if (previousSecret === undefined) delete process.env.MAKA_TEST_SECRET;
    else process.env.MAKA_TEST_SECRET = previousSecret;
    if (previousOtherSecret === undefined) delete process.env.MAKA_OTHER_SECRET;
    else process.env.MAKA_OTHER_SECRET = previousOtherSecret;
    if (previousUnrelatedSecret === undefined) delete process.env.MAKA_UNRELATED_SECRET;
    else process.env.MAKA_UNRELATED_SECRET = previousUnrelatedSecret;
    if (previousControl === undefined) delete process.env.MAKA_TEST_CONTROL;
    else process.env.MAKA_TEST_CONTROL = previousControl;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation during preparation is persisted as indeterminate', {
  timeout: 2_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-preparation-cancel-'));
  const executable = join(root, 'fake-python.mjs');
  const preparingPath = join(root, 'preparing');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
process.on('SIGTERM', () => process.exit(0));
await writeFile(process.env.MAKA_TEST_PREPARING, '');
setInterval(() => {}, 1_000);
await new Promise(() => {});
`,
  );
  await chmod(executable, 0o755);
  const previousPython = process.env.MAKA_TEST_PYTHON;
  const previousTrials = process.env.MAKA_TEST_TRIALS;
  const previousPreparing = process.env.MAKA_TEST_PREPARING;
  process.env.MAKA_TEST_PYTHON = executable;
  process.env.MAKA_TEST_TRIALS = root;
  process.env.MAKA_TEST_PREPARING = preparingPath;
  const watching = new AbortController();
  const events = watch(root, { signal: watching.signal })[Symbol.asyncIterator]();
  try {
    const controller = new AbortController();
    const store = new FileAttemptStore(join(root, 'attempts'));
    const experiment: ExperimentSpec = {
      schemaVersion: 'maka.eval.v1',
      id: 'experiment',
      benchmark: { id: 'benchmark', version: TEST_REVISION, config: { repository: 'repo' } },
      executor: { kind: 'harbor', config: {} },
      execution: { maxConcurrentTaskGroups: 1 },
      subjects: [{ id: 'subject', kind: 'external', credentials: [], config: {} }],
      tasks: [{ id: 'task', input: 'solve', config: { harbor: { path: 'tasks/task' } } }],
      repetitions: 1,
      budget: { timeoutMultiplier: 1 },
      verifier: { reward: 'reward' },
    };
    const running = runExperiment({
      spec: experiment,
      store,
      executor: testExecutor(root, ['MAKA_TEST_PREPARING']),
      subjects: [{ kind: 'external', execute: async () => assert.fail('subject must not run') }],
      signal: controller.signal,
    });
    for (;;) {
      const event = await events.next();
      if (event.value?.filename === 'preparing') break;
    }
    controller.abort();
    await running;

    const attempt = (await store.list('task::1::subject'))[0]!;
    const artifact = attempt.result.artifacts[0]!;
    const diagnostic = JSON.parse(
      await readFile(join(root, String(artifact.trialName), String(artifact.path)), 'utf8'),
    ) as { code: string };
    assert.equal(diagnostic.code, 'cancelled');
    assert.equal(attempt.result.status, 'indeterminate');
    assert.equal(attempt.result.failureReason, 'executor preparation cancelled');
  } finally {
    watching.abort();
    if (previousPython === undefined) delete process.env.MAKA_TEST_PYTHON;
    else process.env.MAKA_TEST_PYTHON = previousPython;
    if (previousTrials === undefined) delete process.env.MAKA_TEST_TRIALS;
    else process.env.MAKA_TEST_TRIALS = previousTrials;
    if (previousPreparing === undefined) delete process.env.MAKA_TEST_PREPARING;
    else process.env.MAKA_TEST_PREPARING = previousPreparing;
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown Trial exception stays replaceable after subject failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-trial-exception-'));
  const executable = join(root, 'fake-python.mjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { connect } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
socket.setEncoding('utf8');
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'ready', instruction: 'solve' }) + '\\n');
await next();
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'executed', termination: 'exited', exitCode: 1, stdout: '' }) + '\\n');
await next();
socket.end();
const trial = config.trials_dir + '/' + config.trial_name;
await mkdir(trial, { recursive: true });
await writeFile(trial + '/result.json', JSON.stringify({ exception_info: { exception_type: 'ContainerFinalizationError' }, verifier_result: { rewards: { reward: 1 } } }));
`,
  );
  await chmod(executable, 0o755);
  const previousPython = process.env.MAKA_TEST_PYTHON;
  const previousTrials = process.env.MAKA_TEST_TRIALS;
  process.env.MAKA_TEST_PYTHON = executable;
  process.env.MAKA_TEST_TRIALS = root;
  try {
    const executor = testExecutor(root);
    await assert.rejects(
      executor.runAttempt(
        {
          cell: harnessCell(),
          subjectCredentialNames: [],
        },
        async ({ context, verify }) => {
          const execution = await context.execute({
            command: '/opt/subject',
            args: [],
            credentialNames: [],
          });
          const subject = {
            usage: null,
            costUsd: null,
            durationMs: 1,
            status: 'failed' as const,
            failureReason: `subject exited ${execution.exitCode}`,
            artifacts: [],
          };
          const verification = await verify();
          return {
            score: verification.score,
            usage: null,
            costUsd: null,
            durationMs: 1,
            status: 'subject_failed',
            failureReason: subject.failureReason,
            artifacts: verification.artifacts,
          };
        },
      ),
      /Trial failed outside subject execution/u,
    );
  } finally {
    if (previousPython === undefined) delete process.env.MAKA_TEST_PYTHON;
    else process.env.MAKA_TEST_PYTHON = previousPython;
    if (previousTrials === undefined) delete process.env.MAKA_TEST_TRIALS;
    else process.env.MAKA_TEST_TRIALS = previousTrials;
    await rm(root, { recursive: true, force: true });
  }
});

test('Harbor abort outcome is recorded without replacing the primary subject failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-cleanup-evidence-'));
  const executable = join(root, 'fake-python.mjs');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
if (process.env.SSL_CERT_FILE) process.exit(3);
const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
socket.setEncoding('utf8');
await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
const next = async () => JSON.parse((await lines.next()).value);
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'ready', instruction: 'solve' }) + '\\n');
await next();
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'executed', termination: 'exited', exitCode: 0, stdout: '' }) + '\\n');
const cleanup = await next();
if (cleanup.kind !== 'abort') process.exitCode = 2;
socket.end();
`,
  );
  await chmod(executable, 0o755);
  const previousPython = process.env.MAKA_TEST_PYTHON;
  const previousTrials = process.env.MAKA_TEST_TRIALS;
  const previousCertificate = process.env.SSL_CERT_FILE;
  process.env.MAKA_TEST_PYTHON = executable;
  process.env.MAKA_TEST_TRIALS = root;
  process.env.SSL_CERT_FILE = 'test-only-sensitive-value';
  try {
    const executor = testExecutor(root);
    const result = await executor.runAttempt(
      {
        cell: harnessCell(['SSL_CERT_FILE']),
        subjectCredentialNames: [],
      },
      async ({ context }) => {
        await context.execute({ command: '/opt/subject', args: [], credentialNames: [] });
        return {
          score: null,
          usage: null,
          costUsd: null,
          durationMs: 1,
          status: 'infra_failed',
          failureReason: 'Maka subject failed during empty-output',
          artifacts: [{ kind: 'subject-failure', stage: 'empty-output' }],
        };
      },
    );

    assert.equal(result.kind, 'settled');
    assert.equal(result.value.failureReason, 'Maka subject failed during empty-output');
    assert.deepEqual(result.value.artifacts, [
      { kind: 'subject-failure', stage: 'empty-output' },
      { kind: 'executor-cleanup', action: 'abort', outcome: 'completed' },
    ]);
  } finally {
    if (previousPython === undefined) delete process.env.MAKA_TEST_PYTHON;
    else process.env.MAKA_TEST_PYTHON = previousPython;
    if (previousTrials === undefined) delete process.env.MAKA_TEST_TRIALS;
    else process.env.MAKA_TEST_TRIALS = previousTrials;
    if (previousCertificate === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = previousCertificate;
    await rm(root, { recursive: true, force: true });
  }
});

function harnessCell(credentials: readonly string[] = [], revision = TEST_REVISION) {
  return {
    id: 'task::1::subject',
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: revision, config: { repository: 'repo' } },
    executor: { kind: 'harbor', config: {} },
    subject: {
      id: 'subject',
      kind: 'external' as const,
      credentials,
      config: {},
    },
    task: { id: 'task', input: 'solve', config: { harbor: { path: 'task' } } },
    repetition: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function testExecutor(root: string, preparationEnvironment: readonly string[] = []) {
  return createHarborExecutor(
    {
      frameworkVersion: '0.20.0',
      pythonPathEnv: 'MAKA_TEST_PYTHON',
      trialsRootEnv: 'MAKA_TEST_TRIALS',
      containerCwd: '/app',
      environment: {},
      preparationEnvironment,
      mounts: [],
    },
    join(root, 'spec.json'),
  );
}
