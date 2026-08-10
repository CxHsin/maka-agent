/**
 * Sole scheduler for the unified ScheduledTask catalog.
 *
 * Host agent tools call this Desktop authority through a reverse Client
 * Capability; this is the only process that writes or advances due fires.
 */

import { randomUUID } from 'node:crypto';
import {
  botDisplayLabel,
  isBotDeliveryProvider,
  type BotProvider,
  type ScheduledTask,
  type WorkspacePrivacyContext,
} from '@maka/core';
import type { ScheduledTaskFireClaim, ScheduledTaskStore } from '@maka/storage';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ScheduledTaskChangedReason =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'fired'
  | 'blocked';

export interface ScheduledTaskMainService {
  list(): Promise<ScheduledTask[]>;
  create(input: unknown): Promise<ScheduledTask>;
  update(id: string, patch: unknown): Promise<ScheduledTask>;
  pause(id: string): Promise<ScheduledTask>;
  resume(id: string): Promise<ScheduledTask>;
  snooze(id: string, delayMs?: number): Promise<ScheduledTask>;
  clearRunHistory(id: string): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  triggerNow(id: string): Promise<ScheduledTask>;
  refreshTimers(): Promise<void>;
  stopTimers(): void;
}

export interface AgentRunFireRequest {
  task: ScheduledTask;
  sessionId: string;
  turnId: string;
  runId: string;
  userMessageId: string;
}

export interface ScheduledTaskMainServiceDeps {
  store: ScheduledTaskStore;
  getPrivacyContext(): Promise<WorkspacePrivacyContext>;
  sendBotMessage(platform: BotProvider, chatId: string, text: string): Promise<unknown | null>;
  /**
   * Start an agent session turn for agent_run effects. Returns session/run ids
   * on success. Throws / returns error message on failure.
   */
  startAgentRun?(request: AgentRunFireRequest): Promise<{ sessionId: string; runId?: string }>;
  /**
   * Snapshot execution template fields when the UI creates an agent_run task
   * without an explicit template (uses active desktop session defaults).
   */
  resolveDefaultAgentExecution?(): Promise<
    | Extract<ScheduledTask['effect'], { kind: 'agent_run' }>['execution']
    | null
  >;
  emitChanged(reason: ScheduledTaskChangedReason, task: Pick<ScheduledTask, 'id'>): void;
  emitFired(task: ScheduledTask): void;
  now?: () => number;
}

