import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { tryAcquireOperationalStateMigrationLock } from '../operational-state-compatibility-lock.js';

test('a live operational database lease excludes a breaking migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-compatibility-lock-'));
  const holder = fork(
    new URL('./fixtures/operational-state-lease-holder.js', import.meta.url),
    [root],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    acquireOperationalStateDatabase(root).close();
    await waitForReady(holder);
    assert.equal(tryAcquireOperationalStateMigrationLock(root), undefined);

    holder.send('close');
    await waitForExit(holder);

    const migration = tryAcquireOperationalStateMigrationLock(root);
    assert.ok(migration);
    migration.close();
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`operational lease holder exited before ready: ${code ?? signal}`));
    });
    child.once('message', (message) => {
      if (
        message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'ready'
      ) {
        resolve();
      } else {
        reject(new Error(`unexpected operational lease holder message: ${String(message)}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`operational lease holder failed: ${code ?? signal}`));
    });
  });
}
