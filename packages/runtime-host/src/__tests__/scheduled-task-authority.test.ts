import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import { HostScheduledTaskAuthority } from '../server/scheduled-task-authority.js';

describe('HostScheduledTaskAuthority', () => {
  test('routes agent mutations to the initiating Desktop authority', async () => {
    const calls: Array<{ sessionId: string; method: string; input: Record<string, unknown> }> = [];
    const authority = new HostScheduledTaskAuthority({
      sessions: {
        readHeaderSnapshot: async () => sessionHeader(),
      },
      clientCapabilities: {
        async callServiceForSession(input) {
          calls.push({ sessionId: input.sessionId, method: input.method, input: input.input });
          if (input.method === 'list') return { tasks: [] };
          const payload = input.input.payload as Record<string, unknown>;
          return {
            task: {
              id: 'task-1',
              ...payload,
              intent: { kind: 'text', body: payload.intentBody },
              status: 'active',
              nextFireAt: Date.now() + 60_000,
              lastFireAt: null,
              fireCount: 0,
              maxFires: null,
              expiresAt: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              runs: [],
              lastError: null,
            },
          };
        },
      },
    });

    const result = await authority.create({
      title: 'Agent task',
      intentBody: 'Do the work',
      schedule: { kind: 'once', runAt: Date.now() + 60_000 },
      effect: 'agent_run',
      sessionId: 'session-1',
    });
    assert.ok(!('error' in result));
    assert.equal(calls[0]?.sessionId, 'session-1');
    assert.equal(calls[0]?.method, 'create');
    const payload = calls[0]?.input.payload as {
      effect: { execution: { permissionMode: string } };
    };
    assert.equal(payload.effect.execution.permissionMode, 'execute');
  });
});

function sessionHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace/project',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Session',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: true,
    model: 'model',
    permissionMode: 'execute',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}