export function createScheduledTaskMainService(
  deps: ScheduledTaskMainServiceDeps,
): ScheduledTaskMainService {
  const timers = new Map<string, NodeJS.Timeout>();
  const now = () => deps.now?.() ?? Date.now();
  let refreshTask: Promise<void> | undefined;
  let recovered = false;

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }

  function schedule(task: ScheduledTask): void {
    clearTimer(task.id);
    if (task.status !== 'active' || typeof task.nextFireAt !== 'number') return;
    const delay = Math.max(0, task.nextFireAt - now());
    const timer = setTimeout(() => {
      timers.delete(task.id);
      void refreshTimers();
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timers.set(task.id, timer);
  }

  function refreshTimers(): Promise<void> {
    if (refreshTask) return refreshTask;
    const task = (async () => {
      stopTimers();
      if (!recovered) {
        const interrupted = await deps.store.recoverPendingFires(now());
        recovered = true;
        for (const entry of interrupted) deps.emitChanged('fired', entry);
      }
      await triggerDue();
      for (const entry of await deps.store.list()) schedule(entry);
    })();
    const wrapped = task.finally(() => {
      if (refreshTask === wrapped) refreshTask = undefined;
    });
    refreshTask = wrapped;
    return wrapped;
  }

  function stopTimers(): void {
    for (const id of Array.from(timers.keys())) clearTimer(id);
  }

  async function triggerDue(): Promise<void> {
    while (true) {
      const claim = await deps.store.claimNextDue(now());
      if (!claim) return;
      await fulfill(claim, now());
    }
  }

  async function fulfill(claim: ScheduledTaskFireClaim, at: number): Promise<void> {
    const task = claim.task;
    let privacy: WorkspacePrivacyContext;
    try {
      privacy = await deps.getPrivacyContext();
    } catch (error) {
      const failed = await settleFailure(claim, at, error);
      schedule(failed);
      deps.emitChanged('fired', failed);
      return;
    }
    if (privacy.incognitoActive) {
      const blocked = await deps.store.settleFire(claim.id, {
        at,
        outcome: 'blocked',
        message: '隐私模式已开启，定时任务没有触发。',
      });
      schedule(blocked);
      deps.emitChanged('blocked', blocked);
      return;
    }

    if (task.effect.kind === 'notify' && task.effect.channel === 'bot') {
      if (!isBotDeliveryProvider(task.effect.platform)) {
        const blocked = await deps.store.settleFire(claim.id, {
          at,
          outcome: 'blocked',
          message: `${botDisplayLabel(task.effect.platform)} 当前不是可投递目标。`,
        });
        schedule(blocked);
        deps.emitChanged('blocked', blocked);
        return;
      }
      const sent = await deps
        .sendBotMessage(
          task.effect.platform,
          task.effect.chatId,
          formatNotifyMessage(task),
        )
        .catch(() => null);
      if (!sent) {
        const blocked = await deps.store.settleFire(claim.id, {
          at,
          outcome: 'blocked',
          message: `${botDisplayLabel(task.effect.platform)} 通道不可用。`,
        });
        schedule(blocked);
        deps.emitChanged('blocked', blocked);
        return;
      }
      const fired = await deps.store.settleFire(claim.id, {
        at,
        outcome: 'ok',
        message: `已投递到 ${botDisplayLabel(task.effect.platform)}。`,
      });
      schedule(fired);
      deps.emitChanged('fired', fired);
      deps.emitFired(fired);
      return;
    }

    if (task.effect.kind === 'notify') {
      // The renderer notification is the side effect. Admit it before marking
      // the fire settled so a crash cannot record success for an unseen alert.
      deps.emitFired(task);
      const fired = await deps.store.settleFire(claim.id, {
        at,
        outcome: 'ok',
        message: '本地提醒已触发。',
      });
      schedule(fired);
      deps.emitChanged('fired', fired);
      return;
    }

    // agent_run
    if (!deps.startAgentRun) {
      const failed = await deps.store.settleFire(claim.id, {
        at,
        outcome: 'failed',
        message: 'Agent run fulfillment is not available.',
      });
      schedule(failed);
      deps.emitChanged('fired', failed);
      return;
    }
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const runId = randomUUID();
    const userMessageId = randomUUID();
    try {
      const started = await deps.startAgentRun({
        task,
        sessionId,
        turnId,
        runId,
        userMessageId,
      });
      const fired = await deps.store.settleFire(claim.id, {
        at,
        outcome: 'ok',
        message: '已启动 Agent 会话执行。',
        sessionId: started.sessionId,
        ...(started.runId ? { runId: started.runId } : { runId }),
      });
      schedule(fired);
      deps.emitChanged('fired', fired);
      deps.emitFired(fired);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await deps.store.settleFire(claim.id, {
        at,
        outcome: 'failed',
        message,
      });
      schedule(failed);
      deps.emitChanged('fired', failed);
    }
  }

  async function settleFailure(
    claim: ScheduledTaskFireClaim,
    at: number,
    error: unknown,
  ): Promise<ScheduledTask> {
    return deps.store.settleFire(claim.id, {
      at,
      outcome: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    list: () => deps.store.list(),
    async create(input) {
      let payload = input;
      if (
        isObject(input) &&
        isObject(input.effect) &&
        input.effect.kind === 'agent_run' &&
        input.effect.execution === undefined &&
        deps.resolveDefaultAgentExecution
      ) {
        const execution = await deps.resolveDefaultAgentExecution();
        if (!execution) throw new Error('No default agent execution template available');
        payload = {
          ...input,
          effect: { kind: 'agent_run', execution },
        };
      }
      const createdBy =
        isObject(payload) && payload.createdBy
          ? payload.createdBy
          : { kind: 'user' as const };
      const task = await deps.store.create({
        ...(isObject(payload) ? payload : {}),
        createdBy,
      });
      schedule(task);
      deps.emitChanged('created', task);
      return task;
    },
    async update(id, patch) {
      const task = await deps.store.update(id, patch);
      schedule(task);
      deps.emitChanged('updated', task);
      return task;
    },
    async pause(id) {
      const task = await deps.store.pause(id);
      schedule(task);
      deps.emitChanged('updated', task);
      return task;
    },
    async resume(id) {
      const task = await deps.store.resume(id);
      schedule(task);
      deps.emitChanged('updated', task);
      return task;
    },
    async snooze(id, delayMs = 10 * 60 * 1000) {
      const task = await deps.store.snooze(id, delayMs);
      schedule(task);
      deps.emitChanged('updated', task);
      return task;
    },
    async clearRunHistory(id) {
      const task = await deps.store.clearRunHistory(id);
      schedule(task);
      deps.emitChanged('updated', task);
      return task;
    },
    async remove(id) {
      clearTimer(id);
      await deps.store.remove(id);
      deps.emitChanged('deleted', { id });
    },
    async triggerNow(id) {
      const claim = await deps.store.claimNow(id, now());
      await fulfill(claim, now());
      const updated = (await deps.store.list()).find((entry) => entry.id === id);
      if (!updated) throw new Error(`No such scheduled task: ${id}`);
      schedule(updated);
      return updated;
    },
    refreshTimers,
    stopTimers,
  };
}

function formatNotifyMessage(task: ScheduledTask): string {
  const lines = [`【定时任务】${task.title}`];
  if (task.intent.body.trim()) lines.push('', task.intent.body.trim());
  return lines.join('\n');
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
