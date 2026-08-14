import { lstat, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tryLock, unlock } from 'fs-native-extensions';

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const OPERATION_LOCK_TIMEOUT_MS = 120_000;
const processFileLockQueues = new Map<string, Promise<void>>();

export async function withFileUpdateLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `File update is locked by another process (${lockPath}). ` +
            'If no other process is using it, remove that directory and retry.',
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function withProcessFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs: number = OPERATION_LOCK_TIMEOUT_MS,
): Promise<T> {
  const previous = processFileLockQueues.get(lockPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  processFileLockQueues.set(lockPath, queued);
  await previous;
  try {
    return await withProcessFileLockFd(lockPath, operation, timeoutMs);
  } finally {
    releaseQueue();
    if (processFileLockQueues.get(lockPath) === queued) processFileLockQueues.delete(lockPath);
  }
}

async function withProcessFileLockFd<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const flags =
    process.platform === 'win32'
      ? 'a+'
      : constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW;
  const handle = await open(lockPath, flags, 0o600);
  let locked = false;
  try {
    await assertStableRegularFile(handle, lockPath);
    await handle.chmod(0o600);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      locked = tryLock(handle.fd);
      if (locked) break;
      if (Date.now() >= deadline) {
        throw new Error(`File operation is locked by another process (${lockPath})`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
    await assertStableRegularFile(handle, lockPath);
    return await operation();
  } finally {
    try {
      if (locked) unlock(handle.fd);
    } finally {
      await handle.close();
    }
  }
}

async function assertStableRegularFile(handle: FileHandle, path: string): Promise<void> {
  const [opened, published] = await Promise.all([handle.stat(), lstat(path)]);
  if (
    !opened.isFile() ||
    !published.isFile() ||
    opened.dev !== published.dev ||
    opened.ino !== published.ino
  ) {
    throw new Error(`File operation lock must be a stable regular file (${path})`);
  }
}
