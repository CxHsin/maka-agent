import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  RuntimeHostOperationError,
  type ConnectRuntimeHostResult,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import type { HostRegistration } from '@maka/runtime-host/protocol';
import {
  createManagedRuntimeHostServiceConfig,
  createRuntimeHostServiceCatalog,
  publishRuntimeHostServiceStartAttempt,
  readRuntimeHostServiceStartAttempt,
  runtimeHostServiceConfigRevision,
  updateManagedRuntimeHostServiceConfig,
} from '../runtime-host-service-catalog.js';
import {
  inspectManagedRuntimeHostService,
  removeStoppedManagedRuntimeHostServiceConfig,
  restartManagedRuntimeHostService,
  saveStoppedManagedRuntimeHostServiceConfig,
  startManagedRuntimeHostService,
  stopManagedRuntimeHostService,
} from '../runtime-host-service-manager.js';

describe('managed Runtime Host service lifecycle', () => {
  test('detects the exact managed instance without taking over drift or an external Host', async () => {
    const config = serviceConfig();
    let registration = serviceRegistration(config);
    const deps = {
      discoverRoot: async () => rootCapability(),
      connect: async () => connected(registration),
    };

    assert.deepEqual(await inspectManagedRuntimeHostService(config, deps), {
      kind: 'running',
      hostEpoch: 'host-1',
      pid: 123,
      lifecycleState: 'ready',
    });

    registration = { ...registration, rootId: 'b'.repeat(64) };
    assert.deepEqual(await inspectManagedRuntimeHostService(config, deps), {
      kind: 'root_drift',
      expectedRootId: 'a'.repeat(64),
      actualRootId: 'b'.repeat(64),
    });

    registration = {
      ...registration,
      rootId: 'a'.repeat(64),
      serviceConfigRevision: `sha256:${'b'.repeat(64)}`,
    };
    assert.deepEqual(await inspectManagedRuntimeHostService(config, deps), {
      kind: 'config_drift',
      hostEpoch: 'host-1',
      runningRevision: `sha256:${'b'.repeat(64)}`,
      expectedRevision: runtimeHostServiceConfigRevision(config),
    });

    registration = { ...registration, serviceConfigId: 'manual-host' };
    assert.deepEqual(await inspectManagedRuntimeHostService(config, deps), {
      kind: 'external',
      hostEpoch: 'host-1',
      serviceConfigId: 'manual-host',
    });
  });

  test('reports a replaced or missing State Root as drift before connecting', async () => {
    const config = serviceConfig();
    let connectCalls = 0;
    const state = await inspectManagedRuntimeHostService(config, {
      discoverRoot: async () =>
        ({
          kind: 'interactive',
          canonicalPath: '/srv/maka/office',
          rootId: 'b'.repeat(64),
        }) as never,
      connect: async () => {
        connectCalls += 1;
        return { kind: 'unavailable', reason: 'not_registered' };
      },
    });
    assert.deepEqual(state, {
      kind: 'root_drift',
      expectedRootId: 'a'.repeat(64),
      actualRootId: 'b'.repeat(64),
    });
    assert.equal(connectCalls, 0);
  });

  test('starts one detached config and waits for its exact ready registration', async () => {
    const config = serviceConfig();
    let ready = false;
    let launchedConfigId: string | undefined;
    let now = 0;
    const result = await startManagedRuntimeHostService(
      config,
      { clientDataRoot: '/tmp/maka-managed-service-test', timeoutMs: 1_000 },
      {
        ...lifecycleOperationDeps(),
        discoverRoot: async () => rootCapability(),
        connect: async () =>
          ready
            ? connected(serviceRegistration(config))
            : { kind: 'unavailable', reason: 'not_registered' },
        launch: async (configId) => {
          launchedConfigId = configId;
          return { pid: 123, exited: new Promise(() => undefined) };
        },
        now: () => now,
        delay: async (durationMs) => {
          now += durationMs;
          ready = true;
        },
      },
    );
    assert.equal(launchedConfigId, 'office');
    assert.deepEqual(result, {
      kind: 'started',
      state: {
        kind: 'running',
        hostEpoch: 'host-1',
        pid: 123,
        lifecycleState: 'ready',
      },
    });
  });

  test('recovers an exact managed config from a stale registration', async () => {
    const config = serviceConfig();
    let launched = false;
    let launchedRevision: string | undefined;
    const registration = serviceRegistration(config);
    const result = await startManagedRuntimeHostService(
      config,
      { clientDataRoot: '/tmp/maka-managed-service-test' },
      {
        ...lifecycleOperationDeps(),
        discoverRoot: async () => rootCapability(),
        connect: async () =>
          launched
            ? connected(registration)
            : { kind: 'unavailable', reason: 'connect_failed', registration },
        launch: async (_configId, expectedRevision) => {
          launched = true;
          launchedRevision = expectedRevision;
          return { pid: 123, exited: new Promise(() => undefined) };
        },
      },
    );

    assert.equal(launchedRevision, runtimeHostServiceConfigRevision(config));
    assert.equal(result.kind, 'started');
  });

  test('stops only the exact local managed instance through the Host protocol', async () => {
    const config = serviceConfig();
    let stopped = false;
    let stopInput: unknown;
    const connection = fakeConnection(async (operation, input) => {
      assert.equal(operation, 'host.service.stop');
      stopInput = input;
      stopped = true;
      return { kind: 'accepted', hostEpoch: 'host-1' };
    });
    const result = await stopManagedRuntimeHostService(
      config,
      { clientDataRoot: '/tmp/maka-managed-service-test' },
      {
        ...lifecycleOperationDeps(),
        discoverRoot: async () => rootCapability(),
        connect: async () =>
          stopped
            ? { kind: 'unavailable', reason: 'not_registered' }
            : { kind: 'connected', connection, registration: serviceRegistration(config) },
        delay: async () => undefined,
      },
    );
    assert.deepEqual(stopInput, { expectedHostEpoch: 'host-1' });
    assert.deepEqual(result, { kind: 'stopped' });
  });

  test('cancels a pending detached start before reporting the service stopped', async () => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-managed-service-pending-start-'));
    try {
      const config = serviceConfig();
      await createRuntimeHostServiceCatalog(clientDataRoot).create(config);
      const attempt = await publishRuntimeHostServiceStartAttempt(
        clientDataRoot,
        config.id,
        runtimeHostServiceConfigRevision(config),
        new Date(Date.now() + 30_000).toISOString(),
      );
      assert.equal(
        (await readRuntimeHostServiceStartAttempt(clientDataRoot, config.id))?.attemptId,
        attempt.attemptId,
      );

      assert.deepEqual(
        await stopManagedRuntimeHostService(
          config,
          { clientDataRoot },
          {
            discoverRoot: async () => rootCapability(),
            connect: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
            acquireOwner: async () => ({ close: async () => undefined }) as never,
          },
        ),
        { kind: 'already_stopped' },
      );
      assert.equal(await readRuntimeHostServiceStartAttempt(clientDataRoot, config.id), undefined);
    } finally {
      await rm(clientDataRoot, { recursive: true, force: true });
    }
  });

  test('stale lifecycle operations cannot replace a newer config start attempt', async () => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-managed-service-stale-'));
    try {
      const catalog = createRuntimeHostServiceCatalog(clientDataRoot);
      const stale = serviceConfig();
      await catalog.create(stale);
      const current = updateManagedRuntimeHostServiceConfig(stale, {
        name: 'Office current',
        now: new Date('2026-01-02T00:00:00.000Z'),
      });
      await catalog.save(current, runtimeHostServiceConfigRevision(stale));
      const currentRevision = runtimeHostServiceConfigRevision(current);
      const attempt = await publishRuntimeHostServiceStartAttempt(
        clientDataRoot,
        current.id,
        currentRevision,
        new Date(Date.now() + 30_000).toISOString(),
      );
      const staleEdit = updateManagedRuntimeHostServiceConfig(stale, {
        name: 'Stale edit',
        now: new Date('2026-01-03T00:00:00.000Z'),
      });
      const operations = [
        () => startManagedRuntimeHostService(stale, { clientDataRoot }),
        () => stopManagedRuntimeHostService(stale, { clientDataRoot }),
        () => restartManagedRuntimeHostService(stale, { clientDataRoot }),
        () => saveStoppedManagedRuntimeHostServiceConfig(catalog, stale, staleEdit, clientDataRoot),
        () => removeStoppedManagedRuntimeHostServiceConfig(catalog, stale, clientDataRoot),
      ];

      for (const operation of operations) {
        await assert.rejects(operation(), /config changed before the operation started/u);
        assert.deepEqual(
          await readRuntimeHostServiceStartAttempt(clientDataRoot, current.id),
          attempt,
        );
      }
    } finally {
      await rm(clientDataRoot, { recursive: true, force: true });
    }
  });

  test('restarts by stopping and spawning one pinned attempt in the same config transaction', async () => {
    const config = serviceConfig();
    let inTransaction = false;
    let stopped = false;
    let launched = false;
    const events: string[] = [];
    const connection = fakeConnection(async () => {
      assert.equal(inTransaction, true);
      events.push('stop');
      stopped = true;
      return { kind: 'accepted', hostEpoch: 'host-1' };
    });

    const result = await restartManagedRuntimeHostService(
      config,
      { clientDataRoot: '/tmp/maka-managed-service-test' },
      {
        ...lifecycleOperationDeps(),
        runConfigOperation: async <T>(
          _clientDataRoot: string,
          _configId: string,
          operation: () => Promise<T>,
        ) => {
          assert.equal(inTransaction, false);
          inTransaction = true;
          try {
            return await operation();
          } finally {
            inTransaction = false;
          }
        },
        clearStartAttempt: async () => {
          assert.equal(inTransaction, true);
          events.push('cancel-pending');
        },
        publishStartAttempt: async (_root, configId, configRevision, expiresAt) => {
          assert.equal(inTransaction, true);
          events.push('publish');
          return {
            schemaVersion: 1,
            configId,
            configRevision,
            attemptId: '00000000-0000-4000-8000-000000000000',
            expiresAt,
          };
        },
        launch: async () => {
          assert.equal(inTransaction, true);
          events.push('spawn');
          launched = true;
          return { pid: 123, exited: new Promise(() => undefined) };
        },
        discoverRoot: async () => rootCapability(),
        acquireOwner: async () => ({ close: async () => undefined }) as never,
        connect: async () => {
          if (!stopped) {
            return { kind: 'connected', connection, registration: serviceRegistration(config) };
          }
          return launched
            ? connected(serviceRegistration(config))
            : { kind: 'unavailable', reason: 'not_registered' };
        },
      },
    );

    assert.equal(result.kind, 'started');
    assert.deepEqual(events, ['cancel-pending', 'stop', 'publish', 'spawn']);
  });

  test('stops a recovering service and follows an already draining stop', async () => {
    const config = serviceConfig();
    const recovering = { ...serviceRegistration(config), state: 'recovering' as const };
    let stopped = false;
    const connection = fakeConnection(async () => {
      stopped = true;
      return { kind: 'accepted', hostEpoch: recovering.hostEpoch };
    });
    assert.deepEqual(
      await stopManagedRuntimeHostService(
        config,
        { clientDataRoot: '/tmp/maka-managed-service-test' },
        {
          ...lifecycleOperationDeps(),
          discoverRoot: async () => rootCapability(),
          connect: async () =>
            stopped
              ? { kind: 'unavailable', reason: 'not_registered' }
              : { kind: 'connected', connection, registration: recovering },
          acquireOwner: async () => ({ close: async () => undefined }) as never,
        },
      ),
      { kind: 'stopped' },
    );

    let draining = true;
    assert.deepEqual(
      await stopManagedRuntimeHostService(
        config,
        { clientDataRoot: '/tmp/maka-managed-service-test' },
        {
          ...lifecycleOperationDeps(),
          discoverRoot: async () => rootCapability(),
          connect: async () => {
            if (draining) {
              draining = false;
              return { kind: 'draining', registration: serviceRegistration(config) };
            }
            return { kind: 'unavailable', reason: 'not_registered' };
          },
        },
      ),
      { kind: 'stopped' },
    );
  });

  test('polls a stop command that raced with Host draining', async () => {
    const config = serviceConfig();
    let requestAttempted = false;
    const connection = fakeConnection(async () => {
      requestAttempted = true;
      throw new RuntimeHostOperationError(
        'host.service.stop',
        'host_draining',
        'Runtime Host is draining',
      );
    });
    assert.deepEqual(
      await stopManagedRuntimeHostService(
        config,
        { clientDataRoot: '/tmp/maka-managed-service-test' },
        {
          ...lifecycleOperationDeps(),
          discoverRoot: async () => rootCapability(),
          connect: async () =>
            requestAttempted
              ? { kind: 'unavailable', reason: 'not_registered' }
              : { kind: 'connected', connection, registration: serviceRegistration(config) },
        },
      ),
      { kind: 'stopped' },
    );
  });

  test('waits for Root owner release after the stop registration disappears', async () => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-managed-service-stop-'));
    try {
      const config = serviceConfig();
      await createRuntimeHostServiceCatalog(clientDataRoot).create(config);
      let stopped = false;
      let ownerAvailable = false;
      let now = 0;
      const connection = fakeConnection(async () => {
        stopped = true;
        return { kind: 'accepted', hostEpoch: 'host-1' };
      });
      assert.deepEqual(
        await stopManagedRuntimeHostService(
          config,
          { clientDataRoot, timeoutMs: 1_000 },
          {
            discoverRoot: async () => rootCapability(),
            connect: async () =>
              stopped
                ? { kind: 'unavailable', reason: 'not_registered' }
                : { kind: 'connected', connection, registration: serviceRegistration(config) },
            acquireOwner: async () =>
              ownerAvailable ? ({ close: async () => undefined } as never) : undefined,
            now: () => now,
            delay: async (durationMs) => {
              now += durationMs;
              ownerAvailable = true;
            },
          },
        ),
        { kind: 'stopped' },
      );
    } finally {
      await rm(clientDataRoot, { recursive: true, force: true });
    }
  });

  test('refuses stop when the connected registration belongs to a replacement Root', async () => {
    const config = serviceConfig();
    const registration = { ...serviceRegistration(config), rootId: 'b'.repeat(64) };
    const connection = fakeConnection(async () => assert.fail('stop must not be requested'));
    assert.deepEqual(
      await stopManagedRuntimeHostService(
        config,
        { clientDataRoot: '/tmp/maka-managed-service-test' },
        {
          ...lifecycleOperationDeps(),
          connect: async () => ({ kind: 'connected', connection, registration }),
        },
      ),
      {
        kind: 'refused',
        state: {
          kind: 'root_drift',
          expectedRootId: 'a'.repeat(64),
          actualRootId: 'b'.repeat(64),
        },
      },
    );
  });

  test('mutates configs only while holding the exact State Root owner', async () => {
    const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-managed-service-mutation-'));
    try {
      const catalog = createRuntimeHostServiceCatalog(clientDataRoot);
      const current = serviceConfig();
      await catalog.create(current);
      const next = updateManagedRuntimeHostServiceConfig(current, {
        name: 'Office updated',
        now: new Date('2026-01-02T00:00:00.000Z'),
      });
      let ownerClosed = false;
      await saveStoppedManagedRuntimeHostServiceConfig(catalog, current, next, clientDataRoot, {
        discoverRoot: async () => rootCapability(),
        acquireOwner: async () =>
          ({
            close: async () => {
              ownerClosed = true;
            },
          }) as never,
      });
      assert.equal(ownerClosed, true);
      assert.equal((await catalog.read()).configs[0]?.name, 'Office updated');

      await assert.rejects(
        removeStoppedManagedRuntimeHostServiceConfig(catalog, next, clientDataRoot, {
          discoverRoot: async () => rootCapability(),
          acquireOwner: async () => undefined,
        }),
        /cannot be removed while its State Root is owned/u,
      );
      assert.equal((await catalog.read()).configs.length, 1);
    } finally {
      await rm(clientDataRoot, { recursive: true, force: true });
    }
  });
});

