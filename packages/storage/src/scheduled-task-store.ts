import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
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
  remove(id: string): Promise<void>;
  listDue(now?: number): Promise<ScheduledTask[]>;
  recordFire(
    id: string,
    run: Omit<ScheduledTaskRun, 'id'> & { id?: string },
  ): Promise<ScheduledTask>;
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteScheduledTaskStore(workspaceRoot: string): ScheduledTaskStore {
  return new SqliteScheduledTaskStore(workspaceRoot);
}

class SqliteScheduledTaskStore implements ScheduledTaskStore {
  readonly #lease: OperationalStateDatabaseLease;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
    ensureScheduledTaskSchema(this.#lease.database);
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
    await this.mutate((tasks) => [...tasks, task]);
    return task;
  }

  async update(id: string, patch: unknown, now = Date.now()): Promise<ScheduledTask> {
    const normalized = normalizeUpdateScheduledTaskInput(patch, now);
    if (!normalized.ok) throw new Error(normalized.message);
    let updated: ScheduledTask | undefined;
    await this.mutate((tasks) =>
      tasks.map((task) => {
        if (task.id !== id) return task;
        if (task.status === 'completed' || task.status === 'expired') {
          throw new Error('Cannot update a terminal scheduled task');
        }
        const schedule = normalized.value.schedule ?? task.schedule;
        const nextFireAt = task.status === 'active' ? computeRequiredNext(schedule, now) : null;
        updated = {
          ...task,
          ...(normalized.value.title !== undefined ? { title: normalized.value.title } : {}),
          ...(normalized.value.intentBody !== undefined
            ? { intent: { kind: 'text', body: normalized.value.intentBody } }
            : {}),
          schedule,
          ...(normalized.value.effect !== undefined ? { effect: normalized.value.effect } : {}),
          ...(Object.prototype.hasOwnProperty.call(normalized.value, 'maxFires')
            ? { maxFires: normalized.value.maxFires ?? null }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(normalized.value, 'expiresAt')
            ? { expiresAt: normalized.value.expiresAt ?? null }
            : {}),
          nextFireAt,
          updatedAt: now,
        };
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async pause(id: string, now = Date.now()): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((tasks) =>
      tasks.map((task) => {
        if (task.id !== id) return task;
        updated = pauseScheduledTask(task, now);
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async resume(id: string, now = Date.now()): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((tasks) =>
      tasks.map((task) => {
        if (task.id !== id) return task;
        const result = resumeScheduledTask(task, now);
        if ('error' in result) throw new Error(result.error);
        updated = result;
        return updated;
      }),
    );
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  async remove(id: string): Promise<void> {
    let found = false;
    await this.mutate((tasks) => {
      const next = tasks.filter((task) => {
        if (task.id === id) {
          found = true;
          return false;
        }
        return true;
      });
      return next;
    });
    if (!found) throw new Error(`No such scheduled task: ${id}`);
  }

  async listDue(now = Date.now()): Promise<ScheduledTask[]> {
    return (await this.read()).filter((task) => isScheduledTaskDue(task, now));
  }

  async recordFire(
    id: string,
    run: Omit<ScheduledTaskRun, 'id'> & { id?: string },
  ): Promise<ScheduledTask> {
    let updated: ScheduledTask | undefined;
    await this.mutate((tasks) =>
      tasks.map((task) => {
        if (task.id !== id) return task;
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
      }),
    );
    if (!updated) throw new Error(`No such scheduled task: ${id}`);
    return updated;
  }

  private async read(): Promise<ScheduledTask[]> {
    const rows = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM workflow_scheduled_tasks
        ORDER BY created_at, task_id
      `)
      .all() as Array<{ record_json?: unknown }>;
    return rows.map((row, index) => {
      if (typeof row.record_json !== 'string') {
        throw new Error(`Invalid scheduled task at row ${index + 1}`);
      }
      return JSON.parse(row.record_json) as ScheduledTask;
    });
  }

  private async mutate(fn: (tasks: ScheduledTask[]) => ScheduledTask[]): Promise<void> {
    const run = async () => {
      const current = await this.read();
      this.write(fn(current));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    await next;
  }

  private write(tasks: ScheduledTask[]): void {
    this.#lease.transaction('write', () => {
      this.#lease.database.prepare('DELETE FROM workflow_scheduled_tasks').run();
      const insert = this.#lease.database.prepare(`
        INSERT INTO workflow_scheduled_tasks(task_id, created_at, updated_at, record_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const task of tasks) {
        insert.run(task.id, task.createdAt, task.updatedAt, JSON.stringify(task));
      }
    });
  }
}

function computeRequiredNext(schedule: ScheduledTaskSchedule, now: number): number {
  const next = computeNextFireAt(schedule, now);
  if (next === null) throw new Error('Schedule has no fire within one year');
  return next;
}

function ensureScheduledTaskSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_scheduled_tasks_order
      ON workflow_scheduled_tasks(created_at, task_id);
  `);
}
