import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeNextFireAt,
  isScheduledTaskDue,
  nextScheduledTaskStateAfterFire,
  normalizeCreateScheduledTaskInput,
  pauseScheduledTask,
  resumeScheduledTask,
  type ScheduledTask,
} from '../scheduled-task.js';
import {
  planReminderFormToCreateInput,
  scheduledTaskToPlanReminderView,
} from '../scheduled-task-plan-view.js';

describe('scheduled-task catalog', () => {
  it('normalizes a cron agent_run create payload', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const result = normalizeCreateScheduledTaskInput(
      {
        title: 'Morning brief',
        intentBody: 'Summarize overnight PRs',
        schedule: { kind: 'cron', expression: '0 9 * * 1-5', startAt: now },
        effect: {
          kind: 'agent_run',
          execution: {
            cwd: '/tmp/ws',
            backend: 'ai-sdk',
            llmConnectionSlug: 'default',
            model: 'test-model',
            permissionMode: 'ask',
            collaborationMode: 'agent',
            orchestrationMode: 'default',
          },
        },
        createdBy: { kind: 'agent', sessionId: 's1' },
      },
      now,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.title, 'Morning brief');
    assert.ok(result.value.nextFireAt > now);
  });

  it('advances once schedules to completed after fire', () => {
    const task: ScheduledTask = {
      id: 't1',
      title: 'Once',
      intent: { kind: 'text', body: 'hi' },
      schedule: { kind: 'once', runAt: 1000 },
      effect: { kind: 'notify', channel: 'local' },
      status: 'active',
      nextFireAt: 1000,
      lastFireAt: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      createdBy: { kind: 'user' },
      createdAt: 0,
      updatedAt: 0,
      runs: [],
      lastError: null,
    };
    const next = nextScheduledTaskStateAfterFire(task, {
      id: 'r1',
      at: 1000,
      outcome: 'ok',
      message: 'done',
    });
    assert.equal(next.status, 'completed');
    assert.equal(next.nextFireAt, null);
    assert.equal(next.fireCount, 1);
  });

  it('pause and resume restore nextFireAt', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const next = computeNextFireAt({ kind: 'interval', everySeconds: 3600, startAt: now }, now);
    assert.ok(next);
    const task: ScheduledTask = {
      id: 't2',
      title: 'Hourly',
      intent: { kind: 'text', body: 'tick' },
      schedule: { kind: 'interval', everySeconds: 3600, startAt: now },
      effect: { kind: 'notify', channel: 'local' },
      status: 'active',
      nextFireAt: next,
      lastFireAt: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      createdBy: { kind: 'user' },
      createdAt: now,
      updatedAt: now,
      runs: [],
      lastError: null,
    };
    assert.equal(isScheduledTaskDue(task, next), true);
    const paused = pauseScheduledTask(task, now + 1);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.nextFireAt, null);
    const resumed = resumeScheduledTask(paused, now + 2);
    assert.ok(!('error' in resumed));
    if ('error' in resumed) return;
    assert.equal(resumed.status, 'active');
    assert.ok(typeof resumed.nextFireAt === 'number');
  });

  it('projects agent-created tasks into the plan-reminder panel shape', () => {
    const task: ScheduledTask = {
      id: 't3',
      title: 'Agent cron',
      intent: { kind: 'text', body: 'do work' },
      schedule: { kind: 'cron', expression: '0 9 * * *', startAt: 1 },
      effect: { kind: 'notify', channel: 'local' },
      status: 'active',
      nextFireAt: 2,
      lastFireAt: null,
      fireCount: 0,
      maxFires: null,
      expiresAt: null,
      createdBy: { kind: 'agent', sessionId: 's1' },
      createdAt: 1,
      updatedAt: 1,
      runs: [],
      lastError: null,
    };
    const view = scheduledTaskToPlanReminderView(task);
    assert.equal(view.title, 'Agent cron');
    assert.equal(view.agentOrigin?.kind, 'cron');
    assert.equal(view.status, 'scheduled');
  });

  it('accepts an empty note for notification tasks', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const result = normalizeCreateScheduledTaskInput(
      planReminderFormToCreateInput({ title: 'Stand up', runAt: now + 60_000 }),
      now,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.intentBody, '');
  });

  it('keeps weekly and monthly recurrences as calendar schedules', () => {
    const runAt = new Date(2026, 0, 31, 9, 30).getTime();
    const weekly = planReminderFormToCreateInput({
      title: 'Weekly',
      runAt,
      recurrence: 'weekly',
    });
    const monthly = planReminderFormToCreateInput({
      title: 'Monthly',
      runAt,
      recurrence: 'monthly',
    });
    assert.deepEqual(weekly.schedule, { kind: 'calendar', recurrence: 'weekly', anchorAt: runAt });
    assert.deepEqual(monthly.schedule, {
      kind: 'calendar',
      recurrence: 'monthly',
      anchorAt: runAt,
    });
    const february = computeNextFireAt(monthly.schedule as never, runAt);
    assert.equal(new Date(february!).getDate(), 28);
  });

  it('rejects tasks whose first fire is not before expiration', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const result = normalizeCreateScheduledTaskInput(
      {
        title: 'Already expired before fire',
        intentBody: '',
        schedule: { kind: 'once', runAt: now + 60_000 },
        effect: { kind: 'notify', channel: 'local' },
        createdBy: { kind: 'user' },
        expiresAt: now + 30_000,
      },
      now,
    );
    assert.deepEqual(result, { ok: false, message: 'Schedule must fire before expiresAt' });
  });

  it('rejects future recurrence anchors outside the scheduling horizon', () => {
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    for (const schedule of [
      { kind: 'interval', everySeconds: 60, startAt: now + 367 * 86_400_000 },
      { kind: 'calendar', recurrence: 'monthly', anchorAt: now + 367 * 86_400_000 },
    ]) {
      const result = normalizeCreateScheduledTaskInput(
        {
          title: 'Too far away',
          intentBody: '',
          schedule,
          effect: { kind: 'notify', channel: 'local' },
          createdBy: { kind: 'user' },
        },
        now,
      );
      assert.deepEqual(result, {
        ok: false,
        message: 'Schedule has no fire within one year from now',
      });
    }
  });
});
