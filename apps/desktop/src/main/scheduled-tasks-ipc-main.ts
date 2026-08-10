import { ipcMain } from 'electron';
import {
  planReminderFormToCreateInput,
  scheduledTaskToPlanReminderView,
  type WorkspacePrivacyContext,
} from '@maka/core';
import type { ScheduledTaskMainService } from './scheduled-tasks-main.js';

interface ScheduledTaskIpcDeps {
  scheduledTasks: ScheduledTaskMainService;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  ipcMain?: Pick<typeof ipcMain, 'handle'>;
}

export function registerScheduledTaskIpc(deps: ScheduledTaskIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle('scheduled-tasks:list', async () =>
    (await deps.scheduledTasks.list()).map(scheduledTaskToPlanReminderView),
  );
  target.handle('scheduled-tasks:create', async (_event, input: unknown) => {
    const privacy = await deps.getWorkspacePrivacyContext();
    if (privacy.incognitoActive) {
      throw new Error('SCHEDULED_TASK_INCOGNITO_ACTIVE');
    }
    return scheduledTaskToPlanReminderView(
      await deps.scheduledTasks.create(planReminderFormToCreateInput(input as never)),
    );
  });
  target.handle('scheduled-tasks:update', async (_event, id: string, patch: unknown) => {
    const record = patch as Record<string, unknown>;
    const updatesSchedule =
      record.runAt !== undefined ||
      record.recurrence !== undefined ||
      record.cronExpression !== undefined;
    if (updatesSchedule && typeof record.runAt !== 'number') {
      throw new Error('Scheduled task schedule updates require runAt');
    }
    return scheduledTaskToPlanReminderView(
      await deps.scheduledTasks.update(id, {
        ...(typeof record.title === 'string' ? { title: record.title } : {}),
        ...(typeof record.note === 'string' ? { intentBody: record.note } : {}),
        ...(updatesSchedule
          ? {
              schedule: planReminderFormToCreateInput({
                title: 'scheduled-task-update',
                runAt: record.runAt as number,
                recurrence:
                  typeof record.recurrence === 'string' ? record.recurrence : undefined,
                cronExpression:
                  typeof record.cronExpression === 'string'
                    ? record.cronExpression
                    : undefined,
              }).schedule,
            }
          : {}),
        ...(record.delivery !== undefined
          ? {
              effect: planReminderFormToCreateInput({
                title: 'scheduled-task-update',
                runAt: Date.now() + 60_000,
                delivery: record.delivery as never,
              }).effect,
            }
          : {}),
      }),
    );
  });
  target.handle('scheduled-tasks:setEnabled', async (_event, id: string, enabled: boolean) =>
    scheduledTaskToPlanReminderView(
      enabled ? await deps.scheduledTasks.resume(id) : await deps.scheduledTasks.pause(id),
    ),
  );
  target.handle('scheduled-tasks:delete', (_event, id: string) => deps.scheduledTasks.remove(id));
  target.handle('scheduled-tasks:triggerNow', async (_event, id: string) =>
    scheduledTaskToPlanReminderView(await deps.scheduledTasks.triggerNow(id)),
  );
  target.handle('scheduled-tasks:snooze', async (_event, id: string) =>
    scheduledTaskToPlanReminderView(await deps.scheduledTasks.snooze(id)),
  );
  target.handle('scheduled-tasks:clearRunHistory', async (_event, id: string) =>
    scheduledTaskToPlanReminderView(await deps.scheduledTasks.clearRunHistory(id)),
  );
}
