import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * What the harness knew about one finished cell, written down while it still
 * knew it.
 *
 * Everything downstream that wants to read a run's per-cell artifacts — the
 * contamination scan today, anything else later — reads this instead of walking
 * the run tree and reconstructing which arm produced which directory. The run
 * tree's shape is the harness's private business; a reader that recomputes it
 * is guessing at a fact the writer had in hand.
 */
export interface TrialCellRecord {
  runId: string;
  /** Round id as scheduled; carries the arm and rep the harness assigned. */
  roundId: string;
  taskId: string;
  /** The arm's agent. Harness A/B arm ids and agent ids are the same string. */
  agent: string;
  /** Host path to the trial directory the harness read this cell's output from. */
  trialDir: string;
}

const TRIAL_CELL_LOG_FILENAME = 'trial-cells.jsonl';

export function trialCellLogPath(runRoot: string): string {
  return `${runRoot}/${TRIAL_CELL_LOG_FILENAME}`;
}

/**
 * Append one cell. Called once per trial, right after the trial directory is
 * resolved, so a row exists exactly when a trial directory does — including for
 * a cell that then failed, whose artifacts are still worth reading.
 *
 * Logging is not the run's job: a failure here must not fail a graded cell, so
 * the write is best-effort and reports its own absence by leaving no row. A run
 * that asked for no log passes no path.
 */
export async function appendTrialCell(
  path: string | undefined,
  record: TrialCellRecord,
): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Intentionally swallowed: see above.
  }
}

export async function readTrialCellLog(path: string): Promise<TrialCellRecord[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}: line ${index + 1} is not JSON: ${(error as Error).message}`);
      }
      return assertTrialCellRecord(parsed, `${path}: line ${index + 1}`);
    });
}

function assertTrialCellRecord(value: unknown, where: string): TrialCellRecord {
  if (!value || typeof value !== 'object') throw new Error(`${where} is not an object`);
  const record = value as Record<string, unknown>;
  for (const field of ['runId', 'roundId', 'taskId', 'agent', 'trialDir'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`${where} is missing ${field}`);
    }
  }
  return {
    runId: record.runId as string,
    roundId: record.roundId as string,
    taskId: record.taskId as string,
    agent: record.agent as string,
    trialDir: record.trialDir as string,
  };
}
