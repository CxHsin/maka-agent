import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { withProcessFileLock } from '../file-update-lock.js';

test('process file lock is released when its holder is killed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-process-file-lock-'));
  const lockPath = join(directory, 'operation.lock');
  const fixture = fileURLToPath(new URL('./fixtures/process-file-lock-holder.js', import.meta.url));
  const child = spawn(process.execPath, [fixture, lockPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await waitForLine(child.stdout, 'locked');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    let acquired = false;
    await withProcessFileLock(
      lockPath,
      async () => {
        acquired = true;
      },
      1_000,
    );
    assert.equal(acquired, true);
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForLine(stream: NodeJS.ReadableStream | null, expected: string): Promise<void> {
  if (!stream) throw new Error('Process file lock fixture stdout is unavailable');
  await new Promise<void>((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      if (!buffered.split('\n').includes(expected)) return;
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Process file lock fixture exited before reporting ${expected}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
  });
}