function serviceConfig() {
  return createManagedRuntimeHostServiceConfig({
    id: 'office',
    name: 'Office',
    rootPath: '/srv/maka/office',
    expectedRootId: 'a'.repeat(64),
    transport: {
      kind: 'plaintext',
      bindHost: '127.0.0.1',
      port: 7443,
      path: '/runtime-host',
      publicHost: '127.0.0.1',
      allowedOrigins: [],
      acknowledgement: 'plaintext-bearer-v1',
    },
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function serviceRegistration(config = serviceConfig()): HostRegistration {
  return {
    kind: 'maka-runtime-host',
    schemaVersion: 1,
    rootId: 'a'.repeat(64),
    hostEpoch: 'host-1',
    endpoint: '/tmp/maka.sock',
    protocolMin: 0,
    protocolMax: 0,
    compatibilityEpoch: 20,
    compositionId: 'maka.interactive',
    compositionRevision: '1',
    lifecycleMode: 'service',
    serviceConfigId: 'office',
    serviceConfigRevision: runtimeHostServiceConfigRevision(config),
    state: 'ready',
    pid: 123,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function rootCapability() {
  return {
    kind: 'interactive' as const,
    canonicalPath: '/srv/maka/office',
    rootId: 'a'.repeat(64),
  } as never;
}

function connected(registration: HostRegistration): ConnectRuntimeHostResult {
  return { kind: 'connected', registration, connection: fakeConnection() };
}

function fakeConnection(
  request: (operation: string, input: unknown) => Promise<unknown> = async () => undefined,
): RuntimeHostConnection {
  return {
    rootId: 'a'.repeat(64),
    hostEpoch: 'host-1',
    connectionId: 'connection-1',
    selectedProtocol: 0,
    compositionId: 'maka.interactive',
    compositionRevision: '1',
    closed: new Promise(() => undefined),
    request,
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
}

function lifecycleOperationDeps() {
  return {
    runConfigOperation: async <T>(
      _clientDataRoot: string,
      _configId: string,
      operation: () => Promise<T>,
    ) => operation(),
    publishStartAttempt: async (
      _clientDataRoot: string,
      configId: string,
      configRevision: `sha256:${string}`,
      expiresAt: string,
    ) => ({
      schemaVersion: 1 as const,
      configId,
      configRevision,
      attemptId: '00000000-0000-4000-8000-000000000000',
      expiresAt,
    }),
    clearStartAttempt: async () => undefined,
    acquireOwner: async () => ({ close: async () => undefined }) as never,
    readCatalog: async () => ({ schemaVersion: 1 as const, configs: [serviceConfig()] }),
  };
}
