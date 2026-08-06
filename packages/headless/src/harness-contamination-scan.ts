import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTrialCellLog, type TrialCellRecord } from './trial-cell-log.js';

/**
 * Did a graded cell go and get the benchmark instead of solving it?
 *
 * The scan reads the run's own cell log — which arm ran which task in which
 * directory, written by the harness while it still knew — opens each cell's
 * normalized trajectory, and searches it for strings the cell had no legitimate
 * way to hold. It reconstructs nothing about the run: a fact the harness did
 * not write down is a fact this file does not have, and says so, rather than
 * inferring it from the shape of the tree.
 */

/** Where a trajectory sits inside a trial directory, per the ATIF layout. */
const TRAJECTORY_RELATIVE_PATH = join('agent', 'trajectory.json');

export interface BenchmarkIdentity {
  /**
   * Every upstream repository, revision and task-tree fingerprint the catalog
   * knows, and every task id in it, as one set.
   *
   * The profiles are variants of the same benchmarks, and none of these strings
   * is something a cell may legitimately hold whichever profile it ran under.
   * Searching for all of them costs one pass; picking the run's profile would
   * add a derivation that can be wrong and would decide which leak goes
   * unlooked-for when it is.
   */
  upstreamRepositoryUrls: readonly string[];
  revisions: readonly string[];
  taskTreeFingerprints: readonly string[];
  taskIds: readonly string[];
}

export type ContaminationSignalKind =
  | 'upstream_repository'
  | 'pinned_revision'
  | 'task_tree_fingerprint'
  | 'foreign_task_id';

/**
 * Signals whose presence is evidence the cell reached for something, as
 * distinct from evidence it knew something.
 *
 * A model can name this benchmark's tasks from its training data — one real
 * clean cell spent three steps reasoning aloud about which tasks the suite
 * contains — so `foreign_task_id` firing is not by itself a reason to fail a
 * run, and a check that failed on it would fail on well-read models rather
 * than on retrieval. It stays in the report because it does find things: in
 * that same run it caught a mounted directory of past evaluation reports.
 *
 * The other three are different in kind. Across nearly two hundred real cells
 * none of them fired once, because a pinned revision, a tree fingerprint and a
 * repository named next to a fetch are things a cell learns by going and
 * getting them.
 */
const RETRIEVAL_SIGNALS: readonly ContaminationSignalKind[] = [
  'upstream_repository',
  'pinned_revision',
  'task_tree_fingerprint',
];

export function isRetrievalSignal(kind: ContaminationSignalKind): boolean {
  return RETRIEVAL_SIGNALS.includes(kind);
}

export interface ContaminationSignal {
  kind: ContaminationSignalKind;
  /** The trajectory step the evidence is in, so a reviewer can go read it. */
  stepId: number | null;
  /** What matched, verbatim. */
  match: string;
  /** Surrounding text, bounded, so the match can be judged without the file. */
  excerpt: string;
}

export interface CellContaminationReport extends TrialCellRecord {
  trajectoryPath: string;
  /**
   * False when the trajectory cannot answer the question — missing, degraded,
   * unreadable. An unanalyzed cell is a hole in the run's coverage, and is
   * counted as one rather than as a clean cell.
   */
  analyzed: boolean;
  notAnalyzedReason?: string;
  signals: ContaminationSignal[];
}

export interface ContaminationScanReport {
  cells: CellContaminationReport[];
  /**
   * Cells the run declared it would grade and never recorded.
   *
   * A run killed part-way through, or one whose best-effort log write failed,
   * leaves artifacts the scan never looks at. Counting only what was recorded
   * would certify the surviving fraction and call it the run.
   */
  unrecordedCells: { agent: string; taskId: string }[];
  /** Coverage per arm, because a whole arm exporting nothing is the failure
   * mode that looks most like success. */
  coverageByAgent: Record<string, { cells: number; analyzed: number }>;
  totals: {
    cells: number;
    analyzed: number;
    cellsWithRetrievalSignals: number;
    cellsWithAdvisorySignalsOnly: number;
  };
}

