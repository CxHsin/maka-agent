/**
 * Live-only open-facts decode/build for tool_result_preview.
 * Types live in events.ts; durable transcript uses ToolResultContent.
 */

import type {
  AgentSwarmPreviewItem,
  ToolResultContent,
  ToolResultPreviewContent,
} from './events.js';
import { isPermissionMode } from './permission.js';
import { defineObjectShape, hasExactShape, isOptionalString, isRecord } from './record-schema.js';

const SUBAGENT_PREVIEW_SHAPE = defineObjectShape<
  Extract<ToolResultPreviewContent, { kind: 'subagent' }>
>()(
  ['kind', 'agentName', 'turnId', 'status', 'permissionMode'],
  ['childSessionId', 'agentId', 'runId'],
);

const AGENT_SWARM_PREVIEW_SHAPE = defineObjectShape<
  Extract<ToolResultPreviewContent, { kind: 'agent_swarm' }>
>()(['kind', 'status', 'items'], []);

const AGENT_SWARM_PREVIEW_ITEM_SHAPE = defineObjectShape<AgentSwarmPreviewItem>()(
  ['itemId', 'index', 'profile', 'started', 'status'],
  ['childSessionId', 'agentId', 'agentName', 'turnId', 'runId', 'resumedFromRunId'],
);

const PREVIEW_BATCH_STATUSES = new Set(['running', 'completed', 'partial', 'failed', 'cancelled']);
const PREVIEW_ITEM_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const PREVIEW_SUBAGENT_STATUSES = new Set(['running', 'waiting_for_user']);

/**
 * Decode live tool_result_preview content. Never use for transcript recovery.
 */
export function decodeToolResultPreviewContent(value: unknown): ToolResultPreviewContent {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid tool result preview content');
  }
  if (value.kind === 'subagent') {
    if (!isSubagentPreview(value)) throw new Error('Invalid tool result preview content');
    return value;
  }
  if (value.kind === 'agent_swarm') {
    if (!isAgentSwarmPreview(value)) throw new Error('Invalid tool result preview content');
    return value;
  }
  throw new Error('Invalid tool result preview content');
}

/**
 * Project open-facts into the activity row model (ToolResultContent with empty
 * bulk). Keeps ToolActivityItem.result as a single field without dual storage.
 */
export function materializeToolResultPreviewForActivity(
  content: ToolResultPreviewContent,
): ToolResultContent {
  if (content.kind === 'subagent') {
    return {
      kind: 'subagent',
      ...(content.childSessionId ? { childSessionId: content.childSessionId } : {}),
      ...(content.agentId ? { agentId: content.agentId } : {}),
      agentName: content.agentName,
      turnId: content.turnId,
      ...(content.runId ? { runId: content.runId } : {}),
      status: content.status,
      permissionMode: content.permissionMode,
      summary: '',
      artifactIds: [],
    };
  }
  return {
    kind: 'agent_swarm',
    status: content.status,
    items: content.items.map((item) => ({
      itemId: item.itemId,
      index: item.index,
      profile: item.profile,
      started: item.started,
      ...(item.childSessionId ? { childSessionId: item.childSessionId } : {}),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      ...(item.agentName ? { agentName: item.agentName } : {}),
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
      status: item.status,
      summary: '',
      artifactIds: [],
    })),
    startedAt: 0,
    completedAt: 0,
    durationMs: 0,
  };
}

/** Open-facts snapshot for mid-flight swarm Open. No summary/artifact bulk. */
export function buildAgentSwarmPreviewContent(input: {
  readonly items: readonly AgentSwarmPreviewItem[];
}): Extract<ToolResultPreviewContent, { kind: 'agent_swarm' }> {
  const items = input.items.map((item) => ({ ...item }));
  return {
    kind: 'agent_swarm',
    status: aggregateAgentSwarmPreviewStatus(items),
    items,
  };
}

export function aggregateAgentSwarmPreviewStatus(
  items: readonly AgentSwarmPreviewItem[],
): Extract<ToolResultPreviewContent, { kind: 'agent_swarm' }>['status'] {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  if (items.some((item) => !terminal.has(item.status))) return 'running';
  if (items.length > 0 && items.every((item) => item.status === 'failed')) return 'failed';
  if (items.some((item) => item.status === 'cancelled')) return 'cancelled';
  if (items.length > 0 && items.every((item) => item.status === 'completed')) return 'completed';
  return 'partial';
}

function isSubagentPreview(
  value: Record<string, unknown>,
): value is Extract<ToolResultPreviewContent, { kind: 'subagent' }> {
  return (
    hasExactShape(value, SUBAGENT_PREVIEW_SHAPE) &&
    isOptionalString(value.childSessionId) &&
    isOptionalString(value.agentId) &&
    typeof value.agentName === 'string' &&
    typeof value.turnId === 'string' &&
    isOptionalString(value.runId) &&
    PREVIEW_SUBAGENT_STATUSES.has(value.status as string) &&
    isPermissionMode(value.permissionMode)
  );
}

function isAgentSwarmPreview(
  value: Record<string, unknown>,
): value is Extract<ToolResultPreviewContent, { kind: 'agent_swarm' }> {
  return (
    hasExactShape(value, AGENT_SWARM_PREVIEW_SHAPE) &&
    PREVIEW_BATCH_STATUSES.has(value.status as string) &&
    Array.isArray(value.items) &&
    value.items.every(isAgentSwarmPreviewItem)
  );
}

function isAgentSwarmPreviewItem(value: unknown): value is AgentSwarmPreviewItem {
  return (
    isRecord(value) &&
    hasExactShape(value, AGENT_SWARM_PREVIEW_ITEM_SHAPE) &&
    typeof value.itemId === 'string' &&
    Number.isSafeInteger(value.index) &&
    Number(value.index) >= 0 &&
    typeof value.profile === 'string' &&
    typeof value.started === 'boolean' &&
    isOptionalString(value.childSessionId) &&
    isOptionalString(value.agentId) &&
    isOptionalString(value.agentName) &&
    isOptionalString(value.turnId) &&
    isOptionalString(value.runId) &&
    isOptionalString(value.resumedFromRunId) &&
    PREVIEW_ITEM_STATUSES.has(value.status as string)
  );
}
