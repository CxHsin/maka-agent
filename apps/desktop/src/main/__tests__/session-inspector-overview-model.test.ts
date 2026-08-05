import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  type SessionTrace,
  type TraceModelAttempt,
  type TraceModelCallStep,
} from '@maka/core/session-trace';
import { deriveInspectorOverviewModel } from '../../renderer/session-inspector-overview-model.js';

const NOW = Date.UTC(2026, 7, 4, 10, 50, 0);

function trace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [],
    totals: emptyTraceTotals(),
    coverage: {
      modelCalls: 'none',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
    },
    ...overrides,
  };
}

function attempt(overrides: Partial<TraceModelAttempt> = {}): TraceModelAttempt {
  return {
    attemptId: 'attempt-1',
    attempt: 0,
    status: 'completed',
    startedAt: NOW,
    completedAt: NOW + 1_000,
    latencyMs: 1_000,
    costBasis: 'unpriced',
    usageBasis: 'reported',
    ...overrides,
  };
}

function modelCall(overrides: Partial<TraceModelCallStep> = {}): TraceModelCallStep {
  return {
    kind: 'model_call',
    id: 'call-1',
    turnId: 'turn-1',
    runId: 'run-1',
    startedAt: NOW,
    endedAt: NOW + 1_000,
    durationMs: 1_000,
    callKind: 'main',
    providerId: 'zhipu',
    modelId: 'glm-5.1',
    step: 0,
    attempts: [attempt()],
    status: 'completed',
    ...overrides,
  };
}

function turn(steps: SessionTrace['turns'][number]['steps'], overrides: Partial<SessionTrace['turns'][number]> = {}): SessionTrace['turns'][number] {
  return {
    turnId: 'turn-1',
    runId: 'run-1',
    startedAt: NOW,
    endedAt: NOW + 2_000,
    durationMs: 2_000,
    steps,
    totals: emptyTraceTotals(),
    ...overrides,
  };
}

describe('inspector overview model', () => {
  it('is empty for an absent or turnless trace', () => {
    assert.deepEqual(deriveInspectorOverviewModel(undefined), {});
    assert.deepEqual(deriveInspectorOverviewModel(trace()), {});
  });

  it('reads the context budget from the most recent metered main call', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [
                attempt({ completedAt: NOW + 1_000, inputTokens: 40_000, contextWindow: 200_000 }),
              ],
            }),
            modelCall({
              id: 'call-2',
              step: 1,
              startedAt: NOW + 2_000,
              endedAt: NOW + 3_000,
              attempts: [
                attempt({
                  attemptId: 'attempt-2',
                  completedAt: NOW + 3_000,
                  inputTokens: 62_000,
                  cacheReadInputTokens: 55_000,
                  contextWindow: 200_000,
                }),
              ],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.context, { usedTokens: 62_000, windowTokens: 200_000, ratio: 0.31 });
  });

  it('ignores attempts without a window or usage when sizing the context', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [attempt({ completedAt: NOW + 1_000, inputTokens: 40_000, contextWindow: 200_000 })],
            }),
            modelCall({
              id: 'call-2',
              step: 1,
              startedAt: NOW + 2_000,
              endedAt: NOW + 3_000,
              // A later call the provider never metered must not blank the budget.
              attempts: [attempt({ attemptId: 'attempt-2', completedAt: NOW + 3_000, usageBasis: 'missing' })],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.context, { usedTokens: 40_000, windowTokens: 200_000, ratio: 0.2 });
  });

  it('reports no context budget when no call carried both numbers', () => {
    const model = deriveInspectorOverviewModel(
      trace({ turns: [turn([modelCall({ attempts: [attempt({ inputTokens: 12_000 })] })])] }),
    );

    assert.equal(model.context, undefined);
  });

  it('sums token stats across attempts and derives the cache hit rate', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [
                attempt({
                  inputTokens: 20_000,
                  cacheReadInputTokens: 15_000,
                  outputTokens: 500,
                  reasoningTokens: 120,
                }),
                attempt({
                  attemptId: 'attempt-2',
                  attempt: 1,
                  startedAt: NOW + 1_000,
                  completedAt: NOW + 2_000,
                  inputTokens: 10_000,
                  outputTokens: 300,
                }),
              ],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.sessionTokens, {
      meteredAttempts: 2,
      inputTokens: 30_000,
      cacheReadInputTokens: 15_000,
      outputTokens: 800,
      reasoningTokens: 120,
      cacheHitRate: 0.5,
    });
  });

  it('leaves the hit rate unknown rather than zero when no input was metered', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [turn([modelCall({ attempts: [attempt({ outputTokens: 400 })] })])],
      }),
    );

    assert.equal(model.sessionTokens?.cacheHitRate, undefined);
    assert.equal(model.sessionTokens?.inputTokens, undefined);
    assert.equal(model.sessionTokens?.outputTokens, 400);
  });

  it('keeps an unreported breakdown absent rather than summing it as zero', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [attempt({ inputTokens: 12_000, cacheReadInputTokens: 9_000, outputTokens: 300 })],
            }),
          ]),
        ],
      }),
    );

    // The provider never broke reasoning out: the row is unknown, not zero.
    assert.equal(model.sessionTokens?.reasoningTokens, undefined);
    assert.equal(model.sessionTokens?.cacheHitRate, 0.75);
  });

  it('scopes the latest-turn stats to the turn with the latest start', () => {
    const earlier = modelCall({
      attempts: [attempt({ inputTokens: 8_000, outputTokens: 100 })],
    });
    const later = modelCall({
      id: 'call-2',
      turnId: 'turn-2',
      attempts: [attempt({ inputTokens: 12_000, cacheReadInputTokens: 6_000, outputTokens: 200 })],
    });
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([earlier], { startedAt: NOW, endedAt: NOW + 2_000 }),
          turn([later], { turnId: 'turn-2', startedAt: NOW + 10_000, endedAt: NOW + 12_000 }),
        ],
      }),
    );

    assert.equal(model.latestTurnTokens?.inputTokens, 12_000);
    assert.equal(model.latestTurnTokens?.cacheHitRate, 0.5);
    assert.equal(model.sessionTokens?.inputTokens, 20_000);
  });

  it('names the model of the most recent call and counts logical calls', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({ attempts: [attempt({ contextWindow: 200_000 })] }),
            modelCall({
              id: 'call-2',
              providerId: 'openai',
              modelId: 'gpt-5.4',
              startedAt: NOW + 5_000,
              endedAt: NOW + 6_000,
              attempts: [attempt({ attemptId: 'attempt-2', startedAt: NOW + 5_000, completedAt: NOW + 6_000 })],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.model, {
      providerId: 'openai',
      modelId: 'gpt-5.4',
      callCount: 2,
    });
  });

  it('spans the session from the first turn start to the last turn end', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([], { startedAt: NOW + 10_000, endedAt: NOW + 11_000, turnId: 'turn-2' }),
          turn([], { startedAt: NOW, endedAt: NOW + 30_000 }),
        ],
      }),
    );

    assert.equal(model.startedAt, NOW);
    assert.equal(model.lastActivityAt, NOW + 30_000);
  });
});