/**
 * Read `benchmark-identity.json` as a flat set of needles.
 *
 * The file is nested by benchmark and by profile and gains profiles over time.
 * Walking it for the four field names takes every profile, present and future,
 * without this file holding a second copy of its shape.
 */
export function flattenBenchmarkIdentity(catalog: unknown): BenchmarkIdentity {
  const upstreamRepositoryUrls = new Set<string>();
  const revisions = new Set<string>();
  const taskTreeFingerprints = new Set<string>();
  const taskIds = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'upstreamRepositoryUrl' && typeof nested === 'string')
        upstreamRepositoryUrls.add(nested);
      else if (key === 'revision' && typeof nested === 'string') revisions.add(nested);
      else if (key === 'taskTreeFingerprint' && typeof nested === 'string')
        taskTreeFingerprints.add(nested);
      else if (key === 'taskIds' && Array.isArray(nested)) {
        for (const id of nested) if (typeof id === 'string') taskIds.add(id);
      } else visit(nested);
    }
  };
  visit(catalog);
  const identity = {
    upstreamRepositoryUrls: [...upstreamRepositoryUrls],
    revisions: [...revisions],
    taskTreeFingerprints: [...taskTreeFingerprints],
    taskIds: [...taskIds],
  };
  // A missing family is either the wrong file or a renamed field, and a scan
  // that lost one searches for less than it reports having searched for. Each
  // is required, not just enough of them to look populated: a rename of
  // `revision` alone would disarm the most specific retrieval needle there is
  // while the two coarser ones kept the report looking whole.
  const empty = Object.entries(identity)
    .filter(([, values]) => values.length === 0)
    .map(([family]) => family);
  if (empty.length > 0) {
    throw new Error(`benchmark identity carries no ${empty.join(', ')}`);
  }
  return identity;
}

/**
 * The shortest revision prefix worth searching for.
 *
 * A cell that fetched the upstream ran git, and git decides how much of the
 * revision it then sees: `git log --oneline` and `rev-parse --short` abbreviate
 * to seven by default. Searching for more than a cell was shown is searching
 * for a string it had no way to write, so seven is the floor — measured against
 * git rather than remembered, because `core.abbrev=auto` grows with object
 * count and only the smallest repository gives the shortest answer.
 *
 * Seven hex characters are not rare in the abstract, so the pattern is bounded
 * on the left against hex: this revision written down, not this revision
 * occurring inside an unrelated hash. It is deliberately unbounded on the
 * right, because the full forty-character revision is the match that matters
 * most and it continues in hex.
 */
export const MIN_REVISION_PREFIX = 7;

const EXCERPT_RADIUS = 80;

/**
 * How the Maka exporter labels what it managed to produce.
 *
 * `maka_trajectory.py` owns these; they are spelled here because this side has
 * to read them, and `harness-contamination-scan.test.ts` pins the spelling
 * against that file so the two cannot drift apart in silence.
 */
/** The one agent whose exporter can degrade, and which therefore must label. */
export const LABELLING_AGENT = 'maka';

export const TRAJECTORY_ARTIFACT_KIND_KEY = 'maka_artifact_kind';
export const TRAJECTORY_SUMMARY_REASON_KEY = 'maka_summary_reason';
export const TRAJECTORY_ARTIFACT_KIND_FULL = 'full';
export const TRAJECTORY_ARTIFACT_KIND_SUMMARY = 'summary';

/**
 * The reason this trajectory cannot be searched, or undefined if it can.
 *
 * One exporter here can degrade: when Maka cannot build a trajectory from the
 * events it writes a one-step summary instead, and a scan that searched that
 * step, matched nothing, and filed the cell under clean would be reporting on
 * nothing at all — which is what happened to a whole 89-cell run. A trajectory
 * that says `summary`, or that carries a label this file does not recognize,
 * refuses.
 *
 * An absent label is ordinary ATIF for every other arm: their trajectories come
 * from upstream Harbor agents that have no degraded mode and write no such
 * label. Demanding a label they were never going to carry would file every
 * competitor cell under "broken export", and an alarm that fires on every run
 * is not an alarm.
 *
 * But absent on a Maka trajectory is not ordinary — Maka always labels — so it
 * refuses too. The trajectory says whose it is, so this asks it rather than
 * assuming the exporter's behaviour has not changed since this was written.
 */
