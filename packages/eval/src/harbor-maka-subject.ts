import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runHostedExecution } from '@maka/runtime-host/client';
import type { HostedExecutionStartInput } from '@maka/runtime-host/protocol';
import { disabledWebToolsRuntimePolicyDocument } from './maka-runtime-policy.js';
import { captureMakaRuntimeArtifacts, writeMakaArtifactCollectionError } from './maka-artifacts.js';

const payload = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString()) as {
  rootPath: string;
  artifactRoot: string;
  baseUrl: string;
  webTools: 'enabled' | 'disabled';
  hostSettlementTimeoutMs: number;
  execution: HostedExecutionStartInput;
};
const abort = new AbortController();
let artifactCapture = Promise.resolve();
const captureArtifacts = (reason: 'settled' | 'signal') => {
  artifactCapture = artifactCapture.then(async () => {
    try {
      await captureMakaRuntimeArtifacts({
        stateRoot: payload.rootPath,
        destinationRoot: payload.artifactRoot,
        reason,
      });
    } catch (error) {
      await writeMakaArtifactCollectionError(payload.artifactRoot, error).catch(() => undefined);
    }
  });
  return artifactCapture;
};
const stop = () => {
  abort.abort();
  void captureArtifacts('signal');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const runtimeHome = join(dirname(payload.rootPath), `${process.pid}-home`);
await mkdir(payload.rootPath, { recursive: true });
await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
if (payload.webTools === 'disabled') {
  await writeFile(
    join(payload.rootPath, 'runtime-policy.json'),
    `${JSON.stringify(disabledWebToolsRuntimePolicyDocument())}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
process.env.HOME = runtimeHome;
process.env.DEEPSEEK_BASE_URL = payload.baseUrl;
let result: Awaited<ReturnType<typeof runHostedExecution>>;
try {
  result = await runHostedExecution({
    rootPath: payload.rootPath,
    baseUrl: payload.baseUrl,
    execution: payload.execution,
    signal: abort.signal,
    hostSettlementTimeoutMs: payload.hostSettlementTimeoutMs,
  });
} finally {
  await captureArtifacts(abort.signal.aborted ? 'signal' : 'settled');
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.kind === 'indeterminate') process.exitCode = 1;
