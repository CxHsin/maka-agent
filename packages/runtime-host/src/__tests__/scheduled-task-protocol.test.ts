import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  SCHEDULED_TASK_OPERATION_SPECS,
} from '../protocol/index.js';

describe('ScheduledTask protocol', () => {
  test('declares one bounded query and mutation surface', () => {
    assert.equal(SCHEDULED_TASK_OPERATION_SPECS['scheduled-task.query'].mode, 'query');
    assert.equal(SCHEDULED_TASK_OPERATION_SPECS['scheduled-task.mutate'].mode, 'command');
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'list-1',
        operation: 'scheduled-task.query',
        input: { kind: 'list', cursor: '2', expectedRevision: 4 },
      }),
      {
        requestId: 'list-1',
        operation: 'scheduled-task.query',
        input: { kind: 'list', cursor: '2', expectedRevision: 4 },
      },
    );
  });

  test('accepts signal-only catalog changes', () => {
    const frame = {
      kind: 'scheduled-task.changed' as const,
      revision: 3,
      reason: 'fired' as const,
      taskId: 'task-1',
    };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assert.throws(() => decodeHostFrame({ ...frame, runtimePayload: { secret: true } }));
  });
});
