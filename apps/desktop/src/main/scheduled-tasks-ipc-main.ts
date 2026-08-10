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
    const record = isRecord(input) ? input : {};
    return deps.scheduledTasks.create({ ...record, createdBy: { kind: 'user' } });
  });
  target.handle('scheduled-tasks:update', async (_event, id: string, patch: unknown) => {
    return deps.scheduledTasks.update(id, patch);
  });
  target.handle('scheduled-tasks:setEnabled', async (_event, id: string, enabled: boolean) =>
    enabled ? deps.scheduledTasks.resume(id) : deps.scheduledTasks.pause(id),
  );
  target.handle('scheduled-tasks:delete', (_event, id: string) => deps.scheduledTasks.remove(id));
  target.handle('scheduled-tasks:triggerNow', (_event, id: string) =>
    deps.scheduledTasks.triggerNow(id),
  );
  target.handle('scheduled-tasks:snooze', (_event, id: string) => deps.scheduledTasks.snooze(id));
  target.handle('scheduled-tasks:clearRunHistory', (_event, id: string) =>
    deps.scheduledTasks.clearRunHistory(id),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
