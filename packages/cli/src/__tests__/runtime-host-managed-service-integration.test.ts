import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  createManagedRuntimeHostServiceConfig,
  createRuntimeHostServiceCatalog,
  publishRuntimeHostServiceStartAttempt,
  readRuntimeHostServiceStartAttempt,
  runtimeHostServiceConfigRevision,
  type ManagedRuntimeHostServiceConfig,
} from '../runtime-host-service-catalog.js';
import {
  inspectManagedRuntimeHostService,
  startManagedRuntimeHostService,
  stopManagedRuntimeHostService,
} from '../runtime-host-service-manager.js';
import {
  addManagedRuntimeHostProject,
  issueManagedRuntimeHostCredential,
  listManagedRuntimeHostCredentials,
  listManagedRuntimeHostProjects,
  revokeManagedRuntimeHostCredential,
} from '../runtime-host-service-operations.js';

const execFileAsync = promisify(execFile);

test('a short-lived manager starts two independent Hosts and leaves authority with each Host', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-managed-runtime-hosts-'));
  const clientDataRoot = join(base, 'client-data');
  const rootPaths = [join(base, 'office-root'), join(base, 'lab-root')];
  const configs: ManagedRuntimeHostServiceConfig[] = [];
  try {
    const ports = await Promise.all([availablePort(), availablePort()]);
    const roots = await Promise.all(
      rootPaths.map((path) => resolveStorageRoot({ path, kind: 'interactive' })),
    );
    configs.push(
      managedConfig('office', roots[0]!.canonicalPath, roots[0]!.rootId, ports[0]!),
      managedConfig('lab', roots[1]!.canonicalPath, roots[1]!.rootId, ports[1]!),
    );
    const catalog = createRuntimeHostServiceCatalog(clientDataRoot);
    await catalog.create(configs[0]!);
    await catalog.create(configs[1]!);
    const cliEntrypoint = fileURLToPath(new URL('../cli.js', import.meta.url));
    const expiredAttempt = await publishRuntimeHostServiceStartAttempt(
      clientDataRoot,
      configs[0]!.id,
      runtimeHostServiceConfigRevision(configs[0]!),
      '2000-01-01T00:00:00.000Z',
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cliEntrypoint,
          'runtime-host',
          'serve',
          '--managed-config',
          configs[0]!.id,
          '--expected-config-revision',
          runtimeHostServiceConfigRevision(configs[0]!),
          '--start-attempt',
          expiredAttempt.attemptId,
        ],
        {
          env: { ...process.env, MAKA_RUNTIME_HOST_MANAGED_CLIENT_DATA_ROOT: clientDataRoot },
          timeout: 10_000,
        },
      ),
    );
    assert.deepEqual(await inspectManagedRuntimeHostService(configs[0]!), { kind: 'stopped' });
    assert.equal(
      await readRuntimeHostServiceStartAttempt(clientDataRoot, configs[0]!.id),
      undefined,
    );

    const fixture = fileURLToPath(
      new URL('./fixtures/start-managed-runtime-hosts.js', import.meta.url),
    );
    await execFileAsync(process.execPath, [fixture, clientDataRoot, 'office', 'lab'], {
      timeout: 60_000,
    });

    const states = await Promise.all(
      configs.map((config) => inspectManagedRuntimeHostService(config)),
    );
    assert.equal(
      states.every((state) => state.kind === 'running'),
      true,
    );
    if (states[0]?.kind === 'running' && states[1]?.kind === 'running') {
      assert.notEqual(states[0].pid, states[1].pid);
      assert.notEqual(states[0].hostEpoch, states[1].hostEpoch);

      const killedEpoch = states[0].hostEpoch;
      const killedPid = states[0].pid;
      process.kill(killedPid, 'SIGKILL');
      const stale = await waitForRecoverableService(configs[0]!);
      assert.equal(stale.kind === 'unreachable' && stale.recoverable, true, JSON.stringify(stale));
      const restarted = await startManagedRuntimeHostService(configs[0]!, {
        clientDataRoot,
        entrypoint: cliEntrypoint,
      });
      assert.equal(restarted.kind, 'started');
      if (restarted.kind === 'started') {
        assert.notEqual(restarted.state.hostEpoch, killedEpoch);
        assert.notEqual(restarted.state.pid, killedPid);
      }
    }

    await addManagedRuntimeHostProject(configs[0]!, roots[0]!.canonicalPath);
    const projects = await listManagedRuntimeHostProjects(configs[0]!);
    assert.equal(
      projects.some(({ preferredPath }) => preferredPath === roots[0]!.canonicalPath),
      true,
    );

    const issued = await issueManagedRuntimeHostCredential(configs[0]!, {
      principalId: 'integration-client',
      packId: 'observer',
    });
    assert.match(issued.credential, /^maka_rh_[A-Za-z0-9_-]+$/u);
    const credentials = await listManagedRuntimeHostCredentials(configs[0]!);
    assert.equal(credentials[0]?.credentialId, issued.metadata.credentialId);
    assert.equal(credentials[0]?.status, 'active');
    assert.equal(JSON.stringify(credentials).includes(issued.credential), false);
    assert.equal(JSON.stringify(credentials).includes('credentialHash'), false);
    assert.equal(
      await revokeManagedRuntimeHostCredential(configs[0]!, issued.metadata.credentialId),
      true,
    );
    assert.equal((await listManagedRuntimeHostCredentials(configs[0]!))[0]?.status, 'revoked');
  } finally {
    await Promise.allSettled(
      configs.map((config) => stopManagedRuntimeHostService(config, { clientDataRoot })),
    );
    await rm(base, { recursive: true, force: true });
  }
});

function managedConfig(
  id: string,
  rootPath: string,
  expectedRootId: string,
  port: number,
): ManagedRuntimeHostServiceConfig {
  return createManagedRuntimeHostServiceConfig({
    id,
    name: id,
    rootPath,
    expectedRootId,
    transport: {
      kind: 'plaintext',
      bindHost: '127.0.0.1',
      port,
      path: '/runtime-host',
      publicHost: '127.0.0.1',
      allowedOrigins: [],
      acknowledgement: 'plaintext-bearer-v1',
    },
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a TCP port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForRecoverableService(
  config: ManagedRuntimeHostServiceConfig,
): Promise<Awaited<ReturnType<typeof inspectManagedRuntimeHostService>>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await inspectManagedRuntimeHostService(config);
    if (state.kind === 'unreachable' && state.recoverable) return state;
    if (Date.now() >= deadline) {
      throw new Error(`Runtime Host did not become recoverable after SIGKILL (${state.kind})`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
