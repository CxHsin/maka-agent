import { ipcMain } from 'electron';
import type { WorkspacePrivacyContext } from '@maka/core';
import type { ScheduledTaskMainService } from './scheduled-tasks-main.js';

interface ScheduledTaskIpcDeps {
  scheduledTasks: ScheduledTaskMainService;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
  ipcMain?: Pick<typeof ipcMain, 'handle'>;
}

export function registerScheduledTaskIpc(deps: ScheduledTaskIpcDeps): void {
  const target = deps.ipcMain ?? ipcMain;
  target.handle('scheduled-tasks:list', () => deps.scheduledTasks.list());
  target.handle('scheduled-tasks:create', async (_event, input: unknown) => {
    const privacy = await deps.getWorkspacePrivacyContext();
    if (privacy.incognitoActive) {
      throw new Error('SCHEDULED_TASK_INCOGNITO_ACTIVE');
    }
    return deps.scheduledTasks.create(input);
  });
  target.handle('scheduled-tasks:update', (_event, id: string, patch: unknown) =>
    deps.scheduledTasks.update(id, patch),
  );
  target.handle('scheduled-tasks:pause', (_event, id: string) => deps.scheduledTasks.pause(id));
  target.handle('scheduled-tasks:resume', (_event, id: string) => deps.scheduledTasks.resume(id));
  target.handle('scheduled-tasks:delete', (_event, id: string) => deps.scheduledTasks.remove(id));
  target.handle('scheduled-tasks:triggerNow', (_event, id: string) =>
    deps.scheduledTasks.triggerNow(id),
  );
}
