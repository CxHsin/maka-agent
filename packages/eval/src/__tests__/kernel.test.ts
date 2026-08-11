import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileAttemptStore } from '../attempt-store.js';
import { openExperimentDirectory } from '../experiment-directory.js';
import { expandExperiment, type ExperimentSpec } from '../experiment.js';
import { selectCellResult, type CellAttempt } from '../result.js';
import {
  runExperiment,
  type AttemptStore,
  type ExperimentExecutor,
  type SubjectAdapter,
} from '../runner.js';
import { parseExperimentSpec } from '../spec.js';

test('experiment expands task by repetition by subject', () => {
  assert.deepEqual(
    expandExperiment(spec()).map(({ id }) => id),
    ['task::1::a', 'task::1::b', 'task::2::a', 'task::2::b'],
  );
});

test('all arms of one task repetition start together', async () => {
  const store = new MemoryStore();
  let started = 0;
  const allStarted = deferred<void>();
  const release = deferred<void>();
  const threeArms: ExperimentSpec = {
    ...spec(),
    subjects: ['a', 'b', 'c'].map((id) => ({
      id,
      kind: 'maka' as const,
      credentials: [],
      config: {},
    })),
  };
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async (_input, operation) => {
      started += 1;
      if (started === 3) allStarted.resolve();
      await release.promise;
      return {
        kind: 'settled',
        value: await operation({
          context: {
            cwd: '/workspace',
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
      };
    },
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

  const running = runExperiment({ spec: threeArms, store, executor, subjects: [subject] });
  try {
    await withTimeout(allStarted.promise, 'all arms did not start');
    assert.equal(started, 3);
  } finally {
    release.resolve();
    await withTimeout(running, 'all arms did not settle');
  }
});

test('task-group concurrency never exceeds the frozen limit', async () => {
  const store = new MemoryStore();
  let active = 0;
  let peak = 0;
  const twoActive = deferred<void>();
  const release = deferred<void>();
  const threeTasks: ExperimentSpec = {
    ...spec(),
    execution: { maxConcurrentTaskGroups: 2 },
    subjects: [spec().subjects[0]!],
    tasks: ['one', 'two', 'three'].map((id) => ({ id, input: 'solve', config: {} })),
    repetitions: 1,
  };
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async (_input, operation) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) twoActive.resolve();
      await release.promise;
      active -= 1;
      return {
        kind: 'settled',
        value: await operation({
          context: {
            cwd: '/workspace',
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
      };
    },
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

  const running = runExperiment({
    spec: threeTasks,
    store,
    executor,
    subjects: [subject],
  });
  try {
    await withTimeout(twoActive.promise, 'task-group concurrency did not reach two');
  } finally {
    release.resolve();
  }
  const results = await withTimeout(running, 'task groups did not settle');

  assert.equal(peak, 2);
  assert.equal(results.size, 3);
});

test('worker failure stops new groups and retains writer ownership until started groups settle', async () => {
  const store = new RejectingStore('one::1::a');
  const siblingStarted = deferred<void>();
  const releaseSibling = deferred<void>();
  const started: string[] = [];
  const threeTasks: ExperimentSpec = {
    ...spec(),
    execution: { maxConcurrentTaskGroups: 2 },
    subjects: ['a', 'b'].map((id) => ({
      id,
      kind: 'maka' as const,
      credentials: [],
      config: {},
    })),
    tasks: ['one', 'two', 'three'].map((id) => ({ id, input: 'solve', config: {} })),
    repetitions: 1,
  };
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async ({ cell }, operation) => {
      started.push(cell.id);
      if (cell.id === 'one::1::b') {
        siblingStarted.resolve();
        await releaseSibling.promise;
      }
      return {
        kind: 'settled',
        value: await operation({
          context: {
            cwd: '/workspace',
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
      };
    },
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

  const running = runExperiment({ spec: threeTasks, store, executor, subjects: [subject] });
  const settled = running.then(
    () => undefined,
    (error: unknown) => error,
  );
  await withTimeout(siblingStarted.promise, 'sibling arm did not start');
  await withTimeout(store.rejected.promise, 'first task group did not reject');

  assert.equal(store.exclusive, true);

  releaseSibling.resolve();
  assert.match(String(await settled), /append rejected/u);
  assert.equal(store.exclusive, false);
  assert.equal(
    started.some((cellId) => cellId.startsWith('three::')),
    false,
  );
});

test('abort while loading attempts prevents the cell from starting', async () => {
  const listed = deferred<void>();
  const releaseList = deferred<void>();
  const controller = new AbortController();
  let executions = 0;
  const store: AttemptStore = {
    runExclusive: (operation) => operation(),
    list: async () => {
      listed.resolve();
      await releaseList.promise;
      return [];
    },
    append: async () => undefined,
  };
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async () => {
      executions += 1;
      throw new Error('must not start');
    },
  };

  const running = runExperiment({
    spec: { ...spec(), subjects: [spec().subjects[0]!], repetitions: 1 },
    store,
    executor,
    subjects: [{ kind: 'maka', execute: async () => assert.fail('subject must not run') }],
    signal: controller.signal,
  });
  await withTimeout(listed.promise, 'attempt listing did not start');
  controller.abort();
  releaseList.resolve();
  await running;

  assert.equal(executions, 0);
});

test('legacy v1 experiment directory resumes without a spec drift error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-legacy-v1-'));
  const { execution: _execution, ...legacy } = spec();
  await writeFile(join(root, 'experiment.json'), JSON.stringify(legacy));
  try {
    const normalized = parseExperimentSpec(legacy);
    await openExperimentDirectory(root, normalized);

    assert.deepEqual(normalized.execution, { maxConcurrentTaskGroups: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cell result is the earliest valid attempt, never a hand-picked replacement', () => {
  assert.equal(
    selectCellResult([attempt(1, 'infra_failed'), attempt(2, 'completed'), attempt(3, 'completed')])
      ?.sequence,
    2,
  );
});

test('experiment directory admits only one writer across processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-writer-'));
  const workers = Array.from({ length: 2 }, () => worker(root));
  try {
    await waitForFiles(root, 'ready-', workers.length);
    await writeFile(join(root, 'go'), '');
    await waitForFiles(root, 'entered-', 1);
    await waitForFiles(root, 'rejected-', workers.length - 1);
    await writeFile(join(root, 'release'), '');
    const outputs = await withTimeout(
      Promise.all(workers.map(({ result }) => result)),
      'writer workers did not exit',
    );
    assert.equal(outputs.filter(({ stdout }) => stdout === 'ENTER\n').length, 1);
  } finally {
    for (const worker of workers) worker.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test('attempt publication ignores unpublished temporary records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-attempt-'));
  try {
    const store = new FileAttemptStore(root);
    await store.append(attempt(1, 'completed'));
    await writeFile(join(root, 'interrupted.tmp'), '{');
    assert.deepEqual(await store.list('cell'), [attempt(1, 'completed')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('infra failure skips verification and the next run appends one replacement', async () => {
  const store = new MemoryStore();
  let executions = 0;
  let verifications = 0;
  const subject: SubjectAdapter = {
    kind: 'maka',
    execute: async () => {
      executions += 1;
      return {
        usage: null,
        costUsd: null,
        durationMs: 1,
        status: executions === 1 ? 'infra_failed' : 'completed',
        failureReason: executions === 1 ? 'host unavailable' : null,
        artifacts: [],
      };
    },
  };
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async (_input, operation) => ({
      kind: 'settled',
      value: await operation({
        context: {
          cwd: '/workspace',
          taskInput: 'solve',
          metadata: {},
          execute: async () => ({ termination: 'exited', exitCode: 0, stdout: '' }),
        },
        verify: async () => {
          verifications += 1;
          return {
            status: 'completed',
            score: 1,
            failureReason: null,
            artifacts: [],
          };
        },
      }),
    }),
  };

  const oneArm = { ...spec(), subjects: [spec().subjects[0]!], repetitions: 1 };
  assert.equal(
    (await runExperiment({ spec: oneArm, store, executor, subjects: [subject] })).size,
    0,
  );
  const results = await runExperiment({ spec: oneArm, store, executor, subjects: [subject] });

  assert.equal(results.get('task::1::a')?.sequence, 2);
  assert.equal(verifications, 1);
});

test('executor cleanup uncertainty cannot publish a completed result', async () => {
  const store = new MemoryStore();
  const completed = attempt(1, 'completed').result;
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async () => ({ kind: 'indeterminate', value: completed }),
  };

  const oneArm = { ...spec(), subjects: [spec().subjects[0]!], repetitions: 1 };
  const results = await runExperiment({
    spec: oneArm,
    store,
    executor,
    subjects: [{ kind: 'maka', execute: async () => assert.fail('subject must not run') }],
  });

  assert.equal(results.size, 0);
  assert.equal(store.attempts[0]?.result.status, 'indeterminate');
});

test('malformed subject output is recorded as replaceable infrastructure failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-malformed-subject-'));
  try {
    const store = new FileAttemptStore(root);
    const executor: ExperimentExecutor = {
      kind: 'executor',
      runAttempt: async (_input, operation) => ({
        kind: 'settled',
        value: await operation({
          context: {
            cwd: '/workspace',
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
    const subject = {
      kind: 'maka' as const,
      execute: async () => ({
        usage: null,
        costUsd: null,
        durationMs: 1,
        status: 'completed' as const,
        failureReason: null,
        artifacts: [{ detail: 1n }],
      }),
    } as unknown as SubjectAdapter;
    const oneArm = { ...spec(), subjects: [spec().subjects[0]!], repetitions: 1 };

    const results = await runExperiment({ spec: oneArm, store, executor, subjects: [subject] });
    const recorded = await store.list('task::1::a');

    assert.equal(results.size, 0);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.result.status, 'infra_failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifier infrastructure failure remains replaceable after subject failure', async () => {
  const store = new MemoryStore();
  let verifications = 0;
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async (_input, operation) => ({
      kind: 'settled',
      value: await operation({
        context: {
          cwd: '/workspace',
          taskInput: 'solve',
          metadata: {},
          execute: async () => ({ termination: 'exited', exitCode: 1, stdout: '' }),
        },
        verify: async () => ({
          status: ++verifications === 1 ? 'infra_failed' : 'completed',
          score: verifications === 1 ? null : 0,
          failureReason: verifications === 1 ? 'verifier unavailable' : null,
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
      status: 'failed',
      failureReason: 'subject failed',
      artifacts: [],
    }),
  };
  const oneArm = { ...spec(), subjects: [spec().subjects[0]!], repetitions: 1 };

  assert.equal(
    (await runExperiment({ spec: oneArm, store, executor, subjects: [subject] })).size,
    0,
  );
  const results = await runExperiment({ spec: oneArm, store, executor, subjects: [subject] });

  assert.equal(store.attempts[0]?.result.status, 'infra_failed');
  assert.equal(results.get('task::1::a')?.result.status, 'subject_failed');
  assert.equal(verifications, 2);
});

test('invalid subject status cannot be verified into a completed result', async () => {
  const store = new MemoryStore();
  let verifications = 0;
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async (_input, operation) => ({
      kind: 'settled',
      value: await operation({
        context: {
          cwd: '/workspace',
          taskInput: 'solve',
          metadata: {},
          execute: async () => ({ termination: 'exited', exitCode: 0, stdout: '' }),
        },
        verify: async () => {
          verifications += 1;
          return { status: 'completed', score: 1, failureReason: null, artifacts: [] };
        },
      }),
    }),
  };
  const subject = {
    kind: 'maka' as const,
    execute: async () => ({
      usage: null,
      costUsd: null,
      durationMs: 1,
      status: 'not-a-status',
      failureReason: null,
      artifacts: [],
    }),
  } as unknown as SubjectAdapter;
  const oneArm = { ...spec(), subjects: [spec().subjects[0]!], repetitions: 1 };

  const results = await runExperiment({ spec: oneArm, store, executor, subjects: [subject] });

  assert.equal(results.size, 0);
  assert.equal(store.attempts[0]?.result.status, 'infra_failed');
  assert.equal(verifications, 0);
});

function worker(root: string): {
  readonly result: Promise<{ stdout: string; code: number | null }>;
  readonly kill: () => boolean;
} {
  const child = spawn(
    process.execPath,
    [new URL('./fixtures/writer-worker.js', import.meta.url).pathname, root],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const result = new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ stdout, code }));
  });
  return { result, kill: () => child.kill('SIGKILL') };
}

function spec(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'experiment',
    benchmark: { id: 'benchmark', version: 'version', config: {} },
    executor: { kind: 'executor', config: {} },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [
      { id: 'a', kind: 'maka', credentials: [], config: {} },
      { id: 'b', kind: 'external', credentials: [], config: {} },
    ],
    tasks: [{ id: 'task', input: 'solve', config: {} }],
    repetitions: 2,
    budget: {},
    verifier: {},
  };
}

function attempt(sequence: number, status: CellAttempt['result']['status']): CellAttempt {
  return {
    cellId: 'cell',
    sequence,
    startedAt: sequence,
    completedAt: sequence,
    result: {
      score: status === 'completed' ? 1 : null,
      usage: null,
      costUsd: null,
      durationMs: 0,
      status,
      failureReason: null,
      artifacts: [],
    },
  };
}

class MemoryStore implements AttemptStore {
  readonly attempts: CellAttempt[] = [];

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async list(cellId: string): Promise<readonly CellAttempt[]> {
    return this.attempts.filter((attempt) => attempt.cellId === cellId);
  }

  async append(attempt: CellAttempt): Promise<void> {
    this.attempts.push(attempt);
  }
}

class RejectingStore extends MemoryStore {
  readonly rejected = deferred<void>();
  exclusive = false;

  constructor(readonly rejectedCellId: string) {
    super();
  }

  override async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.exclusive = true;
    try {
      return await operation();
    } finally {
      this.exclusive = false;
    }
  }

  override async append(attempt: CellAttempt): Promise<void> {
    if (attempt.cellId === this.rejectedCellId) {
      this.rejected.resolve();
      throw new Error('append rejected');
    }
    await super.append(attempt);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForFiles(root: string, prefix: string, count: number): Promise<void> {
  await withTimeout(
    (async () => {
      for (;;) {
        if ((await readdir(root)).filter((name) => name.startsWith(prefix)).length === count)
          return;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    })(),
    `${prefix} barrier did not reach ${count}`,
  );
}

async function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
