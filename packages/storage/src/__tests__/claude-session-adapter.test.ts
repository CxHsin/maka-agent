import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { decodeStoredMessage } from '@maka/core/session';
import { ClaudeSessionAdapter } from '../claude-session-adapter.js';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';
import { createForeignSessionStore } from '../foreign-session-store.js';

describe('ClaudeSessionAdapter', () => {
  test('shares catalog identity while projecting full history and safe handoff separately', async () => {
    const home = await mkdtemp(join(tmpdir(), 'maka-claude-adapter-'));
    const id = 'claude-session-1';
    const directory = join(home, '.claude', 'projects', '-repo');
    const path = join(directory, `${id}.jsonl`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      [
        record({
          type: 'user',
          uuid: 'u1',
          cwd: '/repo',
          gitBranch: 'main',
          message: { content: 'Fix the parser' },
        }),
        record({
          type: 'assistant',
          uuid: 'a1',
          model: 'claude-test',
          message: {
            model: 'claude-test',
            content: [
              { type: 'thinking', thinking: 'Inspect the parser.' },
              { type: 'text', text: 'I found the failing branch.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Edit',
                input: { file_path: '/repo/parser.ts' },
              },
            ],
          },
        }),
        record({
          type: 'user',
          uuid: 'r1',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'patched' }],
          },
        }),
        record({ type: 'summary', uuid: 'compact-1', summary: 'Prior context was compacted.' }),
        record({ type: 'system', uuid: 'rewind-1', subtype: 'rewind', reason: 'user_requested' }),
        record({
          type: 'assistant',
          uuid: 'a1',
          model: 'claude-test',
          message: { content: [{ type: 'text', text: 'duplicate record must not be imported' }] },
        }),
        record({ type: 'user', uuid: 'u2', message: { content: 'Continue after rewind' } }),
        record({
          type: 'assistant',
          uuid: 'a2',
          model: 'claude-test',
          message: { content: [{ type: 'text', text: 'Done.' }] },
        }),
        'not json',
      ].join('\n') + '\n',
      'utf8',
    );

    try {
      const adapter = new ClaudeSessionAdapter({ homeDir: home });
      const listed = await adapter.listSessions();
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0], {
        id,
        name: 'Prior context was compacted.',
        cwd: '/repo',
        updatedAt: listed[0]?.updatedAt,
      });
      const imported = await adapter.readSession(id);
      assert.deepEqual(imported.metadata, { name: 'Prior context was compacted.', cwd: '/repo' });
      assert.deepEqual(
        imported.messages.map((message) => message.type),
        [
          'user',
          'assistant',
          'tool_call',
          'tool_result',
          'system_note',
          'system_note',
          'turn_state',
          'user',
          'assistant',
          'turn_state',
        ],
      );
      for (const message of imported.messages) {
        assert.deepEqual(decodeStoredMessage(message), message);
      }
      assert.equal(imported.messages.filter((message) => message.type === 'assistant').length, 2);
      const toolResult = imported.messages.find((message) => message.type === 'tool_result');
      assert.equal(toolResult?.type, 'tool_result');
      if (toolResult?.type === 'tool_result') assert.equal(toolResult.toolUseId, 'tool-1');

      const store = createForeignSessionStore({ homeDir: home, env: {} });
      const [summary] = await store.listSessions();
      assert.ok(summary);
      const digest = await store.readDigest(summary);
      assert.deepEqual(digest.userMessages, ['Fix the parser', 'Continue after rewind']);
      assert.deepEqual(digest.assistantTexts, ['I found the failing branch.', 'Done.']);
      assert.deepEqual(digest.filesTouched, ['/repo/parser.ts']);
      assert.ok(digest.warnings.some((warning) => warning.includes('malformed')));
      assert.ok(!JSON.stringify(digest).includes('duplicate record'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('is registered as a native full-import source', async () => {
    const registry = createExternalSessionAdapterRegistry({ claude: { homeDir: 'C:\\missing' } });
    assert.equal(registry.require('claude-code').id, 'claude-code');
  });

  test('warns when a bounded handoff tail cannot prove Claude lineage continuity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'maka-claude-bounded-handoff-'));
    const id = 'claude-bounded-lineage';
    const directory = join(home, '.claude', 'projects', '-repo');
    const path = join(directory, `${id}.jsonl`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      [
        record({ type: 'user', uuid: 'u1', cwd: '/repo', message: { content: 'Start' } }),
        record({
          type: 'assistant',
          uuid: 'large',
          parentUuid: 'u1',
          message: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] },
        }),
        record({
          type: 'user',
          uuid: 'u2',
          parentUuid: 'large',
          message: { content: 'Continue' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    try {
      const adapter = new ClaudeSessionAdapter({ homeDir: home });
      const [entry] = await adapter.listCatalogEntries();
      assert.ok(entry);
      const digest = await adapter.readDigest(entry);
      assert.ok(digest.warnings.some((warning) => warning.includes('lineage may be incomplete')));
      assert.deepEqual(digest.userMessages, ['Continue']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('projects the active Claude parent lineage after a rewind', async () => {
    const home = await mkdtemp(join(tmpdir(), 'maka-claude-lineage-'));
    const id = 'claude-lineage-rewind';
    const directory = join(home, '.claude', 'projects', '-repo');
    const path = join(directory, `${id}.jsonl`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      [
        record({ type: 'user', uuid: 'u1', cwd: '/repo', message: { content: 'Start' } }),
        record({
          type: 'assistant',
          uuid: 'old-a1',
          parentUuid: 'u1',
          message: { content: [{ type: 'text', text: 'Old branch answer' }] },
        }),
        record({
          type: 'system',
          uuid: 'rewind-1',
          parentUuid: 'old-a1',
          subtype: 'rewind',
        }),
        record({
          type: 'user',
          uuid: 'u2',
          parentUuid: 'u1',
          message: { content: 'Continue from the rewind' },
        }),
        record({
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'u2',
          message: { content: [{ type: 'text', text: 'Current branch answer' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    try {
      const adapter = new ClaudeSessionAdapter({ homeDir: home });
      const imported = await adapter.readSession(id);
      assert.deepEqual(
        imported.messages
          .filter((message) => message.type === 'assistant')
          .map((message) => message.text),
        ['Current branch answer'],
      );

      const [entry] = await adapter.listCatalogEntries();
      assert.ok(entry);
      const digest = await adapter.readDigest(entry);
      assert.deepEqual(digest.assistantTexts, ['Current branch answer']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('uses the same newest transcript when a Claude id exists in two projects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'maka-claude-duplicate-id-'));
    const id = 'claude-duplicate-id';
    const oldDirectory = join(home, '.claude', 'projects', '-old');
    const newDirectory = join(home, '.claude', 'projects', '-new');
    const oldPath = join(oldDirectory, `${id}.jsonl`);
    const newPath = join(newDirectory, `${id}.jsonl`);
    await mkdir(oldDirectory, { recursive: true });
    await mkdir(newDirectory, { recursive: true });
    await writeFile(
      oldPath,
      record({ type: 'user', uuid: 'old-u', cwd: '/old', message: { content: 'Old copy' } }),
      'utf8',
    );
    await writeFile(
      newPath,
      record({ type: 'user', uuid: 'new-u', cwd: '/new', message: { content: 'New copy' } }),
      'utf8',
    );
    await utimes(oldPath, 1, 1);
    await utimes(newPath, 2, 2);

    try {
      const adapter = new ClaudeSessionAdapter({ homeDir: home });
      assert.deepEqual(await adapter.listSessions(), [
        {
          id,
          name: 'New copy',
          cwd: '/new',
          updatedAt: Date.parse('2026-08-23T00:00:00.000Z'),
        },
      ]);
      const imported = await adapter.readSession(id);
      assert.equal(imported.metadata.cwd, '/new');
      assert.equal(imported.messages.find((message) => message.type === 'user')?.text, 'New copy');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function record(value: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-08-23T00:00:00.000Z', ...value });
}
