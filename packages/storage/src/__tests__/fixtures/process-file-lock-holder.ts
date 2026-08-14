import { withProcessFileLock } from '../../file-update-lock.js';

const lockPath = process.argv[2];
if (!lockPath) throw new Error('Process file lock fixture requires a lock path');

await withProcessFileLock(lockPath, async () => {
  process.stdout.write('locked\n');
  await new Promise<void>(() => undefined);
});
