import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  compareScheduledTasksForList,
  computeNextFireAt,
  isScheduledTaskDue,
  nextScheduledTaskStateAfterFire,
  normalizeCreateScheduledTaskInput,
  normalizeUpdateScheduledTaskInput,
  pauseScheduledTask,
  resumeScheduledTask,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
} from '@maka/core/scheduled-task';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export interface ScheduledTaskStore {
  list(): Promise<ScheduledTask[]>;
  get(id: string): Promise<ScheduledTask | undefined>;
  create(input: unknown, now?: number): Promise<ScheduledTask>;
  update(id: string, patch: unknown, now?: number): Promise<ScheduledTask>;
  pause(id: string, now?: number): Promise<ScheduledTask>;
  resume(id: string, now?: number): Promise<ScheduledTask>;
  snooze(id: string, delayMs: number, now?: number): Promise<ScheduledTask>;
  clearRunHistory(id: string, now?: number): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  claimNextDue(now?: number): Promise<ScheduledTaskFireClaim | null>;
  claimNow(id: string, now?: number): Promise<ScheduledTaskFireClaim>;
  settleFire(
    claimId: string,
    run: Omit<ScheduledTaskRun, 'id'> & { id?: string },
  ): Promise<ScheduledTask>;
  recoverPendingFires(now?: number): Promise<ScheduledTask[]>;
  ready(): Promise<void>;
  close(): void;
}

export interface ScheduledTaskFireClaim {
  id: string;
  taskId: string;
  scheduledFor: number;
  claimedAt: number;
  task: ScheduledTask;
}

interface ScheduledTaskStoreState {
  tasks: ScheduledTask[];
  claims: ScheduledTaskFireClaim[];
}

export function createSqliteScheduledTaskStore(workspaceRoot: string): ScheduledTaskStore {
  return new SqliteScheduledTaskStore(workspaceRoot);
}

