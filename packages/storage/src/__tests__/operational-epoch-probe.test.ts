import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { createSessionStore } from '../session-store.js';

test('keeps the frozen epoch-one reader and writer compatible with the current database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-operational-epoch-1-probe-'));
  const databasePath = join(root, 'runtime.sqlite');
  try {
    const writer = createSessionStore(root);
    const currentSession = await writer.create({
      cwd: root,
      backend: 'fake',
      llmConnectionSlug: 'fake',
      model: 'fake',
      permissionMode: 'ask',
      name: 'Current writer',
      labels: [],
    });
    await writer.close?.();
    await runEpochOneProbe(databasePath, currentSession.id);

    const reader = createSessionStore(root);
    try {
      assert.equal((await reader.readHeaderSnapshot(currentSession.id)).name, 'Epoch 1 updated');
      assert.equal((await reader.readHeaderSnapshot('epoch-1-session')).name, 'Epoch 1');
      await reader.rename('epoch-1-session', 'Current updated');
      assert.equal((await reader.readHeaderSnapshot('epoch-1-session')).name, 'Current updated');
    } finally {
      await reader.close?.();
    }

    const current = acquireOperationalStateDatabase(root);
    try {
      for (const [table, key, value] of [
        ['runtime_events', 'event_id', 'epoch-1-event'],
        ['session_metadata', 'session_id', 'epoch-1-session'],
        ['core_message_host_epochs', 'host_epoch', 'epoch-1-host'],
        ['workflow_quote_companion_cleanup', 'session_id', 'epoch-1-session'],
        ['usage_pricing_overrides', 'model_key', 'epoch-1-model'],
        ['artifact_records', 'artifact_id', 'epoch-1-artifact'],
        ['automation_definitions', 'automation_id', 'epoch-1-automation'],
      ] as const) {
        assert.equal(
          (
            current.database
              .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`)
              .get(value) as { count: number }
          ).count,
          1,
          `${table} did not preserve the epoch-one write`,
        );
      }
    } finally {
      current.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runEpochOneProbe(databasePath: string, currentSessionId: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./fixtures/operational-epoch-1-probe.js', import.meta.url)),
      databasePath,
      currentSessionId,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`epoch-one probe failed (${code ?? signal}): ${stderr}`));
    });
  });
}
