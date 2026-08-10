/**
 * Host adapter for the agent ScheduledTask tool.
 * The initiating Desktop owns the single catalog and scheduler authority;
 * Host calls it through the Session-bound reverse capability channel.
 */

import type { SessionHeader } from '@maka/core/session';
import type { ScheduledTask, ScheduledTaskExecutionTemplate } from '@maka/core/scheduled-task';
import {
  buildAgentScheduledTaskCreatePayload,
  SCHEDULED_TASK_AUTHORITY_SERVICE_ID,
  SCHEDULED_TASK_AUTHORITY_SERVICE_VERSION,
  type ScheduledTaskToolAuthority,
} from '@maka/runtime';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import { isSessionNotFoundError } from '@maka/storage/execution-stores';

export interface HostScheduledTaskAuthorityInput {
  readonly sessions: Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
  readonly clientCapabilities: {
    callServiceForSession(input: {
      readonly sessionId: string;
      readonly serviceId: string;
      readonly version: string;
      readonly method: string;
      readonly input: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
  };
}

export class HostScheduledTaskAuthority implements ScheduledTaskToolAuthority {
  readonly #sessions: HostScheduledTaskAuthorityInput['sessions'];
  readonly #clientCapabilities: HostScheduledTaskAuthorityInput['clientCapabilities'];

  constructor(input: HostScheduledTaskAuthorityInput) {
    this.#sessions = input.sessions;
    this.#clientCapabilities = input.clientCapabilities;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}

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
      return await this.#taskCall(input.sessionId, 'create', { payload });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async list(sessionId: string): Promise<readonly ScheduledTask[]> {
    const result = await this.#call(sessionId, 'list', {});
    return Array.isArray(result.tasks) ? (result.tasks as ScheduledTask[]) : [];
  }

  async pause(id: string, sessionId: string): Promise<ScheduledTask | { error: string }> {
    try {
      return await this.#taskCall(sessionId, 'pause', { id });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async resume(id: string, sessionId: string): Promise<ScheduledTask | { error: string }> {
    try {
      return await this.#taskCall(sessionId, 'resume', { id });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async remove(id: string, sessionId: string): Promise<{ ok: true } | { error: string }> {
    try {
      await this.#call(sessionId, 'delete', { id });
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #taskCall(
    sessionId: string,
    method: string,
    input: Record<string, unknown>,
  ): Promise<ScheduledTask> {
    const result = await this.#call(sessionId, method, input);
    if (!result.task || typeof result.task !== 'object' || Array.isArray(result.task)) {
      throw new Error('Desktop ScheduledTask authority returned an invalid task');
    }
    return result.task as ScheduledTask;
  }

  #call(
    sessionId: string,
    method: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#clientCapabilities.callServiceForSession({
      sessionId,
      serviceId: SCHEDULED_TASK_AUTHORITY_SERVICE_ID,
      version: SCHEDULED_TASK_AUTHORITY_SERVICE_VERSION,
      method,
      input,
    });
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
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
  };
}
