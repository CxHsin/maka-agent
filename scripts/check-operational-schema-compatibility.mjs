#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const historyPath = 'packages/storage/src/operational-schema-history.json';
const probeTestPath = 'packages/storage/src/__tests__/operational-epoch-probe.test.ts';
const probePattern =
  /^packages\/storage\/src\/__tests__\/fixtures\/operational-epoch-(\d+)-probe\.ts$/;
const currentProbeReference = 'operational-epoch-${OPERATIONAL_STATE_READER_EPOCH}-probe.js';

export function validateOperationalSchemaHistory({ baseScopes, currentScopes }) {
  const currentByScope = uniqueScopes(currentScopes, 'current');
  for (const baseScope of uniqueScopes(baseScopes, 'base').values()) {
    const currentScope = currentByScope.get(baseScope.scope);
    if (!currentScope) {
      throw new Error(`Operational schema history cannot delete scope ${baseScope.scope}`);
    }
    if (currentScope.baselineVersion !== baseScope.baselineVersion) {
      throw new Error(
        `Operational schema history cannot change ${baseScope.scope} baseline version ${baseScope.baselineVersion}`,
      );
    }
    if (currentScope.changes.length < baseScope.changes.length) {
      throw new Error(`Operational schema history cannot delete ${baseScope.scope} declarations`);
    }
    for (const [index, baseChange] of baseScope.changes.entries()) {
      const currentChange = currentScope.changes[index];
      if (!sameSchemaChange(baseChange, currentChange)) {
        throw new Error(
          `Operational schema history cannot rewrite published version ${baseChange.version} in ${baseScope.scope}`,
        );
      }
    }
  }
}

export function validateCurrentProbeTestSource(source) {
  if (!source.includes(currentProbeReference)) {
    throw new Error('Operational epoch probe test must select the current reader epoch');
  }
}

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

function parseHistory(source, label) {
  if (source === undefined) return { readerEpoch: 0, scopes: [] };
  try {
    const history = JSON.parse(source);
    if (!history || !Number.isSafeInteger(history.readerEpoch) || !Array.isArray(history.scopes)) {
      throw new Error('invalid shape');
    }
    return history;
  } catch (error) {
    throw new Error(`Unable to read operational schema history from ${label}`, { cause: error });
  }
}

function countBreakingChanges(scopes) {
  return scopes.reduce(
    (count, scope) =>
      count + scope.changes.filter((change) => change.compatibility === 'breaking').length,
    0,
  );
}

function uniqueScopes(scopes, label) {
  const byScope = new Map();
  for (const scope of scopes) {
    if (
      !scope ||
      typeof scope.scope !== 'string' ||
      !Number.isSafeInteger(scope.baselineVersion) ||
      !Array.isArray(scope.changes) ||
      byScope.has(scope.scope)
    ) {
      throw new Error(`Operational schema ${label} history is invalid`);
    }
    byScope.set(scope.scope, scope);
  }
  return byScope;
}

function sameSchemaChange(left, right) {
  return (
    right !== undefined &&
    left.version === right.version &&
    left.compatibility === right.compatibility &&
    left.minimumReaderEpoch === right.minimumReaderEpoch &&
    left.summary === right.summary
  );
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
  const baseHistory = parseHistory(sourceAtRevision(base, historyPath), `${base}:${historyPath}`);
  const currentHistory = parseHistory(
    readFileSync(resolve(repoRoot, historyPath), 'utf8'),
    historyPath,
  );
  validateOperationalSchemaHistory({
    baseScopes: baseHistory.scopes,
    currentScopes: currentHistory.scopes,
  });
  validateCurrentProbeTestSource(readFileSync(resolve(repoRoot, probeTestPath), 'utf8'));
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
    baseEpoch: baseHistory.readerEpoch,
    currentEpoch: currentHistory.readerEpoch,
    baseBreakingChanges: countBreakingChanges(baseHistory.scopes),
    currentBreakingChanges: countBreakingChanges(currentHistory.scopes),
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
