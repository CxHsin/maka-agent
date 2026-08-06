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
import { trialCellLogPath } from '#trial-cell-log';
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

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const logPath = trialCellLogPath(args['run-root']);
  let report;
  try {
    report = await scanRunForContamination({
      trialCellLogPath: logPath,
      identity: flattenBenchmarkIdentity(BENCHMARK_IDENTITY),
    });
  } catch (error) {
    // No log at all is not "this run is clean" and not a crash to read a stack
    // trace out of. It is either a run whose every cell died before a trial
    // directory existed, or a run root that never wrote one — and the two are
    // not distinguishable from here, so say what is missing and stop.
    if (error?.code === 'ENOENT') {
      throw new Error(
        `no cell log at ${logPath}: this run recorded no trial, or is not a harness run root`,
      );
    }
    throw error;
  }
  if (args.json) await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderContaminationScanReportMarkdown(report);
  if (args.markdown) await writeFile(args.markdown, markdown);
  else process.stdout.write(markdown);
  // Three things make this non-zero, and each is something a person has to act
  // on: a cell that went and got something, a trajectory that could not be
  // searched, and a run in which nothing at all was read.
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
