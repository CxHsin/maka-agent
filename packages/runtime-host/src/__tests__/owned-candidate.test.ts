import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHostedExecution } from '../client/hosted-execution.js';
import { launchOwnedRuntimeHostCandidate } from '../client/launcher.js';

test('owned candidate settlement requires a clean process exit', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-candidate-'));
  const launch = launchOwnedRuntimeHostCandidate({
    rootPath,
    expectedRootId: '00000000-0000-4000-8000-000000000001',
    entrypoint: new URL('./fixtures/owned-candidate-exit.js', import.meta.url),
    env: { MAKA_TEST_EXIT_CODE: '1' },
  });

  const candidate = await launch.spawned;
  assert.equal(await candidate.settle(2_000), false);
});

test('owned candidate preserves private startup diagnostics in its root', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-candidate-'));
  const launch = launchOwnedRuntimeHostCandidate({
    rootPath,
    expectedRootId: '00000000-0000-4000-8000-000000000001',
    entrypoint: new URL('./fixtures/owned-candidate-exit.js', import.meta.url),
    env: { MAKA_TEST_DIAGNOSTIC: 'candidate-startup-failed' },
  });

  const candidate = await launch.spawned;
  assert.equal(await candidate.settle(2_000), true);
  assert.equal(
    await readFile(join(rootPath, 'runtime-host-candidate.log'), 'utf8'),
    'candidate-startup-failed\n',
  );
});

test('owned candidate can be released to the enclosing environment without termination', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-candidate-'));
  const launch = launchOwnedRuntimeHostCandidate({
    rootPath,
    expectedRootId: '00000000-0000-4000-8000-000000000001',
    entrypoint: new URL('./fixtures/owned-candidate-wait.js', import.meta.url),
  });
  const candidate = await launch.spawned;

  candidate.releaseToEnvironment();
  assert.doesNotThrow(() => process.kill(candidate.pid, 0));

  process.kill(candidate.pid, 'SIGTERM');
  assert.equal(await candidate.settle(2_000), false);
});

test('owned hosted execution closes its fresh Host after configuration fails', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-hosted-execution-'));
  const result = await runHostedExecution({
    rootPath,
    execution: {
      executionId: '00000000-0000-4000-8000-000000000002',
      session: {
        workspace: { kind: 'host_path', path: rootPath },
        modelTarget: { kind: 'explicit', connectionSlug: 'missing', model: 'missing' },
      },
      content: { text: 'This request must not reach a provider.' },
    },
    baseUrl: 'http://127.0.0.1:1',
    hostSettlementTimeoutMs: 5_000,
  });

  assert.equal(result.kind, 'indeterminate');
  assert.equal(result.failureReason, 'Runtime Host connection failed before execution settlement');
});

test('pre-cancelled hosted execution does not start a Runtime Host', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-owned-hosted-execution-'));
  const abort = new AbortController();
  abort.abort();

  const result = await runHostedExecution({
    rootPath,
    execution: {
      executionId: '00000000-0000-4000-8000-000000000003',
      session: {
        workspace: { kind: 'host_path', path: rootPath },
        modelTarget: { kind: 'default' },
      },
      content: { text: 'This request must not start a Runtime Host.' },
    },
    signal: abort.signal,
  });

  assert.equal(result.kind, 'indeterminate');
  assert.deepEqual(await readdir(rootPath), []);
});
