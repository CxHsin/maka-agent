import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExperimentSpec } from '../experiment.js';
import type { CellAttempt } from '../result.js';
import {
  runExperiment,
  type AttemptStore,
  type ExperimentExecutor,
  type SubjectAdapter,
} from '../runner.js';

test('fatal publication failure stops admission after started work settles', {
  timeout: 2_000,
}, async () => {
  const store = new RejectingStore('one::1::a');
  const siblingStarted = deferred();
  const release = deferred();
  const started: string[] = [];
  const executor: ExperimentExecutor = {
    kind: 'executor',
    runAttempt: async ({ cell }) => {
      started.push(cell.id);
      if (cell.id === 'one::1::b') siblingStarted.resolve();
      if (cell.id !== 'one::1::a') await release.promise;
      return { kind: 'settled', value: result('completed') };
    },
  };
  const running = runExperiment({
    spec: experiment(['one', 'two', 'three'], ['a', 'b'], 2),
    store,
    executor,
    subjects: [neverRuns],
  });

  await siblingStarted.promise;
  await store.rejected.promise;
  assert.equal(store.exclusive, true);
  release.resolve();
  await assert.rejects(running, /append rejected/u);

  assert.equal(store.exclusive, false);
  assert.equal(
    started.some((cellId) => cellId.startsWith('three::')),
    false,
  );
});

test('external cancellation closes admission before the next task group', {
  timeout: 2_000,
}, async () => {
  const listed = deferred();
  const release = deferred();
  const controller = new AbortController();
  const listCounts = new Map<string, number>();
  let executions = 0;
  const store: AttemptStore = {
    runExclusive: (operation) => operation(),
    list: async (cellId) => {
      const count = (listCounts.get(cellId) ?? 0) + 1;
      listCounts.set(cellId, count);
      if (cellId === 'one::1::a' && count === 1) {
        listed.resolve();
        await release.promise;
      }
      return [];
    },
    append: async () => undefined,
  };
  const running = runExperiment({
    spec: experiment(['one', 'two'], ['a'], 1),
    store,
    executor: {
      kind: 'executor',
      runAttempt: async () => {
        executions += 1;
        throw new Error('cancelled work must not start');
      },
    },
    subjects: [neverRuns],
    signal: controller.signal,
  });

  await listed.promise;
  controller.abort();
  release.resolve();
  await running;

  assert.equal(executions, 0);
  assert.equal(listCounts.get('one::1::a'), 2);
  assert.equal(listCounts.get('two::1::a'), 1);
});

const neverRuns: SubjectAdapter = {
  kind: 'maka',
  execute: async () => assert.fail('subject must not run'),
};

function experiment(tasks: string[], subjects: string[], concurrency: number): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1',
    id: 'experiment',
    benchmark: { id: 'benchmark', version: 'version', config: {} },
    executor: { kind: 'executor', config: {} },
    execution: { maxConcurrentTaskGroups: concurrency },
    subjects: subjects.map((id) => ({ id, kind: 'maka', credentials: [], config: {} })),
    tasks: tasks.map((id) => ({ id, input: 'solve', config: {} })),
    repetitions: 1,
    budget: {},
    verifier: {},
  };
}

function result(status: CellAttempt['result']['status']): CellAttempt['result'] {
  return {
    score: status === 'completed' ? 1 : null,
    usage: null,
    costUsd: null,
    durationMs: 0,
    status,
    failureReason: null,
    artifacts: [],
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
  readonly rejected = deferred();
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

  override async append(value: CellAttempt): Promise<void> {
    if (value.cellId === this.rejectedCellId) {
      this.rejected.resolve();
      throw new Error('append rejected');
    }
    await super.append(value);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
