import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import type { ContaminationScanReport } from '../harness-contamination-scan.js';
import { appendTrialCell, trialCellLogPath } from '../trial-cell-log.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO_ROOT, 'packages/headless/harbor/run-contamination-scan.mjs');

/**
 * The upstream this run was graded against, read at run time rather than
 * written down.
 *
 * This file compiles into `dist`, which the Maka arm mounts. A revision or an
 * upstream URL spelled out here would be the leak the scan exists to find, so
 * it is loaded from the same host-only JSON the scan loads it from.
 */
async function benchmark(): Promise<{
  upstreamRepositoryUrl: string;
  revision: string;
  taskTreeFingerprint: string;
}> {
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, 'packages/headless/harbor/benchmark-identity.json'), 'utf8'),
  ) as {
    terminalBench21: {
      upstreamRepositoryUrl: string;
      revision: string;
      taskTreeFingerprint: string;
    };
  };
  return catalog.terminalBench21;
}

interface Cell {
  agent: string;
  taskId: string;
  messages?: string[];
}

async function withRunRoot<T>(cells: Cell[], fn: (runRoot: string) => Promise<T>): Promise<T> {
  const runRoot = await mkdtemp(join(tmpdir(), 'maka-contamination-cli-'));
  try {
    for (const [index, cell] of cells.entries()) {
      const trialDir = join(runRoot, 'jobs', `${cell.agent}-${index}`, 'trial');
      await mkdir(join(trialDir, 'agent'), { recursive: true });
      if (cell.messages) {
        await writeFile(
          join(trialDir, 'agent', 'trajectory.json'),
          JSON.stringify({
            steps: cell.messages.map((message, step) => ({ step_id: step + 1, message })),
          }),
          'utf8',
        );
      }
      await appendTrialCell(trialCellLogPath(runRoot), {
        runId: 'run-1',
        roundId: `${cell.agent}-r0-${cell.taskId}`,
        taskId: cell.taskId,
        agent: cell.agent,
        trialDir,
      });
    }
    return await fn(runRoot);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

async function scan(runRoot: string): Promise<{ code: number; report: ContaminationScanReport }> {
  const jsonPath = join(runRoot, 'report.json');
  let code = 0;
  try {
    await execFileAsync(process.execPath, [SCRIPT, '--run-root', runRoot, '--json', jsonPath]);
  } catch (error) {
    code = (error as { code?: number }).code ?? -1;
  }
  return { code, report: JSON.parse(await readFile(jsonPath, 'utf8')) as ContaminationScanReport };
}

describe('run-contamination-scan', () => {
  test('exits zero only after actually searching cells and finding nothing', async () => {
    await withRunRoot(
      [
        { agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests, 12 passed'] },
        { agent: 'codex', taskId: 'fix-git', messages: ['rewrote the reflog by hand'] },
      ],
      async (runRoot) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 0);
        assert.equal(report.totals.analyzed, 2);
      },
    );
  });

  // Each retrieval signal separately, through the real exit code. One of them
  // standing in for the other two would let a change that quietly demotes a
  // pinned revision to advisory pass everything but a single unit assertion.
  describe('exits non-zero on evidence a cell went and got the benchmark', () => {
    for (const [label, evidence] of [
      [
        'the upstream repository',
        async () => `git clone ${(await benchmark()).upstreamRepositoryUrl}.git`,
      ],
      [
        'the pinned revision',
        async () => `checked out ${(await benchmark()).revision.slice(0, 12)}`,
      ],
      [
        'the task-tree fingerprint',
        async () => `tree ${(await benchmark()).taskTreeFingerprint.replace(/^sha256:/, '')}`,
      ],
    ] as const) {
      test(label, async () => {
        const message = await evidence();
        await withRunRoot(
          [
            { agent: 'maka', taskId: 'cobol-modernization', messages: [message] },
            { agent: 'codex', taskId: 'fix-git', messages: ['rewrote the reflog by hand'] },
          ],
          async (runRoot) => {
            const { code, report } = await scan(runRoot);
            assert.equal(code, 1);
            assert.equal(report.totals.cellsWithRetrievalSignals, 1);
          },
        );
      });
    }
  });

  test('writes the report where it was asked to', async () => {
    await withRunRoot(
      [{ agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests'] }],
      async (runRoot) => {
        const markdownPath = join(runRoot, 'report.md');
        await execFileAsync(process.execPath, [
          SCRIPT,
          '--run-root',
          runRoot,
          '--markdown',
          markdownPath,
        ]);
        assert.match(await readFile(markdownPath, 'utf8'), /Searched 1 of 1 recorded cells\./);
      },
    );
  });

  test('refuses a flag it does not know', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, '--run-root', '/tmp', '--depth', '2']),
      (error: { code?: number }) => {
        assert.equal(error.code, 2);
        return true;
      },
    );
  });

  // A cell whose trajectory never landed was not searched, and a zero exit here
  // would be a verdict on evidence that does not exist.
  test('exits non-zero when a declared cell could not be searched', async () => {
    await withRunRoot(
      [
        { agent: 'maka', taskId: 'cobol-modernization' },
        { agent: 'codex', taskId: 'fix-git', messages: ['rewrote the reflog by hand'] },
      ],
      async (runRoot) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 1);
        assert.equal(report.totals.analyzed, 1);
        assert.equal(report.coverageByAgent.maka?.analyzed, 0);
      },
    );
  });

  test('exits non-zero on a run in which nothing was read at all', async () => {
    await withRunRoot([], async (runRoot) => {
      await writeFile(trialCellLogPath(runRoot), '', 'utf8');
      const { code, report } = await scan(runRoot);
      assert.equal(code, 1);
      assert.equal(report.totals.cells, 0);
    });
  });

  // A model can name this suite's tasks from what it read years ago. An alarm
  // that fires on that fires on every run.
  test('does not fail a run on a task-id mention alone', async () => {
    await withRunRoot(
      [
        {
          agent: 'maka',
          taskId: 'cobol-modernization',
          messages: ['this suite also has fix-git, as I recall'],
        },
      ],
      async (runRoot) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 0);
        assert.equal(report.totals.cellsWithAdvisorySignalsOnly, 1);
      },
    );
  });

  // Not a verdict and not a stack trace: a run root with no cell log is either
  // a run that recorded nothing or the wrong directory, and the two cannot be
  // told apart from here.
  test('says what is missing when a run root has no cell log', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'maka-contamination-empty-'));
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [SCRIPT, '--run-root', empty]),
        (error: { code?: number; stderr?: string }) => {
          assert.equal(error.code, 2);
          assert.match(error.stderr ?? '', /no cell log at .*trial-cells\.jsonl/);
          return true;
        },
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('refuses an invocation it cannot act on', async () => {
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT]), (error: { code?: number }) => {
      assert.equal(error.code, 2);
      return true;
    });
  });
});