class SqliteScheduledTaskStore implements ScheduledTaskStore {
  readonly #lease: OperationalStateDatabaseLease;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#lease.close();
  }

  async list(): Promise<ScheduledTask[]> {
    return (await this.read()).sort(compareScheduledTasksForList);
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return (await this.read()).find((task) => task.id === id);
  }

  async create(input: unknown, now = Date.now()): Promise<ScheduledTask> {
    const normalized = normalizeCreateScheduledTaskInput(input, now);
    if (!normalized.ok) throw new Error(normalized.message);
    const value = normalized.value;
    const task: ScheduledTask = {
      id: randomUUID(),
      title: value.title,
      intent: { kind: 'text', body: value.intentBody },
      schedule: value.schedule,
      effect: value.effect,
      status: 'active',
      nextFireAt: value.nextFireAt,
      lastFireAt: null,
      fireCount: 0,
      maxFires: value.maxFires ?? null,
      expiresAt: value.expiresAt ?? null,
      createdBy: value.createdBy,
      createdAt: now,
      updatedAt: now,
      runs: [],
      lastError: null,
    };
    await this.mutate((state) => ({ ...state, tasks: [...state.tasks, task] }));
    return task;
  }

  async update(id: string, patch: unknown, now = Date.now()): Promise<ScheduledTask> {
    const normalized = normalizeUpdateScheduledTaskInput(patch, now);
    if (!normalized.ok) throw new Error(normalized.message);
    let updated: ScheduledTask | undefined;
    await this.mutate((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== id) return task;
        assertNoPendingClaim(state.claims, id);
        if (task.status === 'completed' || task.status === 'expired') {
          throw new Error('Cannot update a terminal scheduled task');
        }
        const schedule = normalized.value.schedule ?? task.schedule;
        const nextFireAt = task.status === 'active' ? computeRequiredNext(schedule, now) : null;
        const effect = normalized.value.effect ?? task.effect;
        const intentBody = normalized.value.intentBody ?? task.intent.body;
        const expiresAt = Object.prototype.hasOwnProperty.call(normalized.value, 'expiresAt')
          ? (normalized.value.expiresAt ?? null)
          : task.expiresAt;
        const maxFires = Object.prototype.hasOwnProperty.call(normalized.value, 'maxFires')
          ? (normalized.value.maxFires ?? null)
          : task.maxFires;
        if (effect.kind === 'agent_run' && !intentBody.trim()) {
          throw new Error('Agent run intent body is required');
        }
        if (maxFires !== null && maxFires <= task.fireCount) {
          throw new Error('maxFires must be greater than the current fireCount');
        }
        if (nextFireAt !== null && expiresAt !== null && nextFireAt >= expiresAt) {
          throw new Error('Schedule must fire before expiresAt');
        }
        updated = {
          ...task,
          ...(normalized.value.title !== undefined ? { title: normalized.value.title } : {}),
          ...(normalized.value.intentBody !== undefined
            ? { intent: { kind: 'text', body: normalized.value.intentBody } }
            : {}),
          schedule,
          effect,
          ...(Object.prototype.hasOwnProperty.call(normalized.value, 'maxFires')
            ? { maxFires }
            : {}),
          expiresAt,
          nextFireAt,
          updatedAt: now,
        };
        return updated;
      }),
    }));
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async pause(id: string, now = Date.now()): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== id) return task;
        assertNoPendingClaim(state.claims, id);
        updated = pauseScheduledTask(task, now);
        return updated;
      }),
    }));
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async resume(id: string, now = Date.now()): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== id) return task;
        assertNoPendingClaim(state.claims, id);
        const result = resumeScheduledTask(task, now);
        if ('error' in result) throw new Error(result.error);
        if (
          result.nextFireAt !== null &&
          result.expiresAt !== null &&
          result.nextFireAt >= result.expiresAt
        ) {
          throw new Error('Schedule must fire before expiresAt');
        }
        updated = result;
        return updated;
      }),
    }));
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async snooze(id: string, delayMs: number, now = Date.now()): Promise<ScheduledTask> {
    if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error('Scheduled task snooze delay must be between 1 ms and 7 days');
    }
    let updated: ScheduledTask | undefined;
    await this.mutate((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== id) return task;
        assertNoPendingClaim(state.claims, id);
        if (task.status !== 'active' || task.nextFireAt === null) {
          throw new Error('Only active scheduled tasks can be snoozed');
        }
        const nextFireAt = Math.max(now, task.nextFireAt) + Math.floor(delayMs);
        if (task.expiresAt !== null && nextFireAt >= task.expiresAt) {
          throw new Error('Snooze would move the task beyond expiresAt');
        }
        updated = { ...task, nextFireAt, updatedAt: now };
        return updated;
      }),
    }));
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async clearRunHistory(id: string, now = Date.now()): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((state) => ({
      ...state,
      tasks: state.tasks.map((task) => {
        if (task.id !== id) return task;
        assertNoPendingClaim(state.claims, id);
        updated = { ...task, runs: [], lastError: null, updatedAt: now };
        return updated;
      }),
    }));
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    let found = false;
    await this.mutate((state) => {
      assertNoPendingClaim(state.claims, id);
      const next = state.tasks.filter((task) => {
        if (task.id === id) {
          found = true;
          return false;
        }
        return true;
      });
      return { ...state, tasks: next };
    });
    if (!found) throw new Error(`No such scheduled task: ${id}`);
  }

  async claimNextDue(now = Date.now()): Promise<ScheduledTaskFireClaim | null> {
    let claimed: ScheduledTaskFireClaim | undefined;
    await this.mutate((state) => {
      const claimedTaskIds = new Set(state.claims.map((claim) => claim.taskId));
      const tasks = state.tasks.map((task) => {
        if (task.status === 'active' && task.expiresAt !== null && now >= task.expiresAt) {
          return { ...task, status: 'expired' as const, nextFireAt: null, updatedAt: now };
        }
        return task;
      });
      const task = tasks
        .filter((entry) => isScheduledTaskDue(entry, now) && !claimedTaskIds.has(entry.id))
        .sort(
          (left, right) => left.nextFireAt! - right.nextFireAt! || left.id.localeCompare(right.id),
        )[0];
      if (!task) return { ...state, tasks };
      claimed = createClaim(task, task.nextFireAt!, now);
      return { tasks, claims: [...state.claims, claimed] };
    });
    return claimed ?? null;
  }

  async claimNow(id: string, now = Date.now()): Promise<ScheduledTaskFireClaim> {
    let claimed: ScheduledTaskFireClaim | undefined;
    await this.mutate((state) => {
      const task = state.tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`No such scheduled task: ${id}`);
      assertNoPendingClaim(state.claims, id);
      if (task.status !== 'active') throw new Error('Only active tasks can be triggered now');
      if (task.expiresAt !== null && now >= task.expiresAt) {
        throw new Error('Scheduled task has expired');
      }
      claimed = createClaim(task, now, now);
      return { ...state, claims: [...state.claims, claimed] };
    });
    return claimed!;
  }

  async settleFire(
    claimId: string,
    run: Omit<ScheduledTaskRun, 'id'> & { id?: string },
  ): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((state) => {
      const claim = state.claims.find((entry) => entry.id === claimId);
      if (!claim) throw new Error(`No such scheduled task fire claim: ${claimId}`);
      const tasks = state.tasks.map((task) => {
        if (task.id !== claim.taskId) return task;
        const record: ScheduledTaskRun = {
          id: run.id ?? randomUUID(),
          at: run.at,
          outcome: run.outcome,
          message: run.message,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          ...(run.runId ? { runId: run.runId } : {}),
        };
        updated = nextScheduledTaskStateAfterFire(task, record);
        return updated;
      });
      return { tasks, claims: state.claims.filter((entry) => entry.id !== claimId) };
    });
    if (!updated) throw new Error(`No such scheduled task: claim ${claimId}`);
    return updated;
  }

  async recoverPendingFires(now = Date.now()): Promise<ScheduledTask[]> {
    const recovered: ScheduledTask[] = [];
    await this.mutate((state) => {
      const claimsByTask = new Map(state.claims.map((claim) => [claim.taskId, claim]));
      const tasks = state.tasks.map((task) => {
        const claim = claimsByTask.get(task.id);
        if (!claim) return task;
        const next = nextScheduledTaskStateAfterFire(task, {
          id: randomUUID(),
          at: now,
          outcome: 'failed',
          message: 'The previous fire was interrupted before its outcome was recorded.',
        });
        recovered.push(next);
        return next;
      });
      return { tasks, claims: [] };
    });
    return recovered;
  }

  private async read(): Promise<ScheduledTask[]> {
    return (await this.readState()).tasks;
  }

  private async readState(): Promise<ScheduledTaskStoreState> {
    const rows = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM workflow_scheduled_tasks
        ORDER BY created_at, task_id
      `)
      .all() as Array<{ record_json?: unknown }>;
    const tasks = rows.map((row, index) => {
      if (typeof row.record_json !== 'string') {
        throw new Error(`Invalid scheduled task at row ${index + 1}`);
      }
      return JSON.parse(row.record_json) as ScheduledTask;
    });
    const claimRows = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM workflow_scheduled_task_fires
        ORDER BY claimed_at, claim_id
      `)
      .all() as Array<{ record_json?: unknown }>;
    const claims = claimRows.map((row, index) => {
      if (typeof row.record_json !== 'string') {
        throw new Error(`Invalid scheduled task fire claim at row ${index + 1}`);
      }
      return JSON.parse(row.record_json) as ScheduledTaskFireClaim;
    });
    return { tasks, claims };
  }

  private async mutate(
    fn: (state: ScheduledTaskStoreState) => ScheduledTaskStoreState,
  ): Promise<void> {
    const run = async () => {
      const current = await this.readState();
      this.write(fn(current));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
  }

  private write(state: ScheduledTaskStoreState): void {
    this.#lease.transaction('write', () => {
      this.#lease.database.prepare('DELETE FROM workflow_scheduled_tasks').run();
      this.#lease.database.prepare('DELETE FROM workflow_scheduled_task_fires').run();
      const insert = this.#lease.database.prepare(`
        INSERT INTO workflow_scheduled_tasks(task_id, created_at, updated_at, record_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const task of state.tasks) {
        insert.run(task.id, task.createdAt, task.updatedAt, JSON.stringify(task));
      }
      const insertClaim = this.#lease.database.prepare(`
        INSERT INTO workflow_scheduled_task_fires(claim_id, task_id, claimed_at, record_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const claim of state.claims) {
        insertClaim.run(claim.id, claim.taskId, claim.claimedAt, JSON.stringify(claim));
      }
    });
  }
}

function computeRequiredNext(schedule: ScheduledTaskSchedule, now: number): number {
  const next = computeNextFireAt(schedule, now);
  if (next === null) throw new Error('Schedule has no fire within one year');
  return next;
}

function createClaim(
  task: ScheduledTask,
  scheduledFor: number,
  claimedAt: number,
): ScheduledTaskFireClaim {
  return {
    id: randomUUID(),
    taskId: task.id,
    scheduledFor,
    claimedAt,
    task: structuredClone(task),
  };
}

function assertNoPendingClaim(claims: readonly ScheduledTaskFireClaim[], taskId: string): void {
  if (claims.some((claim) => claim.taskId === taskId)) {
    throw new Error('Scheduled task has a fire in progress');
  }
}
