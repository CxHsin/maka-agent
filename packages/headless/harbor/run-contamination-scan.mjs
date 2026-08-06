#!/usr/bin/env node
/**
 * Scan a finished run's trajectories for signs an arm looked the answer up.
 *
 * Host-only, like everything else in this directory that touches benchmark
 * identity: the scan needs the upstream URL, pinned revision and task list to
 * search for, and those are exactly what must not be reachable from inside a
 * graded container. The scanner in `dist` holds none of them — it takes them as
 * an argument, and this is where they are loaded.
 *
 * Which cells exist is likewise not this file's inference. The run wrote them
 * down as it went; this reads that list.
 *
 * Usage:
 *   node run-contamination-scan.mjs --run-root <dir> [--json <path>] [--markdown <path>]
 */

import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  flattenBenchmarkIdentity,
  renderContaminationScanReportMarkdown,
  scanRunForContamination,
} from '#harness-contamination-scan';
import { readScheduledCellLog, scheduledCellLogPath, trialCellLogPath } from '#trial-cell-log';
import { BENCHMARK_IDENTITY } from './benchmark-identity.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--run-root' || flag === '--json' || flag === '--markdown') {
      if (!value) throw new Error(`${flag} requires a value`);
      args[flag.slice(2)] = value;
      index += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!args['run-root']) throw new Error('--run-root is required');
  return args;
}

/**
 * The grid the run put on its schedule, read from the run's own record of it.
 *
 * Whether the cell log holds the whole run is a fact about the run, and the
 * run wrote it down as it scheduled. Without it a run killed at cell three
 * certifies the three cells that reached disk. Deriving it instead from the
 * frozen manifest would be a guess: that file holds the benchmark's whole task
 * list, of which a run grades a slice.
 */
async function expectedCells(runRoot) {
  const path = scheduledCellLogPath(runRoot);
  let cells;
  try {
    cells = await readScheduledCellLog(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`no scheduled-cell log at ${path}: this is not a harness run root`);
    }
    throw error;
  }
  if (cells.length === 0) throw new Error(`${path} names no cells`);
  return cells;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = await scanRunForContamination({
    trialCellLogPath: trialCellLogPath(args['run-root']),
    identity: flattenBenchmarkIdentity(BENCHMARK_IDENTITY),
    expectedCells: await expectedCells(args['run-root']),
  });
  if (args.json) await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderContaminationScanReportMarkdown(report);
  if (args.markdown) await writeFile(args.markdown, markdown);
  else process.stdout.write(markdown);
  // Four things make this non-zero, and each is something a person has to act
  // on: a cell that went and got something, a cell the run declared and never
  // recorded, a trajectory that could not be searched, and a run in which
  // nothing at all was read.
  //
  // The last is the one worth spelling out. A zero exit is read as "no
  // contamination", so a run whose output never landed — cells declared, none
  // searched — must not return it: that would be a verdict on no evidence, the
  // thing this whole tool exists to refuse. Zero means cells were searched and
  // came back clean.
  //
  // What is deliberately *not* here: task-id mentions on their own, which a
  // model can produce from what it already knew. An alarm that fires on every
  // run is not an alarm. They are counted in the report, which is where a fact
  // that needs judgement rather than action belongs.
  const unsearched = report.totals.cells - report.totals.analyzed;
  return report.totals.cellsWithRetrievalSignals > 0 ||
    report.unrecordedCells.length > 0 ||
    unsearched > 0 ||
    report.totals.analyzed === 0
    ? 1
    : 0;
}

// Compared as real paths, not as strings. A tool whose whole contract is its
// exit code must not silently do nothing and return zero because it was
// invoked through a symlink — which on macOS is every path under `/tmp`.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exit(2);
    },
  );
}
