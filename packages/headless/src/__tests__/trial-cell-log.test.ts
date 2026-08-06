import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { appendTrialCell, readTrialCellLog, trialCellLogPath } from '../trial-cell-log.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-trial-cell-log-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const cell = (overrides: Partial<Parameters<typeof appendTrialCell>[1]> = {}) => ({
  runId: 'run-1',
  roundId: 'maka-r0-task-1',
  taskId: 'task-1',
  agent: 'maka',
  trialDir: '/runs/jobs/run-1/maka-r0-task-1/task-1/trial/task-1',
  ...overrides,
});

describe('trial cell log', () => {
  test('appends one row per cell and reads them back in order', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(dir);
      await appendTrialCell(path, cell());
      await appendTrialCell(path, cell({ agent: 'codex', roundId: 'codex-r0-task-1' }));
      const rows = await readTrialCellLog(path);
      assert.deepEqual(
        rows.map((row) => row.agent),
        ['maka', 'codex'],
      );
      assert.equal(rows[0]?.trialDir, cell().trialDir);
    });
  });

  test('creates the log directory rather than dropping the first row', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(join(dir, 'not', 'created', 'yet'));
      await appendTrialCell(path, cell());
      assert.equal((await readTrialCellLog(path)).length, 1);
    });
  });

  // A cell can be attempted twice: the adjudicated-infra retry re-runs a round,
  // and each attempt deletes the previous attempt's job directory first. Two
  // rows for one cell would count it twice, and would let an attempt whose
  // artifacts no longer exist speak for the attempt that was graded.
  test('keeps the attempt that is still on disk when a cell was retried', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(dir);
      await appendTrialCell(path, cell({ trialDir: '/runs/first-attempt' }));
      await appendTrialCell(path, cell({ taskId: 'task-2', roundId: 'maka-r0-task-2' }));
      await appendTrialCell(path, cell({ trialDir: '/runs/retry' }));
      const rows = await readTrialCellLog(path);
      assert.deepEqual(
        rows.map((row) => [row.taskId, row.trialDir]),
        [
          ['task-1', '/runs/retry'],
          ['task-2', cell().trialDir],
        ],
      );
    });
  });

  // Two arms grade the same task; they are two cells, not one retried cell.
  test('does not fold two arms of the same task into one cell', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(dir);
      await appendTrialCell(path, cell());
      await appendTrialCell(path, cell({ agent: 'codex', roundId: 'codex-r0-task-1' }));
      assert.equal((await readTrialCellLog(path)).length, 2);
    });
  });

  // A run that asked for no log is the ordinary case for every caller outside
  // the harness A/B path; it must not have to invent a path to stay silent.
  test('writes nothing when no path is configured', async () => {
    await appendTrialCell(undefined, cell());
  });

  // The whole point of the log is that a reader trusts it. A row that lost a
  // field would otherwise be read as a cell in some other directory.
  test('refuses a row missing a field instead of returning a partial one', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(dir);
      await writeFile(path, `${JSON.stringify({ ...cell(), trialDir: undefined })}\n`, 'utf8');
      await assert.rejects(readTrialCellLog(path), /missing trialDir/);
    });
  });

  test('refuses a line that is not JSON', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(dir);
      await writeFile(path, `${JSON.stringify(cell())}\nnot json\n`, 'utf8');
      await assert.rejects(readTrialCellLog(path), /line 2 is not JSON/);
    });
  });

  // Arms run in parallel by default, so two runners append to one log at once.
  // A torn row would either lose a cell or fail the read for the whole run.
  test('survives every arm appending at once', async () => {
    await withTempDir(async (dir) => {
      const path = trialCellLogPath(dir);
      const rows = Array.from({ length: 200 }, (_, index) =>
        cell({
          roundId: `maka-r0-task-${index}`,
          taskId: `task-${index}`,
          trialDir: `/runs/jobs/run-1/${'d'.repeat(200)}/${index}`,
        }),
      );
      await Promise.all(rows.map((row) => appendTrialCell(path, row)));
      const read = await readTrialCellLog(path);
      assert.equal(read.length, rows.length);
      assert.equal(new Set(read.map((row) => row.taskId)).size, rows.length);
    });
  });

  // Logging must never be able to fail a graded cell.
  test('swallows a write failure', async () => {
    await withTempDir(async (dir) => {
      const blocker = join(dir, 'blocker');
      await writeFile(blocker, 'not a directory\n', 'utf8');
      await appendTrialCell(join(blocker, 'trial-cells.jsonl'), cell());
      assert.equal(await readFile(blocker, 'utf8'), 'not a directory\n');
    });
  });
});