function notAnalyzableReason(
  trajectory: Record<string, unknown>,
  steps: unknown[],
): string | undefined {
  const extra = trajectory.extra;
  const kind =
    extra && typeof extra === 'object'
      ? (extra as Record<string, unknown>)[TRAJECTORY_ARTIFACT_KIND_KEY]
      : undefined;
  if (kind === TRAJECTORY_ARTIFACT_KIND_SUMMARY) {
    const reason =
      extra && typeof extra === 'object'
        ? (extra as Record<string, unknown>)[TRAJECTORY_SUMMARY_REASON_KEY]
        : undefined;
    return `trajectory degraded to a summary${typeof reason === 'string' ? `: ${reason}` : ''}`;
  }
  if (kind !== undefined && kind !== TRAJECTORY_ARTIFACT_KIND_FULL) {
    return `trajectory carries an unrecognized ${TRAJECTORY_ARTIFACT_KIND_KEY}: ${JSON.stringify(kind)}`;
  }
  if (kind === undefined && trajectoryAgentName(trajectory) === LABELLING_AGENT) {
    return `${LABELLING_AGENT} trajectory carries no ${TRAJECTORY_ARTIFACT_KIND_KEY}`;
  }
  if (steps.length === 0) return 'trajectory carries no steps';
  return undefined;
}

