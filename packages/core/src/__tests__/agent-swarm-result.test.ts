import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildAgentSwarmContent, projectAgentSwarmResult } from '../agent-swarm.js';
import type { ToolResultContent } from '../events.js';
import {
  decodeCanonicalToolResultContent,
  decodeToolResultPreviewContent,
} from '../tool-result-record-schema.js';
import { isCancelledToolResultContent, toolResultActivityStatus } from '../tool-result-status.js';

describe('agent swarm result contract', () => {
  test('decodes the exact structured result with stable child refs', () => {
    const result = agentSwarmResult();

    assert.deepEqual(decodeCanonicalToolResultContent(result), result);
  });

  test('rejects malformed or widened result rows', () => {
    assert.throws(
      () =>
        decodeCanonicalToolResultContent({
          ...agentSwarmResult(),
          items: [
            {
              ...agentSwarmResult().items[0],
              unexpected: true,
            },
          ],
        }),
      /Invalid tool result content/,
    );
    assert.throws(
      () =>
        decodeCanonicalToolResultContent({
          ...agentSwarmResult(),
          status: 'unknown',
        }),
      /Invalid tool result content/,
    );
  });

  test('keeps partial batches settled and classifies failed and cancelled batches', () => {
    const partial = { ...agentSwarmResult(), status: 'partial' as const };
    const failed = decodeCanonicalToolResultContent({
      ...agentSwarmResult(),
      status: 'failed',
      items: [{ ...agentSwarmResult().items[0], status: 'failed' }],
    });
    const cancelled = { ...agentSwarmResult(), status: 'cancelled' as const };

    assert.equal(toolResultActivityStatus(false, partial), 'completed');
    assert.equal(toolResultActivityStatus(true, failed), 'errored');
    assert.equal(isCancelledToolResultContent(cancelled), true);
    assert.equal(toolResultActivityStatus(true, cancelled), 'interrupted');
  });

  test('projects bounded aggregate facts without duplicating child output', () => {
    const result = agentSwarmResult();
    result.items = [
      result.items[0]!,
      {
        itemId: 'storage',
        index: 1,
        profile: 'local_read',
        started: true,
        turnId: 'turn-storage',
        runId: 'run-storage',
        status: 'failed',
        summary: 'Storage inspection failed.',
        artifactIds: ['artifact-storage-1', 'artifact-storage-2'],
        durationMs: 20,
        failureClass: 'ChildFailed',
      },
      {
        itemId: 'tests',
        index: 2,
        profile: 'local_read',
        started: false,
        status: 'cancelled',
        summary: 'Cancelled before start.',
        artifactIds: [],
      },
    ];
    result.status = 'cancelled';
    result.durationMs = 30;

    assert.deepEqual(projectAgentSwarmResult(result), {
      status: 'cancelled',
      itemCount: 3,
      startedItemCount: 2,
      completedItemCount: 1,
      failedItemCount: 1,
      cancelledItemCount: 1,
      runningItemCount: 0,
      queuedItemCount: 0,
      artifactCount: 3,
      durationMs: 30,
    });
  });

  test('buildAgentSwarmContent keeps the batch running while any item is live', () => {
    const content = buildAgentSwarmContent({
      startedAt: 10,
      completedAt: 25,
      items: [
        {
          itemId: 'auth',
          index: 0,
          profile: 'local_read',
          started: true,
          childSessionId: 'child-auth',
          status: 'running',
          summary: '',
          artifactIds: [],
        },
        {
          itemId: 'storage',
          index: 1,
          profile: 'local_read',
          started: false,
          status: 'queued',
          summary: '',
          artifactIds: [],
        },
      ],
    });

    assert.equal(content.kind, 'agent_swarm');
    assert.equal(content.status, 'running');
    assert.equal(content.durationMs, 15);
    assert.deepEqual(projectAgentSwarmResult(content), {
      status: 'running',
      itemCount: 2,
      startedItemCount: 1,
      completedItemCount: 0,
      failedItemCount: 0,
      cancelledItemCount: 0,
      runningItemCount: 1,
      queuedItemCount: 1,
      artifactCount: 0,
      durationMs: 15,
    });
    // Live mid-flight snapshots are preview-only; durable decoder rejects them.
    assert.throws(() => decodeCanonicalToolResultContent(content), /Invalid tool result content/);
    assert.deepEqual(decodeToolResultPreviewContent(content), content);
  });

  test('durable decoder rejects live-only agent_swarm statuses', () => {
    assert.throws(
      () =>
        decodeCanonicalToolResultContent({
          ...agentSwarmResult(),
          status: 'running',
          items: [{ ...agentSwarmResult().items[0]!, status: 'running', summary: '' }],
        }),
      /Invalid tool result content/,
    );
    assert.throws(
      () =>
        decodeCanonicalToolResultContent({
          ...agentSwarmResult(),
          items: [{ ...agentSwarmResult().items[0]!, status: 'queued', summary: '' }],
        }),
      /Invalid tool result content/,
    );
  });
});

function agentSwarmResult(): Extract<ToolResultContent, { kind: 'agent_swarm' }> {
  return {
    kind: 'agent_swarm',
    status: 'completed',
    items: [
      {
        itemId: 'auth',
        index: 0,
        profile: 'local_read',
        started: true,
        childSessionId: 'child-session-auth',
        agentId: 'local-read',
        agentName: 'Local Read',
        turnId: 'turn-auth',
        runId: 'run-auth',
        resumedFromRunId: 'run-auth-source',
        status: 'completed',
        summary: 'Auth boundaries are documented.',
        artifactIds: ['artifact-auth'],
        startedAt: 10,
        completedAt: 20,
        durationMs: 10,
      },
    ],
    startedAt: 10,
    completedAt: 20,
    durationMs: 10,
  };
}
