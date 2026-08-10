/**
 * View adapter: ScheduledTask ↔ the existing plan-reminder panel shape.
 * One catalog (ScheduledTask) feeds one UI surface without dual storage.
 */

import type { PlanReminder, PlanReminderSchedule, PlanReminderStatus } from './plan-reminders.js';
import type { ScheduledTask, ScheduledTaskSchedule } from './scheduled-task.js';

export function scheduledTaskToPlanReminderView(task: ScheduledTask): PlanReminder {
  const status = mapStatus(task);
  return {
    id: task.id,
    title: task.title,
    note: task.intent.body,
    schedule: mapScheduleOut(task.schedule),
    delivery:
      task.effect.kind === 'notify' && task.effect.channel === 'bot'
        ? {
            channel: 'bot',
            platform: task.effect.platform,
            chatId: task.effect.chatId,
          }
        : { channel: 'local' },
    status,
    enabled: task.status === 'active',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(typeof task.nextFireAt === 'number' ? { nextRunAt: task.nextFireAt } : {}),
    ...(task.runs[0]
      ? {
          lastRun: {
            id: task.runs[0].id,
            at: task.runs[0].at,
            status:
              task.runs[0].outcome === 'ok'
                ? 'triggered'
                : task.runs[0].outcome === 'blocked'
                  ? 'blocked'
                  : 'failed',
            message: task.runs[0].message,
          },
        }
      : {}),
    runs: task.runs.map((run) => ({
      id: run.id,
      at: run.at,
      status: run.outcome === 'ok' ? 'triggered' : run.outcome === 'blocked' ? 'blocked' : 'failed',
      message: run.message,
    })),
    runCount: task.fireCount,
    ...(task.createdBy.kind === 'agent'
      ? {
          agentOrigin: {
            automationId: task.id,
            sessionId: task.createdBy.sessionId ?? '',
            kind: 'cron' as const,
            durable: true,
          },
        }
      : {}),
  };
}

export function planReminderFormToCreateInput(input: {
  title: string;
  note?: string;
  runAt: number;
  recurrence?: string;
  cronExpression?: string;
  delivery?: { channel: string; platform?: string; chatId?: string };
}): Record<string, unknown> {
  const schedule = formSchedule(input);
  const effect =
    input.delivery?.channel === 'bot' && input.delivery.platform && input.delivery.chatId
      ? {
          kind: 'notify',
          channel: 'bot',
          platform: input.delivery.platform,
          chatId: input.delivery.chatId,
        }
      : { kind: 'notify', channel: 'local' };
  return {
    title: input.title,
    intentBody: input.note ?? '',
    schedule,
    effect,
    createdBy: { kind: 'user' },
  };
}

function formSchedule(input: {
  runAt: number;
  recurrence?: string;
  cronExpression?: string;
}): ScheduledTaskSchedule {
  const recurrence = input.recurrence ?? 'none';
  if (recurrence === 'cron' && input.cronExpression) {
    return { kind: 'cron', expression: input.cronExpression, startAt: input.runAt };
  }
  if (recurrence === 'daily') {
    return { kind: 'interval', everySeconds: 86_400, startAt: input.runAt };
  }
  if (recurrence === 'weekly') {
    return { kind: 'interval', everySeconds: 7 * 86_400, startAt: input.runAt };
  }
  if (recurrence === 'monthly') {
    // Approximate month as 30d interval for the unified schedule model.
    return { kind: 'interval', everySeconds: 30 * 86_400, startAt: input.runAt };
  }
  return { kind: 'once', runAt: input.runAt };
}

function mapStatus(task: ScheduledTask): PlanReminderStatus {
  if (task.status === 'active') return 'scheduled';
  if (task.status === 'paused') return 'paused';
  return 'completed';
}

function mapScheduleOut(schedule: ScheduledTaskSchedule): PlanReminderSchedule {
  if (schedule.kind === 'once') return { kind: 'once', runAt: schedule.runAt };
  if (schedule.kind === 'cron') {
    return { kind: 'cron', startAt: schedule.startAt, expression: schedule.expression };
  }
  if (schedule.everySeconds === 86_400) {
    return { kind: 'recurring', startAt: schedule.startAt, recurrence: 'daily' };
  }
  if (schedule.everySeconds === 7 * 86_400) {
    return { kind: 'recurring', startAt: schedule.startAt, recurrence: 'weekly' };
  }
  if (schedule.everySeconds === 30 * 86_400) {
    return { kind: 'recurring', startAt: schedule.startAt, recurrence: 'monthly' };
  }
  // Generic interval shown as once-next for the legacy panel schedule chips.
  return {
    kind: 'once',
    runAt: schedule.startAt + schedule.everySeconds * 1000,
  };
}
