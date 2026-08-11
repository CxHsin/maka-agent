import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileAttemptStore } from '../../attempt-store.js';

const root = process.argv[2]!;
await writeFile(join(root, `ready-${process.pid}`), '');
await waitFor(join(root, 'go'));
let entered = false;
try {
  await new FileAttemptStore(join(root, 'attempts')).runExclusive(async () => {
    entered = true;
    await writeFile(join(root, `entered-${process.pid}`), '');
    process.stdout.write('ENTER\n');
    await waitFor(join(root, 'release'));
  });
} catch {
  if (entered) throw new Error('writer barrier failed');
  await writeFile(join(root, `rejected-${process.pid}`), '');
  process.stdout.write('REJECT\n');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await exists(path))) {
    if (Date.now() >= deadline) throw new Error(`barrier timed out: ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
