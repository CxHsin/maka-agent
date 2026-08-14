import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExternalSubjectAdapter, recoverExternalMetering } from '../external-subject.js';
import type { ExperimentCell, ExperimentSpec } from '../experiment.js';
import type { CellAttempt } from '../result.js';
import { TOOLCHAIN_IDENTITIES, verifyToolchainDirectory } from '../toolchain-verification.js';

test('recovers lower-bound metering when external settlement is interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-metering-recovery-'));
  const trialPath = join(root, 'trial');
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 120,
  };
  try {
    await mkdir(join(trialPath, 'agent'), { recursive: true });
    await writeFile(
      join(trialPath, 'agent/codex.provider-usage.json'),
      // Two requests admitted, one of them still in flight, and usage seen for
      // only one of them: a killed wrapper's usage is a lower bound, and the
      // counts are what establish that. Nothing derivable is stored.
      `${JSON.stringify({
        schemaVersion: 'maka.external_provider_usage.v1',
        profile: 'codex',
        usage,
        settled: false,
        requests: 3,
        inFlightRequests: 1,
        admittedRequests: 2,
        usageRequests: 1,
        removedWebTools: 0,
        models: ['deepseek-v4-flash'],
        toolNames: ['shell'],
      })}\n`,
    );
    const recovered = await recoverExternalMetering({ trialPath }, 'codex');

    // Admitted model work survives the wrapper, which is what lets the caller
    // record a failed subject instead of retrying the cell.
    assert.equal(recovered?.admittedRequests, 2);
    assert.deepEqual(recovered?.usage, usage);
    // A lower-bound token count is worth keeping; a cost derived from it would
    // enter the result kernel indistinguishable from a settled figure.
    assert.equal(recovered?.costUsd, null);
    assert.equal(recovered?.artifact.usageComplete, false);
    assert.equal(recovered?.artifact.tokenBasis, 'lower-bound');
    // Derived here rather than read back from the file.
    assert.equal(recovered?.artifact.settledRequests, 2);
    assert.equal(recovered?.artifact.missingUsageRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a checkpoint the proxy never settled is a lower bound however complete it looks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-metering-stale-'));
  const trialPath = join(root, 'trial');
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 120,
  };
  // Every request this file knows about was admitted, settled and accounted
  // for. What it cannot say is whether it is the last word: a checkpoint
  // written between two requests looks exactly like this one, and the requests
  // that followed it are missing from it precisely because its writes failed.
  const checkpoint = {
    schemaVersion: 'maka.external_provider_usage.v1',
    profile: 'codex',
    usage,
    settled: false,
    requests: 1,
    inFlightRequests: 0,
    admittedRequests: 1,
    usageRequests: 1,
    removedWebTools: 0,
    models: [],
    toolNames: [],
  };
  try {
    await mkdir(join(trialPath, 'agent'), { recursive: true });
    const write = (settled: boolean) =>
      writeFile(
        join(trialPath, 'agent/codex.provider-usage.json'),
        `${JSON.stringify({ ...checkpoint, settled })}\n`,
      );

    await write(false);
    const unsettled = await recoverExternalMetering({ trialPath }, 'codex');
    assert.deepEqual(unsettled?.usage, usage);
    assert.equal(unsettled?.costUsd, null);
    assert.equal(unsettled?.artifact.usageComplete, false);
    assert.equal(unsettled?.artifact.tokenBasis, 'lower-bound');

    // The same counts, from a proxy that reported them as its last word.
    await write(true);
    const settled = await recoverExternalMetering({ trialPath }, 'codex');
    assert.equal(settled?.artifact.usageComplete, true);
    assert.equal(settled?.artifact.tokenBasis, 'complete');
    assert.ok((settled?.costUsd ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a metering checkpoint whose counts cannot describe one run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-metering-invalid-'));
  const trialPath = join(root, 'trial');
  try {
    await mkdir(join(trialPath, 'agent'), { recursive: true });
    const write = (checkpoint: Record<string, unknown>) =>
      writeFile(
        join(trialPath, 'agent/codex.provider-usage.json'),
        `${JSON.stringify({
          schemaVersion: 'maka.external_provider_usage.v1',
          profile: 'codex',
          usage: null,
          settled: false,
          requests: 1,
          inFlightRequests: 0,
          admittedRequests: 0,
          usageRequests: 0,
          removedWebTools: 0,
          models: [],
          toolNames: [],
          ...checkpoint,
        })}\n`,
      );

    await write({ admittedRequests: 2 });
    assert.equal(await recoverExternalMetering({ trialPath }, 'codex'), undefined);

    await write({ usageRequests: 1, admittedRequests: 0 });
    assert.equal(await recoverExternalMetering({ trialPath }, 'codex'), undefined);

    // Usage counted but no usage recorded.
    await write({ admittedRequests: 1, usageRequests: 1 });
    assert.equal(await recoverExternalMetering({ trialPath }, 'codex'), undefined);

    // Nothing is in flight once the proxy has stopped.
    await write({ settled: true, requests: 1, inFlightRequests: 1, admittedRequests: 1 });
    assert.equal(await recoverExternalMetering({ trialPath }, 'codex'), undefined);

    // A request admitted while still in flight is the state the checkpoint
    // exists to capture, so it has to survive validation.
    await write({ requests: 1, inFlightRequests: 1, admittedRequests: 1 });
    assert.equal((await recoverExternalMetering({ trialPath }, 'codex'))?.admittedRequests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('passes declared environment and credential bindings to one external command', async () => {
  const cell = externalCell({
    command: '/opt/pi/bin/pi',
    args: ['--cwd', '{{task.cwd}}', '--print', '{{task.input}}'],
    environment: { PI_OFFLINE: '1' },
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    result: 'exit-code',
  });
  let request: unknown;

  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'solve the task',
      metadata: {},
      execute: async (input) => {
        request = input;
        return { termination: 'exited', exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  assert.deepEqual(request, {
    command: '/opt/pi/bin/pi',
    args: ['--cwd', '/app', '--print', 'solve the task'],
    environment: { PI_OFFLINE: '1' },
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    captureStdout: false,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.usage, null);
  assert.equal(result.costUsd, null);
});

test('classifies missing executor process scope as infrastructure failure', async () => {
  const cell = externalCell({
    command: '/opt/pi/bin/pi',
    args: ['--print', '{{task.input}}'],
    credentialEnvironment: { DEEPSEEK_API_KEY: 'PROVIDER_KEY' },
    result: 'exit-code',
  });

  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/workspace',
      taskInput: 'solve',
      metadata: {},
      execute: async () => ({
        termination: 'exited',
        exitCode: 111,
        stdout: '',
        diagnostic: {
          category: 'execution-scope-unavailable',
          bytes: 0,
          sha256: createHash('sha256').update('').digest('hex'),
        },
      }),
    },
  });

  assert.equal(result.status, 'infra_failed');
  assert.equal(result.failureReason, 'external subject execution scope was unavailable');
});

test('requires the bundled wrapper for the structured result contract', () => {
  for (const args of [[], ['/tmp/harbor-external-subject.js', 'codex']]) {
    const cell = externalCell({ command: '/opt/tool', args });
    assert.throws(
      () => createExternalSubjectAdapter().validate?.(cell),
      /protocol-v1 requires the bundled result wrapper/u,
    );
  }
});

test('rejects credential bindings that the subject did not declare', () => {
  const cell = externalCell({
    command: '/opt/tool',
    args: [],
    credentialEnvironment: { DEEPSEEK_API_KEY: 'UNDECLARED_KEY' },
    result: 'exit-code',
  });

  assert.throws(
    () => createExternalSubjectAdapter().validate?.(cell),
    /credentialEnvironment\.DEEPSEEK_API_KEY must reference a declared credential/u,
  );
});

test('rejects overlap between public environment and credential targets', () => {
  const cell = externalCell({
    command: '/opt/tool',
    args: [],
    environment: { API_KEY: 'not-a-secret' },
    credentialEnvironment: { API_KEY: 'PROVIDER_KEY' },
    result: 'exit-code',
  });

  assert.throws(
    () => createExternalSubjectAdapter().validate?.(cell),
    /environment and credentialEnvironment overlap at API_KEY/u,
  );
});

test('rejects overlap with identity credential targets', () => {
  const cell = externalCell({
    command: '/opt/tool',
    args: [],
    environment: { PROVIDER_KEY: 'not-a-secret' },
    result: 'exit-code',
  });

  assert.throws(
    () => createExternalSubjectAdapter().validate?.(cell),
    /environment and credentialEnvironment overlap at PROVIDER_KEY/u,
  );
});

// The pinned fingerprint is the digest of the checksum manifest. A tree that
// merely carries an internally consistent manifest is not the pinned toolchain,
// and a directory saying so in its own manifest.json proves nothing — which is
// exactly what an earlier version of this check accepted.
test('the pinned fingerprint is the digest of the checksum manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-toolchain-identity-'));
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(join(root, 'bin/codex'), 'codex');
    const digest = createHash('sha256').update('codex').digest('hex');
    const checksums = `${digest}  bin/codex\n`;
    await writeFile(join(root, 'checksums.sha256'), checksums);
    const identity = {
      root: '/opt/maka-codex-toolchain',
      version: '1',
      fingerprint: `sha256:${createHash('sha256').update(checksums).digest('hex')}`,
    };

    assert.deepEqual(await verifyToolchainDirectory('codex', root, identity), identity);

    // The tree is intact and self-consistent; only the identity differs.
    await assert.rejects(
      verifyToolchainDirectory('codex', root, { ...identity, fingerprint: 'sha256:other' }),
      /codex toolchain fingerprint mismatch/u,
    );

    // A file changed together with its own checksum line keeps the manifest
    // self-consistent and still changes the tree's identity.
    await writeFile(join(root, 'bin/codex'), 'tampered');
    const tampered = createHash('sha256').update('tampered').digest('hex');
    await writeFile(join(root, 'checksums.sha256'), `${tampered}  bin/codex\n`);
    await assert.rejects(
      verifyToolchainDirectory('codex', root, identity),
      /codex toolchain fingerprint mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a mounted toolchain that is not the pinned tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-toolchain-'));
  const executable = join(root, 'bin/codex');
  const sourceEnv = 'MAKA_TEST_CODEX_TOOLCHAIN';
  const previous = process.env[sourceEnv];
  process.env[sourceEnv] = root;
  try {
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(executable, 'codex');
    const digest = createHash('sha256').update('codex').digest('hex');
    await writeFile(join(root, 'checksums.sha256'), `${digest}  bin/codex\n`);
    // Declaring the pinned identity is what the tree cannot do for itself.
    await writeFile(
      join(root, 'manifest.json'),
      `${JSON.stringify({ fingerprint: TOOLCHAIN_IDENTITIES.codex.fingerprint })}\n`,
    );
    const cell = {
      ...externalCell({
        command: '/opt/maka-node-toolchain/bin/node',
        args: [
          '/opt/maka-agent/packages/eval/dist/harbor-external-subject.js',
          'codex',
          'https://api.deepseek.com',
          '/',
          '/opt/maka-codex-toolchain/bin/codex',
        ],
      }),
      executor: {
        kind: 'harbor',
        config: {
          mounts: [
            {
              sourceEnv,
              target: TOOLCHAIN_IDENTITIES.codex.root,
              readOnly: true,
            },
          ],
        },
      },
    } satisfies ExperimentCell;
    const adapter = createExternalSubjectAdapter();
    await assert.rejects(
      adapter.prepare?.({ spec: {} as ExperimentSpec, cells: [cell] }) ?? Promise.resolve(),
      /codex toolchain fingerprint mismatch/u,
    );

    // Nothing was admitted, so no attempt against this cell is reusable — not
    // even one carrying the pinned fingerprint it failed to prove.
    assert.equal(
      adapter.canReuse?.({
        cell,
        attempt: toolchainAttempt(cell.id, TOOLCHAIN_IDENTITIES.codex.fingerprint),
      }),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env[sourceEnv];
    else process.env[sourceEnv] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

function toolchainAttempt(cellId: string, fingerprint: string): CellAttempt {
  return {
    cellId,
    sequence: 1,
    startedAt: 1,
    completedAt: 2,
    result: {
      score: 1,
      usage: null,
      costUsd: null,
      durationMs: 1,
      status: 'completed',
      failureReason: null,
      artifacts: [
        {
          kind: 'toolchain',
          profile: 'codex',
          version: TOOLCHAIN_IDENTITIES.codex.version,
          fingerprint,
        },
      ],
    },
  };
}

function externalCell(config: ExperimentCell['subject']['config']): ExperimentCell {
  return {
    id: 'task::1::external',
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: {
      id: 'external',
      kind: 'external',
      credentials: ['PROVIDER_KEY'],
      config,
    },
    task: { id: 'task', input: 'instruction', config: {} },
    repetition: 1,
    budget: { maxSteps: 100 },
    verifier: {},
  };
}
