import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ScheduledTask } from '@maka/core';
import {
  scheduledTaskDuplicateSeed,
  scheduledTaskEditSeed,
  scheduledTaskPresetRunAt,
} from '../scheduled-task-helpers.js';

/**
 * The one-tap presets carry the form's only shortcut past the date picker, and
 * they were deleted once already without a single test failing — nothing in
 * the repo referenced this helper, so removing it looked free. These tests
 * exist so the next deletion has to be deliberate.
 *
 * Fixed instants, never `Date.now()`: "next Monday" is only meaningful
 * relative to a known weekday, and a test whose expectation moves with the
 * calendar cannot pin a boundary.
 */
describe('scheduled task presets', () => {
  const MONDAY_10AM = new Date(2026, 7, 3, 10, 0, 0, 0).getTime(); // Mon 2026-08-03

  it('offsets the two relative presets from the moment asked', () => {
    assert.equal(scheduledTaskPresetRunAt('ten-minutes', MONDAY_10AM), MONDAY_10AM + 10 * 60 * 1000);
    assert.equal(scheduledTaskPresetRunAt('one-hour', MONDAY_10AM), MONDAY_10AM + 60 * 60 * 1000);
  });

  it('pins the morning presets to 09:00 rather than the current time of day', () => {
    const at = new Date(scheduledTaskPresetRunAt('tomorrow-morning', MONDAY_10AM));
    assert.equal(at.getDate(), 4, 'the next calendar day');
    assert.equal(at.getHours(), 9);
    assert.equal(at.getMinutes(), 0);
    assert.equal(at.getSeconds(), 0);
    assert.equal(at.getMilliseconds(), 0, 'sub-minute fields cleared, or the label lies');
  });

  /**
   * The boundary the modulo exists for. `(8 - 1) % 7` is 0 on a Monday, so a
   * bare modulo would schedule "next Monday" for the Monday already underway —
   * nine hours in the past at 10:00. The `|| 7` is what makes it a week out.
   */
  it('reads next Monday as the following week when asked on a Monday', () => {
    const at = new Date(scheduledTaskPresetRunAt('next-monday', MONDAY_10AM));
    assert.equal(at.getDay(), 1, 'still a Monday');
    assert.equal(at.getDate(), 10, 'seven days on, not today');
    assert.ok(at.getTime() > MONDAY_10AM, 'a task is never scheduled in the past');
    assert.equal(at.getHours(), 9);
  });

});

describe('scheduled task edit seeds', () => {
  const task: ScheduledTask = {
    id: 'task-1',
    title: 'Agent heartbeat',
    intent: { kind: 'text', body: 'Check the workspace' },
    schedule: { kind: 'interval', everySeconds: 300, startAt: 1_800_000_000_000 },
    effect: {
      kind: 'agent_run',
      execution: {
        cwd: '/workspace',
        backend: 'ai-sdk',
        llmConnectionSlug: 'default',
        model: 'test-model',
        permissionMode: 'execute',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      },
    },
    status: 'active',
    nextFireAt: 1_800_000_300_000,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'agent', sessionId: 'session-1' },
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    runs: [],
    lastError: null,
  };

  it('locks interval and agent-run semantics instead of coercing them in the task form', () => {
    const seed = scheduledTaskEditSeed(task);
    assert.equal(seed.recurrence, 'interval');
    assert.equal(seed.deliveryMethod, 'agent_run');
    assert.deepEqual(seed.lockedSchedule, task.schedule);
    assert.deepEqual(seed.lockedEffect, task.effect);
  });

  it('keeps the same canonical semantics when duplicating an agent interval task', () => {
    const seed = scheduledTaskDuplicateSeed(task, 'en');
    assert.equal(seed.editingId, null);
    assert.deepEqual(seed.lockedSchedule, task.schedule);
    assert.deepEqual(seed.lockedEffect, task.effect);
  });
});
