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
import { scheduledTaskToPlanReminderView } from '../scheduled-task-plan-view.js';

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
});
