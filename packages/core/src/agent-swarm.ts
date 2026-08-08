import type { ToolResultContent } from './events.js';

export type AgentSwarmResult = Extract<ToolResultContent, { kind: 'agent_swarm' }>;
export type AgentSwarmItem = AgentSwarmResult['items'][number];
export type AgentSwarmBatchStatus = AgentSwarmResult['status'];
export type AgentSwarmItemStatus = AgentSwarmItem['status'];

export interface AgentSwarmResultProjection {
  status: AgentSwarmBatchStatus;
  itemCount: number;
  startedItemCount: number;
  completedItemCount: number;
  failedItemCount: number;
  cancelledItemCount: number;
  runningItemCount: number;
  queuedItemCount: number;
  artifactCount: number;
  durationMs: number;
}

const TERMINAL_ITEM_STATUSES = new Set<AgentSwarmItemStatus>(['completed', 'failed', 'cancelled']);

/**
 * Batch status from item rows. Any live item keeps the batch `running`; once
 * every item is terminal the rollup matches the settled agent_swarm contract.
 */
export function aggregateAgentSwarmStatus(items: readonly AgentSwarmItem[]): AgentSwarmBatchStatus {
  if (items.some((item) => !TERMINAL_ITEM_STATUSES.has(item.status))) return 'running';
  if (items.length > 0 && items.every((item) => item.status === 'failed')) return 'failed';
  if (items.some((item) => item.status === 'cancelled')) return 'cancelled';
  if (items.length > 0 && items.every((item) => item.status === 'completed')) return 'completed';
  return 'partial';
}

/**
 * Durable agent_swarm tool_result builder. Live mid-flight Open uses
 * buildAgentSwarmPreviewContent (open-facts only) instead.
 */
export function buildAgentSwarmContent(input: {
  readonly items: readonly AgentSwarmItem[];
  readonly startedAt: number;
  readonly completedAt: number;
}): AgentSwarmResult {
  const startedAt = input.startedAt;
  const completedAt = input.completedAt;
  const items = input.items.map((item) => ({
    ...item,
    artifactIds: [...item.artifactIds],
  }));
  return {
    kind: 'agent_swarm',
    status: aggregateAgentSwarmStatus(items),
    items,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt),
  };
}

/**
 * Bounded presentation/diagnostic facts derived from agent_swarm content.
 * Child AgentRuns remain the authority for child lifecycle and artifacts.
 */
export function projectAgentSwarmResult(result: AgentSwarmResult): AgentSwarmResultProjection {
  let startedItemCount = 0;
  let completedItemCount = 0;
  let failedItemCount = 0;
  let cancelledItemCount = 0;
  let runningItemCount = 0;
  let queuedItemCount = 0;
  let artifactCount = 0;

  for (const item of result.items) {
    if (item.started) startedItemCount += 1;
    if (item.status === 'completed') completedItemCount += 1;
    else if (item.status === 'failed') failedItemCount += 1;
    else if (item.status === 'cancelled') cancelledItemCount += 1;
    else if (item.status === 'running') runningItemCount += 1;
    else if (item.status === 'queued') queuedItemCount += 1;
    artifactCount += item.artifactIds.length;
  }

  return {
    status: result.status,
    itemCount: result.items.length,
    startedItemCount,
    completedItemCount,
    failedItemCount,
    cancelledItemCount,
    runningItemCount,
    queuedItemCount,
    artifactCount,
    durationMs: result.durationMs,
  };
}
