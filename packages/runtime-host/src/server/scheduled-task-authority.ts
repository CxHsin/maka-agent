/**
 * Host-side authority for the agent ScheduledTask tool.
 * Writes the same SQLite catalog the desktop scheduler reads.
 */

import type { SessionHeader } from '@maka/core/session';
import type { ScheduledTask, ScheduledTaskExecutionTemplate } from '@maka/core/scheduled-task';
import {
  buildAgentScheduledTaskCreatePayload,
  type ScheduledTaskToolAuthority,
} from '@maka/runtime';
import { createSqliteScheduledTaskStore, type ScheduledTaskStore } from '@maka/storage';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import { isSessionNotFoundError } from '@maka/storage/execution-stores';

export interface HostScheduledTaskAuthorityInput {
  readonly workspaceRoot: string;
  readonly sessions: Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
}

export class HostScheduledTaskAuthority implements ScheduledTaskToolAuthority {
  readonly #store: ScheduledTaskStore;
  readonly #sessions: HostScheduledTaskAuthorityInput['sessions'];

  constructor(input: HostScheduledTaskAuthorityInput) {
    this.#store = createSqliteScheduledTaskStore(input.workspaceRoot);
    this.#sessions = input.sessions;
  }

  async ready(): Promise<void> {
    await this.#store.ready();
  }

  close(): void {
    this.#store.close();
  }

  async create(input: {
    title: string;
    intentBody: string;
    schedule:
      | { kind: 'once'; runAt: number }
      | { kind: 'interval'; everySeconds: number; startAt?: number }
      | { kind: 'cron'; expression: string; startAt?: number };
    effect: 'agent_run' | 'notify_local';
    sessionId: string;
    maxFires?: number;
  }): Promise<ScheduledTask | { error: string }> {
    let header: SessionHeader;
    try {
      header = await this.#sessions.readHeaderSnapshot(input.sessionId);
    } catch (error) {
      if (isSessionNotFoundError(error)) return { error: 'Session was not found' };
      throw error;
    }
    const execution = executionTemplateFromHeader(header);
    const payload = buildAgentScheduledTaskCreatePayload({
      ...input,
      ...(input.effect === 'agent_run' ? { execution } : {}),
    });
    if ('error' in payload) return payload;
    try {
      return await this.#store.create(payload);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async list(_sessionId: string): Promise<readonly ScheduledTask[]> {
    return this.#store.list();
  }

  async pause(id: string, _sessionId: string): Promise<ScheduledTask | { error: string }> {
    try {
      return await this.#store.pause(id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async resume(id: string, _sessionId: string): Promise<ScheduledTask | { error: string }> {
    try {
      return await this.#store.resume(id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async remove(id: string, _sessionId: string): Promise<{ ok: true } | { error: string }> {
    try {
      await this.#store.remove(id);
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function executionTemplateFromHeader(header: SessionHeader): ScheduledTaskExecutionTemplate {
  return {
    cwd: header.cwd,
    ...(header.projectId === undefined ? {} : { projectId: header.projectId }),
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
  };
}
