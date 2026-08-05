import type {
  SessionTrace,
  TraceModelAttempt,
  TraceModelCallStep,
  TurnTrace,
} from '@maka/core/session-trace';

/**
 * Overview view model for the Inspector panel's summary sections.
 *
 * Pure, for the same reason `deriveInspectorPanelModel` is: every judgement
 * about what a number means is testable without a DOM, and the panel only lays
 * the result out. Nothing is derived that the trace does not carry — a session
 * whose backend reports no usage shows its structure and says so, rather than
 * fabricating zeros (#1625, #1679).
 */

/** Metered token totals over a set of attempts. */
export interface InspectorTokenStats {
  /** Physical requests that reported any usage at all. */
  meteredAttempts: number;
  /** Prompt tokens, cache hits included — what the provider counted as input. */
  inputTokens: number;
  /** The portion of input served from the provider's prompt cache. */
  cacheReadInputTokens: number;
  outputTokens: number;
  /** Reasoning portion of output, when the provider breaks it out. */
  reasoningTokens: number;
  /**
   * cacheRead / input over attempts that reported input. Absent when no input
   * was metered at all — a rate over nothing is not zero, it is unknown.
   */
  cacheHitRate?: number;
}

/** The prompt size of the most recent metered call, against its own ceiling. */
export interface InspectorContextBudget {
  usedTokens: number;
  /** The window the call was metered against, frozen at call time. */
  windowTokens: number;
  /** usedTokens / windowTokens; the panel clamps for display, not here. */
  ratio: number;
}

/** The model behind the most recent model call. */
export interface InspectorModelRef {
  providerId: string;
  modelId: string;
  /** Latest window any attempt of this model was metered against. */
  contextWindow?: number;
  /** Logical calls (retries nest inside), session-wide. */
  callCount: number;
}

export interface InspectorOverviewModel {
  /** Absent when no completed main call reported both usage and a window. */
  context?: InspectorContextBudget;
  /** Absent when no attempt in the session reported usage. */
  sessionTokens?: InspectorTokenStats;
  /** The latest turn's slice of the same metering, when it reported any. */
  latestTurnTokens?: InspectorTokenStats;
  /** Absent when the session made no recorded model call. */
  model?: InspectorModelRef;
  /** First turn's start, last turn's end — the session's active span. */
  startedAt?: number;
  lastActivityAt?: number;
}

export function deriveInspectorOverviewModel(trace: SessionTrace | undefined): InspectorOverviewModel {
  if (!trace || trace.turns.length === 0) return {};

  const latestTurn = trace.turns.reduce((latest, turn) =>
    turn.startedAt >= latest.startedAt ? turn : latest,
  );

  const modelSteps = trace.turns.flatMap(modelCallSteps);
  const sessionTokens = tokenStats(modelSteps.flatMap((step) => step.attempts));
  const turnTokens = tokenStats(modelCallSteps(latestTurn).flatMap((step) => step.attempts));

  const latestStep = modelSteps.reduce<TraceModelCallStep | undefined>(
    (latest, step) => (latest === undefined || step.endedAt >= latest.endedAt ? step : latest),
    undefined,
  );

  const context = contextBudget(modelSteps);

  return {
    ...(context ? { context } : {}),
    ...(sessionTokens ? { sessionTokens } : {}),
    ...(turnTokens ? { latestTurnTokens: turnTokens } : {}),
    ...(latestStep
      ? {
          model: {
            providerId: latestStep.providerId,
            modelId: latestStep.modelId,
            ...(latestContextWindow(latestStep) !== undefined
              ? { contextWindow: latestContextWindow(latestStep) }
              : {}),
            callCount: modelSteps.length,
          },
        }
      : {}),
    startedAt: trace.turns.reduce((earliest, turn) => Math.min(earliest, turn.startedAt), Number.POSITIVE_INFINITY),
    lastActivityAt: trace.turns.reduce((latest, turn) => Math.max(latest, turn.endedAt), 0),
  };
}

function modelCallSteps(turn: TurnTrace): TraceModelCallStep[] {
  return turn.steps.filter((step): step is TraceModelCallStep => step.kind === 'model_call');
}

function tokenStats(attempts: readonly TraceModelAttempt[]): InspectorTokenStats | undefined {
  const metered = attempts.filter((attempt) => attempt.inputTokens !== undefined);
  const outputMetered = attempts.filter((attempt) => attempt.outputTokens !== undefined);
  if (metered.length === 0 && outputMetered.length === 0) return undefined;

  const inputTokens = sum(metered, (attempt) => attempt.inputTokens);
  const cacheReadInputTokens = sum(metered, (attempt) => attempt.cacheReadInputTokens);
  const outputTokens = sum(attempts, (attempt) => attempt.outputTokens);
  const reasoningTokens = sum(attempts, (attempt) => attempt.reasoningTokens);

  return {
    meteredAttempts: new Set([...metered, ...outputMetered]).size,
    inputTokens,
    cacheReadInputTokens,
    outputTokens,
    reasoningTokens,
    ...(inputTokens > 0 ? { cacheHitRate: cacheReadInputTokens / inputTokens } : {}),
  };
}

/**
 * The budget question a reader actually asks — "how full is the context right
 * now" — is answered by the most recent completed call whose provider counted
 * a prompt: its input total IS the context size the next call builds on.
 */
function contextBudget(steps: readonly TraceModelCallStep[]): InspectorContextBudget | undefined {
  const candidates = steps
    .filter((step) => step.callKind === 'main')
    .flatMap((step) => step.attempts)
    .filter(
      (attempt) =>
        attempt.status === 'completed' &&
        attempt.inputTokens !== undefined &&
        attempt.contextWindow !== undefined &&
        attempt.contextWindow > 0,
    );
  const latest = candidates.reduce<TraceModelAttempt | undefined>(
    (carry, attempt) => (carry === undefined || attempt.completedAt >= carry.completedAt ? attempt : carry),
    undefined,
  );
  if (!latest) return undefined;
  return {
    usedTokens: latest.inputTokens!,
    windowTokens: latest.contextWindow!,
    ratio: latest.inputTokens! / latest.contextWindow!,
  };
}

function latestContextWindow(step: TraceModelCallStep): number | undefined {
  return step.attempts.reduce<number | undefined>(
    (carry, attempt) => attempt.contextWindow ?? carry,
    undefined,
  );
}

function sum(attempts: readonly TraceModelAttempt[], pick: (attempt: TraceModelAttempt) => number | undefined): number {
  return attempts.reduce((carry, attempt) => carry + (pick(attempt) ?? 0), 0);
}
