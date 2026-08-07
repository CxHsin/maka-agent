/// <reference path="./fs-native-extensions.d.ts" />

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tryLock, unlock } from 'fs-native-extensions';

const OPERATIONAL_STATE_COMPATIBILITY_LOCK_FILE = 'runtime.sqlite.compatibility.lock';

export interface OperationalStateCompatibilityLock {
  readonly path: string;
  close(): void;
}

export function acquireOperationalStateCompatibilityLock(
  workspaceRoot: string,
): OperationalStateCompatibilityLock {
  const lock = tryAcquireOperationalStateLock(workspaceRoot, true);
  if (lock) return lock;
  throw new Error(
    'Operational state is unavailable while a breaking schema migration owns this workspace',
  );
}

export function tryAcquireOperationalStateMigrationLock(
  workspaceRoot: string,
): OperationalStateCompatibilityLock | undefined {
  return tryAcquireOperationalStateLock(workspaceRoot, false);
}

function tryAcquireOperationalStateLock(
  workspaceRoot: string,
  shared: boolean,
): OperationalStateCompatibilityLock | undefined {
  const canonicalRoot = resolve(workspaceRoot);
  mkdirSync(canonicalRoot, { recursive: true });
  const path = join(canonicalRoot, OPERATIONAL_STATE_COMPATIBILITY_LOCK_FILE);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let acquired = false;
  try {
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    assertStableRegularFile(fd, path);
    acquired = tryLock(fd, { shared });
    if (!acquired) {
      closeSync(fd);
      return undefined;
    }
    assertStableRegularFile(fd, path);
  } catch (error) {
    if (acquired) releaseLock(fd);
    closeSync(fd);
    throw error;
  }

  let closed = false;
  return Object.freeze({
    path,
    close: () => {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      try {
        unlock(fd);
      } catch (error) {
        errors.push(error);
      }
      try {
        closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Unable to close the operational compatibility lock');
      }
    },
  });
}

function assertStableRegularFile(fd: number, path: string): void {
  const handleStat = fstatSync(fd, { bigint: true });
  const pathStat = lstatSync(path, { bigint: true });
  if (
    !handleStat.isFile() ||
    !pathStat.isFile() ||
    handleStat.dev !== pathStat.dev ||
    handleStat.ino !== pathStat.ino
  ) {
    throw new Error(`Operational compatibility lock is not one stable regular file: ${path}`);
  }
}

function releaseLock(fd: number): void {
  try {
    unlock(fd);
  } catch {
    // Closing the descriptor is the final OS-level release path.
  }
}
