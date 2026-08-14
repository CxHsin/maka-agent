import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConnectRuntimeHostResult, RuntimeHostConnection } from '@maka/runtime-host/client';
import type { HostRegistration } from '@maka/runtime-host/protocol';
import {
  createManagedRuntimeHostServiceConfig,
  runtimeHostServiceConfigRevision,
} from '../runtime-host-service-catalog.js';
import {
  inspectManagedRuntimeHostService,
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
      { timeoutMs: 1_000 },
      {
        discoverRoot: async () => rootCapability(),
        connect: async () =>
          ready
            ? connected(serviceRegistration(config))
            : { kind: 'unavailable', reason: 'not_registered' },
        launch: async (configId) => {
          launchedConfigId = configId;
          return { pid: 321, exited: new Promise(() => undefined) };
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
      {},
      {
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

  test('refuses stop when the connected registration belongs to a replacement Root', async () => {
    const config = serviceConfig();
    const registration = { ...serviceRegistration(config), rootId: 'b'.repeat(64) };
    const connection = fakeConnection(async () => assert.fail('stop must not be requested'));
    assert.deepEqual(
      await stopManagedRuntimeHostService(
        config,
        {},
        {
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
