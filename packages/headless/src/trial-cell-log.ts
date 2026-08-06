import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  return join(runRoot, TRIAL_CELL_LOG_FILENAME);
}

/**
 * Append one cell. Called once per trial, right after the trial directory is
 * resolved, so a row is attempted for every trial directory there is —
 * including for a cell that then failed, whose artifacts are still worth
 * reading.
 *
 * Attempted, not guaranteed. Logging is not the run's job: a failure here must
 * not fail a graded cell, so the write is best-effort and reports its own
 * absence by leaving no row, which a reader counts as a cell it cannot account
 * for. A run that asked for no log passes no path.
 */
export async function appendTrialCell(
  path: string | undefined,
  record: TrialCellRecord,
): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await truncateTornTail(path);
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Intentionally swallowed: see above.
  }
}

/**
 * Drop a row a crash cut off mid-write, before appending after it.
 *
 * Without this, a run resumed after a crash appends past the stump and buries
 * it in the middle of the file, where it is indistinguishable from corruption
 * and takes the whole scan down with it. The WAL beside this one does exactly
 * this for the same reason. Each row lands in a single append-mode write, so
 * the file is only ever missing a trailing newline because a process died, not
 * because one is in flight.
 */
async function truncateTornTail(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (text.length === 0 || text.endsWith('\n')) return;
  const lastNewline = text.lastIndexOf('\n');
  await truncate(path, lastNewline < 0 ? 0 : lastNewline + 1);
}

/**
 * The run's cells: one row per cell, each the attempt that is still on disk.
 *
 * A cell can be attempted more than once — the adjudicated-infra retry re-runs
 * a round, and so does re-invoking a run id against a WAL that does not mark it
 * complete. Each attempt appends, and each attempt starts by deleting the
 * previous attempt's job directory, so an earlier row names a directory that
 * now holds the later attempt's artifacts. Reading the rows one-to-one would
 * count one cell twice and let an attempt the harness itself superseded — whose
 * artifacts no longer exist — decide the verdict for the attempt that was
 * graded. The last row for a cell is the one that ran, which holds because the
 * run lock makes this file single-writer and a cell's attempts are serial: the
 * retry is a later invocation, and an attempt orphaned by a crash is admitted
 * as a failure rather than re-run. Nothing here would detect rows arriving out
 * of order, so a caller that writes this log without the run lock would get a
 * silently wrong attempt.
 *
 * A crash mid-append leaves a row without its newline. That is a truncated
 * write, not a corrupt log, and it is dropped the way the WAL beside it drops
 * one — a run resumed after a crash must still be scannable. A malformed row
 * anywhere else is real corruption and refuses.
 */
export async function readTrialCellLog(path: string): Promise<TrialCellRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // No log is no cells, which is a true and useful answer: a run that died
    // before its first trial directory recorded nothing. Whether the directory
    // is a run at all is a different question, and not this file's to answer.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const attempts = parseRows(path, text).map(({ value, where }) =>
    assertTrialCellRecord(value, where),
  );
  // Keyed on the run too, though one log only ever belongs to one run — the
  // run root is named after it. An extra component that is constant can only
  // ever keep two cells apart that were never the same cell.
  const byCell = new Map<string, TrialCellRecord>();
  for (const attempt of attempts) {
    byCell.set(JSON.stringify([attempt.runId, attempt.roundId, attempt.taskId]), attempt);
  }
  return [...byCell.values()];
}

/**
 * The rows of one of this file's logs, minus the one a crash cut off.
 *
 * A row without its trailing newline is a truncated write, not a corrupt log,
 * and it is dropped the way the WAL beside these drops one — a run resumed
 * after a crash must still be readable. A malformed row anywhere else is real
 * corruption and refuses.
 */
function parseRows(path: string, text: string): { value: unknown; where: string }[] {
  const lines = text.split('\n');
  const torn = lines.length > 0 && lines[lines.length - 1] !== '';
  return lines
    .slice(0, torn ? -1 : undefined)
    .map((line, index) => ({ line, where: `${path}: line ${index + 1}` }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, where }) => {
      try {
        return { value: JSON.parse(line) as unknown, where };
      } catch (error) {
        throw new Error(`${where} is not JSON: ${(error as Error).message}`);
      }
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

/** One cell the harness put on the schedule: an arm crossed with a task. */
export interface ScheduledCellRecord {
  agent: string;
  taskId: string;
}

const SCHEDULED_CELL_LOG_FILENAME = 'scheduled-cells.jsonl';

export function scheduledCellLogPath(runRoot: string): string {
  return join(runRoot, SCHEDULED_CELL_LOG_FILENAME);
}

/**
 * Write down the grid, at the moment the harness decides what it is.
 *
 * Which cells a run grades is not derivable from anything it leaves behind.
 * The frozen manifest carries the benchmark's whole task list, while a run
 * grades `limit` of them — and the same frozen manifest legitimately serves a
 * canary and the full run that resumes it, so no field in it could hold the
 * answer for both. Only the scheduler knows, and only while it is scheduling.
 *
 * Unlike a finished cell, this is not best-effort. It is written before any
 * cell is graded, so refusing here costs a run nothing, and a run whose grid
 * was never recorded is one no later reader can bound.
 *
 * Resuming appends the new invocation's grid to the previous one and the
 * reader takes the union, so a canary continued at full width is expected to
 * hold every cell either invocation scheduled.
 */
export async function appendScheduledCells(
  path: string,
  cells: readonly ScheduledCellRecord[],
): Promise<void> {
  if (cells.length === 0) throw new Error(`${path}: a run schedules at least one cell`);
  await mkdir(dirname(path), { recursive: true });
  await truncateTornTail(path);
  await appendFile(
    path,
    cells.map((cell) => `${JSON.stringify({ agent: cell.agent, taskId: cell.taskId })}\n`).join(''),
    'utf8',
  );
}

/** Every cell this run ever scheduled, each named once. */
export async function readScheduledCellLog(path: string): Promise<ScheduledCellRecord[]> {
  const text = await readFile(path, 'utf8');
  const byCell = new Map<string, ScheduledCellRecord>();
  for (const { value, where } of parseRows(path, text)) {
    const cell = assertScheduledCellRecord(value, where);
    byCell.set(JSON.stringify([cell.agent, cell.taskId]), cell);
  }
  return [...byCell.values()];
}

function assertScheduledCellRecord(value: unknown, where: string): ScheduledCellRecord {
  if (!value || typeof value !== 'object') throw new Error(`${where} is not an object`);
  const record = value as Record<string, unknown>;
  for (const field of ['agent', 'taskId'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`${where} is missing ${field}`);
    }
  }
  return { agent: record.agent as string, taskId: record.taskId as string };
}