/** Scan one cell's trajectory against the benchmark catalog. */
export function scanTrajectory(input: {
  trajectory: unknown;
  ownTaskId: string;
  identity: BenchmarkIdentity;
}): { analyzed: boolean; notAnalyzedReason?: string; signals: ContaminationSignal[] } {
  if (!input.trajectory || typeof input.trajectory !== 'object') {
    return { analyzed: false, notAnalyzedReason: 'trajectory is not an object', signals: [] };
  }
  const trajectory = input.trajectory as Record<string, unknown>;
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const refusal = notAnalyzableReason(trajectory, steps);
  if (refusal) return { analyzed: false, notAnalyzedReason: refusal, signals: [] };

  const repositoryPatterns = input.identity.upstreamRepositoryUrls.map(repositoryPattern);
  const revisionPatterns = input.identity.revisions
    .map(revisionPattern)
    .filter((pattern): pattern is RegExp => pattern !== null);
  // Searched without the `sha256:` the catalog writes it with: the digest is
  // the fingerprint, and a cell that copied it out of a hex-only listing would
  // otherwise carry the whole of it and match none of it.
  const fingerprintPatterns = input.identity.taskTreeFingerprints.map(
    (fingerprint) => new RegExp(escapeRegExp(fingerprint.replace(/^[a-z0-9]+:/i, '')), 'gi'),
  );
  const ownTaskId = input.ownTaskId.toLowerCase();
  const foreignTaskPatterns = input.identity.taskIds
    // Compared case-insensitively, as the patterns match: a cell that writes
    // its own task id in another case is still describing its own work.
    .filter((taskId) => taskId.toLowerCase() !== ownTaskId)
    .map((taskId) => ({
      taskId,
      // Case-insensitive because a cell writes a task id however it likes. The
      // right boundary rejects a dot only when something identifier-like
      // follows it, because task ids carry dots — one of them ends in a version
      // number — while a mention at the end of a sentence ends in a bare dot.
      pattern: new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(taskId)}(?!\\.?[A-Za-z0-9_-])`, 'gi'),
    }));

  const signals: ContaminationSignal[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const id = stepId(step as Record<string, unknown>);
    for (const text of stepText(step)) {
      for (const pattern of repositoryPatterns)
        pushMatches(signals, 'upstream_repository', id, text, pattern);
      for (const pattern of revisionPatterns)
        pushMatches(signals, 'pinned_revision', id, text, pattern);
      for (const pattern of fingerprintPatterns)
        pushMatches(signals, 'task_tree_fingerprint', id, text, pattern);
      for (const foreign of foreignTaskPatterns)
        pushMatches(signals, 'foreign_task_id', id, text, foreign.pattern);
    }
  }
  return { analyzed: true, signals };
}

/**
 * Scan every cell a run recorded.
 *
 * The cell list is the run's, not this file's guess at it. A cell the harness
 * never got far enough to record — an arm that died before its trial directory
 * existed — is absent here, and the report says "recorded cells" rather than
 * "cells" so that a reader is not told a run was covered end to end on the
 * strength of the part of it that reached disk.
 */
export async function scanRunForContamination(input: {
  trialCellLogPath: string;
  identity: BenchmarkIdentity;
  /**
   * The grid the run scheduled: one entry per arm per evaluation task.
   * Supplied by the caller from the run's own record of what it scheduled,
   * because whether the log holds the whole run is a fact about the run, not
   * about the log.
   */
  expectedCells?: readonly { agent: string; taskId: string }[];
}): Promise<ContaminationScanReport> {
  const readTrajectory = (path: string) => readFile(path, 'utf8');
  const records = await readTrialCellLog(input.trialCellLogPath);
  const cells: CellContaminationReport[] = [];
  for (const record of records) {
    const trajectoryPath = join(record.trialDir, TRAJECTORY_RELATIVE_PATH);
    let scan: { analyzed: boolean; notAnalyzedReason?: string; signals: ContaminationSignal[] };
    try {
      const parsed: unknown = JSON.parse(await readTrajectory(trajectoryPath));
      scan = scanTrajectory({
        trajectory: parsed,
        ownTaskId: record.taskId,
        identity: input.identity,
      });
    } catch (error) {
      scan = {
        analyzed: false,
        notAnalyzedReason: `trajectory unreadable: ${(error as Error).message}`,
        signals: [],
      };
    }
    cells.push({ ...record, trajectoryPath, ...scan });
  }

  const coverageByAgent: Record<string, { cells: number; analyzed: number }> = {};
  for (const cell of cells) {
    const bucket = (coverageByAgent[cell.agent] ??= { cells: 0, analyzed: 0 });
    bucket.cells += 1;
    if (cell.analyzed) bucket.analyzed += 1;
  }
  const recorded = new Set(cells.map((cell) => cellKey(cell.agent, cell.taskId)));
  const unrecordedCells = (input.expectedCells ?? []).filter(
    (expected) => !recorded.has(cellKey(expected.agent, expected.taskId)),
  );
  return {
    cells,
    unrecordedCells: unrecordedCells.map((expected) => ({ ...expected })),
    coverageByAgent,
    totals: {
      cells: cells.length,
      analyzed: cells.filter((cell) => cell.analyzed).length,
      cellsWithRetrievalSignals: cells.filter((cell) =>
        cell.signals.some((signal) => isRetrievalSignal(signal.kind)),
      ).length,
      cellsWithAdvisorySignalsOnly: cells.filter(
        (cell) =>
          cell.signals.length > 0 && !cell.signals.some((signal) => isRetrievalSignal(signal.kind)),
      ).length,
    },
  };
}

/**
 * The report as a person reads it: what was searched first, what was found
 * second.
 *
 * Coverage leads because the finding that matters most is the one a reader
 * would otherwise supply themselves — "nothing fired" means nothing only if
 * something was read.
 */
export function renderContaminationScanReportMarkdown(report: ContaminationScanReport): string {
  const { totals } = report;
  const lines = [
    '# Contamination scan',
    '',
    `Searched ${totals.analyzed} of ${totals.cells} recorded cells.`,
    '',
    report.unrecordedCells.length > 0
      ? `**${report.unrecordedCells.length} ${report.unrecordedCells.length === 1 ? 'cell' : 'cells'} this run root was scheduled to grade hold no record that it did.** Whatever those cells did is not in this report.`
      : 'Recorded means the harness got far enough to resolve a trial directory. A cell that died before that is not counted here or anywhere below.',
    '',
    '| arm | cells | searched |',
    '| --- | --- | --- |',
    ...Object.entries(report.coverageByAgent)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agent, c]) => `| ${agent} | ${c.cells} | ${c.analyzed} |`),
    '',
    `Retrieval evidence: ${totals.cellsWithRetrievalSignals} cells. Task-id mentions only: ${totals.cellsWithAdvisorySignalsOnly} cells.`,
  ];

  if (report.unrecordedCells.length > 0) {
    lines.push('', '## Never recorded', '');
    for (const cell of report.unrecordedCells) {
      lines.push(`- \`${cell.taskId}\` (${cell.agent})`);
    }
  }

  const unsearched = report.cells.filter((cell) => !cell.analyzed);
  if (unsearched.length > 0) {
    lines.push('', '## Not searched', '');
    for (const cell of unsearched) {
      lines.push(`- \`${cell.roundId}\` (${cell.agent}): ${cell.notAnalyzedReason}`);
    }
  }

  const flagged = report.cells.filter((cell) => cell.signals.length > 0);
  if (flagged.length > 0) {
    lines.push('', '## Signals', '');
    for (const cell of flagged) {
      lines.push(`### \`${cell.roundId}\` (${cell.agent})`, '');
      for (const signal of cell.signals) {
        const where = signal.stepId === null ? 'step ?' : `step ${signal.stepId}`;
        lines.push(
          `- **${signal.kind}**${isRetrievalSignal(signal.kind) ? '' : ' (advisory)'}, ${where}: \`${signal.match}\``,
          `  > ${signal.excerpt.replace(/\n/g, ' ')}`,
        );
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The repository's identity, as the part of it that a rewritten host cannot
 * remove.
 *
 * Matching the catalog's own host would only catch a fetch spelled the way the
 * catalog spells it. The same repository is reachable by IP, through a mirror,
 * through `raw.githubusercontent.com`, over SSH — every one of which drops or
 * replaces the host while carrying `owner/repo` unchanged, because that pair
 * *is* the repository's name. Matching the pair closes the whole host-rewrite
 * family at once instead of one host at a time, and it is specific enough to be
 * quiet: neither benchmark's task instructions contain it.
 *
 * What this does not reach is a reference assembled rather than written —
 * encoded, or built from parts across steps. That is unbounded and this makes
 * no claim on it; the signals here are for references that appear verbatim.
 */
function trajectoryAgentName(trajectory: Record<string, unknown>): string | undefined {
  const agent = trajectory.agent;
  if (!agent || typeof agent !== 'object') return undefined;
  const name = (agent as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

function cellKey(agent: string, taskId: string): string {
  return JSON.stringify([agent, taskId]);
}

function repositoryPattern(upstreamRepositoryUrl: string): RegExp {
  const withoutScheme = upstreamRepositoryUrl
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const segments = withoutScheme.split('/');
  // Host, then owner and repository. Anything shorter is not a repository URL
  // and is matched whole rather than guessed at.
  const pair = segments.length >= 3 ? segments.slice(-2).join('/') : withoutScheme;
  // Bounded so a longer name is not read as this one, and bounded on the right
  // without `.`, because the commonest spelling of all ends in `.git`.
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(pair)}(?![A-Za-z0-9_-])`, 'gi');
}

function revisionPattern(revision: string): RegExp | null {
  if (revision.length < MIN_REVISION_PREFIX) return null;
  return new RegExp(`(?<![0-9a-f])${revision.slice(0, MIN_REVISION_PREFIX)}`, 'gi');
}

/**
 * Every string a trajectory step carries, flattened.
 *
 * Which field a leak lands in is not something to predict: an arm may name the
 * upstream in a shell command, in its own reasoning, or in a tool result it
 * read back. Walking the step whole costs nothing and cannot be outflanked by
 * an exporter adding a field.
 */
function stepText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stepText(item, out);
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) stepText(nested, out);
  }
  return out;
}

function stepId(step: Record<string, unknown>): number | null {
  return typeof step.step_id === 'number' ? step.step_id : null;
}

function pushMatches(
  signals: ContaminationSignal[],
  kind: ContaminationSignalKind,
  id: number | null,
  text: string,
  pattern: RegExp,
): void {
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    signals.push({
      kind,
      stepId: id,
      match: match[0],
      excerpt: excerptAround(text, index, match[0].length),
    });
  }
}

function excerptAround(haystack: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
