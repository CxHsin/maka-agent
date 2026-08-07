#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const manifestPath = 'packages/storage/src/operational-schema-manifest.ts';
const probePattern =
  /^packages\/storage\/src\/__tests__\/fixtures\/operational-epoch-(\d+)-probe\.ts$/;

export function validateOperationalProbeChanges({
  baseEpoch,
  currentEpoch,
  baseBreakingChanges = 0,
  currentBreakingChanges = 0,
  changes,
}) {
  if (!Number.isSafeInteger(baseEpoch) || baseEpoch < 0) throw new Error('invalid base epoch');
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 1) {
    throw new Error('invalid current epoch');
  }
  if (currentEpoch < baseEpoch) {
    throw new Error(
      `Operational reader epoch cannot decrease from ${baseEpoch} to ${currentEpoch}`,
    );
  }
  if (baseEpoch > 0 && currentEpoch > baseEpoch + 1) {
    throw new Error(`Operational reader epoch must advance one step after ${baseEpoch}`);
  }
  if (currentBreakingChanges > baseBreakingChanges && currentEpoch === baseEpoch) {
    throw new Error('A new breaking operational schema declaration must raise the reader epoch');
  }
  if (baseEpoch > 0 && currentEpoch > baseEpoch && currentBreakingChanges === baseBreakingChanges) {
    throw new Error('An operational reader epoch increase requires a new breaking declaration');
  }

  const addedEpochs = new Set();
  for (const change of changes) {
    const match = probePattern.exec(change.path);
    if (!match) continue;
    const epoch = Number(match[1]);
    if (change.status !== 'A') {
      throw new Error(
        `Frozen operational epoch probe cannot be modified or deleted: ${change.path}`,
      );
    }
    addedEpochs.add(epoch);
  }

  if (currentEpoch === baseEpoch) {
    if (addedEpochs.size > 0) {
      throw new Error('A new operational epoch probe requires a reader epoch increase');
    }
    return;
  }
  if (!addedEpochs.has(currentEpoch)) {
    throw new Error(
      `Reader epoch ${currentEpoch} requires a new frozen epoch-${currentEpoch} probe`,
    );
  }
  for (const epoch of addedEpochs) {
    if (epoch !== currentEpoch) {
      throw new Error(
        `Unexpected operational epoch-${epoch} probe while adopting epoch ${currentEpoch}`,
      );
    }
  }
}

function parseEpoch(source, label) {
  if (source === undefined) return 0;
  const match = /export const OPERATIONAL_STATE_READER_EPOCH = (\d+);/.exec(source);
  if (!match) throw new Error(`Unable to read operational reader epoch from ${label}`);
  return Number(match[1]);
}

function countBreakingChanges(source) {
  return source?.match(/compatibility:\s*'breaking'/g)?.length ?? 0;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sourceAtRevision(revision, path) {
  try {
    return git(['show', `${revision}:${path}`]);
  } catch {
    return undefined;
  }
}

export function parseOperationalProbeChanges(output) {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [status, ...paths] = line.split('\t');
      if (status.startsWith('R')) {
        return [
          { status: 'D', path: paths[0] },
          { status: 'A', path: paths[1] },
        ];
      }
      if (status.startsWith('C')) return [{ status: 'A', path: paths[1] }];
      return { status: status[0], path: paths.at(-1) };
    });
}

function main(args) {
  const baseIndex = args.indexOf('--base');
  const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
  if (!base) throw new Error('usage: check-operational-schema-compatibility --base <commit>');
  const baseManifest = sourceAtRevision(base, manifestPath);
  const currentManifest = readFileSync(resolve(repoRoot, manifestPath), 'utf8');
  const baseEpoch = parseEpoch(baseManifest, `${base}:${manifestPath}`);
  const currentEpoch = parseEpoch(currentManifest, manifestPath);
  const changes = parseOperationalProbeChanges(
    git([
      'diff',
      '--name-status',
      `${base}...HEAD`,
      '--',
      'packages/storage/src/__tests__/fixtures/operational-epoch-*-probe.ts',
    ]),
  );
  validateOperationalProbeChanges({
    baseEpoch,
    currentEpoch,
    baseBreakingChanges: countBreakingChanges(baseManifest),
    currentBreakingChanges: countBreakingChanges(currentManifest),
    changes,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
