import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  clearRuntimeHostServiceStartAttempt,
  createManagedRuntimeHostServiceConfig,
  createRuntimeHostServiceCatalog,
  decodeManagedRuntimeHostServiceConfig,
  findRuntimeHostServiceConfigConflicts,
  publishRuntimeHostServiceStartAttempt,
  readRuntimeHostServiceStartAttempt,
  runtimeHostServiceClientTransport,
  runtimeHostServiceConfigRevision,
  updateManagedRuntimeHostServiceConfig,
  type ManagedRuntimeHostServiceConfig,
} from '../runtime-host-service-catalog.js';

describe('Runtime Host service catalog', () => {
  test('persists multiple immutable State Root bindings with owner-only permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-catalog-'));
    try {
      const catalog = createRuntimeHostServiceCatalog(directory);
      const office = serviceConfig('office', '/srv/maka/office', 'a', 7443);
      const lab = serviceConfig('lab', '/srv/maka/lab', 'b', 8443);

      await catalog.create(office);
      const saved = await catalog.create(lab);

      assert.deepEqual(saved.configs, [office, lab]);
      assert.deepEqual((await catalog.read()).configs, [office, lab]);
      if (process.platform !== 'win32') {
        assert.equal((await chmodAndMode(catalog.path)) & 0o777, 0o600);
      }
      const serialized = await readFile(catalog.path, 'utf8');
      assert.equal(serialized.includes('credential'), false);

      await assert.rejects(
        catalog.save(
          { ...office, rootPath: '/srv/maka/replaced' },
          runtimeHostServiceConfigRevision(office),
        ),
        /cannot change its State Root/u,
      );
      await assert.rejects(
        catalog.create(serviceConfig('duplicate-root', '/different/path', 'a', 9443)),
        /assigns one State Root to multiple configs/u,
      );
      await assert.rejects(
        catalog.create(serviceConfig('duplicate-path', '/srv/maka/office', 'c', 10_443)),
        /assigns one State Root to multiple configs/u,
      );
      await assert.rejects(
        catalog.create(serviceConfig('duplicate-listener', '/srv/maka/other', 'c', 7443)),
        /assigns conflicting listeners/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('serializes concurrent catalog mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-catalog-race-'));
    try {
      const firstCatalog = createRuntimeHostServiceCatalog(directory);
      const secondCatalog = createRuntimeHostServiceCatalog(directory);
      await Promise.all([
        firstCatalog.create(serviceConfig('one', '/srv/maka/one', '1', 7001)),
        secondCatalog.create(serviceConfig('two', '/srv/maka/two', '2', 7002)),
      ]);
      assert.deepEqual(
        (await firstCatalog.read()).configs.map(({ id }) => id),
        ['one', 'two'],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects stale config updates after another manager commits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-catalog-cas-'));
    try {
      const firstCatalog = createRuntimeHostServiceCatalog(directory);
      const secondCatalog = createRuntimeHostServiceCatalog(directory);
      const initial = serviceConfig('office', '/srv/maka/office', 'a', 7443);
      await firstCatalog.create(initial);
      const expectedRevision = runtimeHostServiceConfigRevision(initial);
      await firstCatalog.save(
        updateManagedRuntimeHostServiceConfig(initial, {
          name: 'Updated elsewhere',
          now: new Date('2026-01-02T00:00:00.000Z'),
        }),
        expectedRevision,
      );

      await assert.rejects(
        secondCatalog.save(
          updateManagedRuntimeHostServiceConfig(initial, {
            name: 'Stale update',
            now: new Date('2026-01-03T00:00:00.000Z'),
          }),
          expectedRevision,
        ),
        /changed before it could be saved/u,
      );
      await assert.rejects(
        secondCatalog.remove(initial.id, expectedRevision),
        /changed before it could be removed/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps start-attempt replacement and cleanup exact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-runtime-host-service-attempt-'));
    try {
      const revision = `sha256:${'a'.repeat(64)}` as const;
      const first = await publishRuntimeHostServiceStartAttempt(
        directory,
        'office',
        revision,
        '2026-08-14T08:00:00.000Z',
      );
      const second = await publishRuntimeHostServiceStartAttempt(
        directory,
        'office',
        revision,
        '2026-08-14T08:01:00.000Z',
      );

      await clearRuntimeHostServiceStartAttempt(directory, 'office', {
        attemptId: first.attemptId,
        configRevision: revision,
      });
      assert.deepEqual(await readRuntimeHostServiceStartAttempt(directory, 'office'), second);
      await clearRuntimeHostServiceStartAttempt(directory, 'office', {
        configRevision: `sha256:${'b'.repeat(64)}`,
      });
      assert.deepEqual(await readRuntimeHostServiceStartAttempt(directory, 'office'), second);
      await clearRuntimeHostServiceStartAttempt(directory, 'office', {
        attemptId: second.attemptId,
        configRevision: revision,
      });
      assert.equal(await readRuntimeHostServiceStartAttempt(directory, 'office'), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects listener conflicts but permits distinct addresses and ports', () => {
    const wildcard = serviceConfig('wildcard', '/srv/maka/one', '1', 7443, '0.0.0.0');
    const loopback = serviceConfig('loopback', '/srv/maka/two', '2', 7443, '127.0.0.1');
    const ipv6 = serviceConfig('ipv6', '/srv/maka/three', '3', 7443, '::1');
    const expandedIpv6 = serviceConfig(
      'expanded-ipv6',
      '/srv/maka/expanded-ipv6',
      '5',
      7443,
      '0:0:0:0:0:0:0:1',
    );
    const otherPort = serviceConfig('other', '/srv/maka/four', '4', 8443, '0.0.0.0');

    assert.deepEqual(findRuntimeHostServiceConfigConflicts([wildcard, loopback]), [
      {
        kind: 'listener',
        leftConfigId: 'wildcard',
        rightConfigId: 'loopback',
        port: 7443,
      },
    ]);
    assert.deepEqual(findRuntimeHostServiceConfigConflicts([wildcard, ipv6, otherPort]), []);
    assert.deepEqual(findRuntimeHostServiceConfigConflicts([ipv6, expandedIpv6]), [
      {
        kind: 'listener',
        leftConfigId: 'ipv6',
        rightConfigId: 'expanded-ipv6',
        port: 7443,
      },
    ]);
  });

  test('projects client transports and computes revisions only from service behavior', () => {
    const created = serviceConfig('office', '/srv/maka/office', 'a', 7443);
    const renamed = updateManagedRuntimeHostServiceConfig(created, {
      name: 'Office renamed',
      now: new Date('2026-01-02T00:00:00.000Z'),
    });
    const retimestamped = { ...created, updatedAt: '2026-01-03T00:00:00.000Z' };

    assert.notEqual(
      runtimeHostServiceConfigRevision(created),
      runtimeHostServiceConfigRevision(renamed),
    );
    assert.equal(
      runtimeHostServiceConfigRevision(created),
      runtimeHostServiceConfigRevision(retimestamped),
    );
    assert.deepEqual(runtimeHostServiceClientTransport(created), {
      kind: 'tls',
      url: 'wss://runtime.example.com:7443/runtime-host',
    });
  });

  test('decodes SSH and plaintext transports with explicit security constraints', () => {
    const base = serviceConfig('office', '/srv/maka/office', 'a', 7443);
    assert.deepEqual(
      runtimeHostServiceClientTransport(
        decodeManagedRuntimeHostServiceConfig({
          ...base,
          transport: {
            kind: 'ssh',
            bindHost: '127.0.0.1',
            port: 7443,
            path: '/runtime-host',
            sshDestination: 'operator@runtime.example.com',
            sshPort: 2222,
          },
        }),
      ),
      {
        kind: 'ssh',
        destination: 'operator@runtime.example.com',
        sshPort: 2222,
        remotePort: 7443,
        websocketPath: '/runtime-host',
      },
    );
    assert.throws(
      () =>
        decodeManagedRuntimeHostServiceConfig({
          ...base,
          transport: {
            kind: 'plaintext',
            bindHost: '0.0.0.0',
            port: 7443,
            path: '/runtime-host',
            publicHost: 'runtime.example.com',
            allowedOrigins: [],
            acknowledgement: 'missing',
          },
        }),
      /risk acknowledgement/u,
    );
    assert.throws(
      () => decodeManagedRuntimeHostServiceConfig({ ...base, credential: 'secret' }),
      /unexpected fields/u,
    );
    assert.throws(
      () =>
        decodeManagedRuntimeHostServiceConfig({
          ...base,
          transport: { ...base.transport, publicHost: '0.0.0.0' },
        }),
      /connectable hostname or IP/u,
    );
    assert.throws(
      () =>
        decodeManagedRuntimeHostServiceConfig({
          ...base,
          transport: { ...base.transport, publicHost: 'not:an:ipv6:address' },
        }),
      /public host is invalid/u,
    );
    assert.throws(
      () => decodeManagedRuntimeHostServiceConfig({ ...base, name: '\u001b[31mspoofed' }),
      /name is invalid/u,
    );
    assert.throws(
      () => decodeManagedRuntimeHostServiceConfig({ ...base, rootPath: '/srv/maka\nspoofed' }),
      /safe absolute path/u,
    );
  });
});

function serviceConfig(
  id: string,
  rootPath: string,
  rootIdCharacter: string,
  port: number,
  bindHost = '127.0.0.1',
): ManagedRuntimeHostServiceConfig {
  return createManagedRuntimeHostServiceConfig({
    id,
    name: id,
    rootPath,
    expectedRootId: rootIdCharacter.repeat(64),
    transport: {
      kind: 'tls',
      bindHost,
      port,
      path: '/runtime-host',
      publicHost: 'runtime.example.com',
      certificatePath: '/etc/maka/tls.crt',
      privateKeyPath: '/etc/maka/tls.key',
      allowedOrigins: [],
    },
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
}

async function chmodAndMode(path: string): Promise<number> {
  const metadata = await stat(path);
  return metadata.mode;
}
