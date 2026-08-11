import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runHostedExecution } from '@maka/runtime-host/client';
import type { HostedExecutionStartInput } from '@maka/runtime-host/protocol';

const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
  rootPath: string;
  baseUrl: string;
  execution: HostedExecutionStartInput;
};
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const runtimeHome = join(dirname(payload.rootPath), `${process.pid}-home`);
await mkdir(payload.rootPath, { recursive: true });
await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
process.env.HOME = runtimeHome;
process.env.DEEPSEEK_BASE_URL = payload.baseUrl;
const result = await runHostedExecution({
  rootPath: payload.rootPath,
  execution: payload.execution,
  electionDeadlineMs: 120_000,
  signal: abort.signal,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.kind === 'indeterminate') process.exitCode = 1;
