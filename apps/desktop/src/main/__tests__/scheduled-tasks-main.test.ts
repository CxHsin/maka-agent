import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteScheduledTaskStore } from '@maka/storage';
import { createScheduledTaskMainService } from '../scheduled-tasks-main.js';

describe('ScheduledTask main authority', () => {
  test('admits concurrent trigger requests once', async () => {
    await withRoot(async (root) => {
      let clock = Date.now();
      let fired = 0;
      const store = createSqliteScheduledTaskStore(root);
      const service = createScheduledTaskMainService({
        store,
        getPrivacyContext: async () => ({ incognitoActive: false }),
        sendBotMessage: async () => null,
        emitChanged() {},
        emitFired() {
          fired += 1;
        },
        now: () => clock,
      });
      try {
        await service.refreshTimers();
        const task = await service.create({
          title: 'Only once',
          intentBody: '',
          schedule: { kind: 'once', runAt: clock + 60_000 },
          effect: { kind: 'notify', channel: 'local' },
          createdBy: { kind: 'user' },
        });

        clock += 1;
        const outcomes = await Promise.allSettled([
          service.triggerNow(task.id),
          service.triggerNow(task.id),
        ]);
        assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
        assert.equal(fired, 1);
        assert.equal((await service.list())[0]?.fireCount, 1);
      } finally {
        service.stopTimers();
        store.close();
      }
    });
  });

  test('snoozes a recurring task without changing its calendar schedule', async () => {
    await withRoot(async (root) => {
      const clock = Date.now();
      const store = createSqliteScheduledTaskStore(root);
      const service = createScheduledTaskMainService({
        store,
        getPrivacyContext: async () => ({ incognitoActive: false }),
        sendBotMessage: async () => null,
        emitChanged() {},
        emitFired() {},
        now: () => clock,
      });
      try {
        await service.refreshTimers();
        const task = await service.create({
          title: 'Monthly review',
          intentBody: '',
          schedule: { kind: 'calendar', recurrence: 'monthly', anchorAt: clock + 60_000 },
          effect: { kind: 'notify', channel: 'local' },
          createdBy: { kind: 'user' },
        });
        const snoozed = await service.snooze(task.id);
        assert.deepEqual(snoozed.schedule, task.schedule);
        assert.equal(snoozed.nextFireAt, (task.nextFireAt ?? 0) + 10 * 60_000);
      } finally {
        service.stopTimers();
        store.close();
      }
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-scheduled-task-main-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
