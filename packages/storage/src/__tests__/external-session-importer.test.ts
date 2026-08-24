import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StoredMessage } from '@maka/core/session';
import {
  ExternalSessionAdapterRegistry,
  type ExternalSessionAdapter,
} from '@maka/core/external-session';
import {
  ExternalSessionImporter,
  type ExternalSessionImportTarget,
} from '../external-session-importer.js';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';
import { createSessionStore } from '../session-store.js';

describe('ExternalSessionImporter', () => {
  test('imports a current Codex rollout through the real import route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-codex-import-route-'));
    const codexHome = join(root, '.codex');
    const sessionId = 'codex-item-completed';
    const rolloutDirectory = join(codexHome, 'sessions', '2026', '08', '22');
    const rolloutPath = join(rolloutDirectory, `rollout-2026-08-22T00-00-00-${sessionId}.jsonl`);
    const sessions = createSessionStore(join(root, 'maka'));
    const importer = new ExternalSessionImporter(
      createExternalSessionAdapterRegistry({ codex: { codexHome } }),
      sessions,
    );

    try {
      await mkdir(rolloutDirectory, { recursive: true });
      const fixturePath = fileURLToPath(
        new URL(
          '../../src/__tests__/fixtures/codex-rollout-v0.149-item-completed.jsonl',
          import.meta.url,
        ),
      );
      await writeFile(rolloutPath, await readFile(fixturePath));

      const header = await importer.import({
        adapterId: 'codex',
        sourceSessionId: sessionId,
        target: target(),
      });
      const importedMessages = await sessions.readMessages(header.id);

      assert.deepEqual(header.externalOrigin, {
        adapterId: 'codex',
        sourceSessionId: sessionId,
      });
      assert.equal(header.name, 'Analyze the image. Use OpenCV.js.');
      assert.equal(header.cwd, '/workspace/opencv');
      assert.deepEqual(
        importedMessages.map((message) => message.type),
        ['user', 'assistant', 'assistant', 'turn_state'],
      );
      assert.equal(importedMessages[0]?.type, 'user');
      if (importedMessages[0]?.type === 'user') {
        assert.equal(importedMessages[0].text, 'Analyze the image.\nUse OpenCV.js.');
      }
      assert.equal(importedMessages[2]?.type, 'assistant');
      if (importedMessages[2]?.type === 'assistant') {
        assert.equal(importedMessages[2].text, 'Use canvas.\nThen process the pixels.');
      }
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists adapter output as native Maka StoredMessages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-import-'));
    const sessions = createSessionStore(root);
    const messages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 10, text: 'fix the parser' },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 20,
        text: 'done',
        modelId: 'external-model',
      },
    ];
    const adapter = fakeAdapter({
      metadata: { name: 'Imported parser work', cwd: '/external/repo' },
      messages,
    });
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([adapter]),
      sessions,
    );

    try {
      const header = await importer.import({
        adapterId: 'fake',
        sourceSessionId: 'source-1',
        target: target(),
      });

      assert.equal(header.name, 'Imported parser work');
      assert.equal(header.cwd, '/external/repo');
      assert.equal(header.model, 'maka-model');
      assert.equal(header.connectionLocked, true);
      assert.deepEqual(header.externalOrigin, {
        adapterId: 'fake',
        sourceSessionId: 'source-1',
      });
      assert.deepEqual(await sessions.readMessages(header.id), messages);
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('allows the Maka target to override imported name and cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-target-'));
    const sessions = createSessionStore(root);
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([
        fakeAdapter({ metadata: { name: 'Source name', cwd: '/source' }, messages: [] }),
      ]),
      sessions,
    );

    try {
      const header = await importer.import({
        adapterId: 'fake',
        sourceSessionId: 'source-1',
        target: target({ name: 'Maka name', cwd: '/target' }),
      });

      assert.equal(header.name, 'Maka name');
      assert.equal(header.cwd, '/target');
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid adapter messages without exposing a partial Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-invalid-'));
    const sessions = createSessionStore(root);
    const adapter = fakeAdapter({
      metadata: { name: 'Invalid import', cwd: '/repo' },
      messages: [{ type: 'assistant' } as unknown as StoredMessage],
    });
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([adapter]),
      sessions,
    );

    try {
      await assert.rejects(
        importer.import({
          adapterId: 'fake',
          sourceSessionId: 'source-1',
          target: target(),
        }),
        /Invalid stored message schema/,
      );
      assert.deepEqual(await sessions.listHeaders(), []);
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function target(overrides: Partial<ExternalSessionImportTarget> = {}): ExternalSessionImportTarget {
  return {
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'maka-model',
    permissionMode: 'ask',
    ...overrides,
  };
}

function fakeAdapter(
  session: Pick<
    Awaited<ReturnType<ExternalSessionAdapter['readSession']>>,
    'metadata' | 'messages'
  >,
): ExternalSessionAdapter {
  return {
    id: 'fake',
    detect: async () => true,
    listSessions: async () => [],
    readSession: async (sourceSessionId) => ({ sourceSessionId, ...session }),
  };
}
