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
  inputTokens?: number;
  /** The portion of input served from the provider's prompt cache. */
  cacheReadInputTokens?: number;
  outputTokens?: number;
  /** Reasoning portion of output, when the provider breaks it out. */
  reasoningTokens?: number;
  /**
   * cacheRead / input over attempts that reported input. Absent when no input
   * was metered at all — a rate over nothing is not zero, it is unknown.
   */
  cacheHitRate?: number;
}

/**
 * One band of the context window.
 *
 * `cacheRead` + `fresh` split the prompt by what the provider served from its
 * cache; `used` is the same prompt left whole because the provider reported no
 * cache figure — an unsplit bar, not a bar that claims a zero cache hit.
 * `free` is the headroom left in the window.
 */
export type InspectorContextSegmentKind = 'cacheRead' | 'fresh' | 'used' | 'free';

export interface InspectorContextSegment {
  kind: InspectorContextSegmentKind;
  tokens: number;
  /** tokens / windowTokens. */
  ratio: number;
}

/** The prompt size of the most recent metered call, against its own ceiling. */
export interface InspectorContextBudget {
  usedTokens: number;
  /** The window the call was metered against, frozen at call time. */
  windowTokens: number;
  /** usedTokens / windowTokens; the panel clamps for display, not here. */
  ratio: number;
  /**
   * The window broken into bands, in reading order and with empty bands
   * dropped, so the bar and its legend cannot disagree about what is drawn.
   */
  segments: readonly InspectorContextSegment[];
}

/** The model behind the most recent model call. */
export interface InspectorModelRef {
  providerId: string;
  modelId: string;
  /** Logical calls (retries nest inside), session-wide. */
  callCount: number;
}

export interface InspectorOverviewModel {
  /** Absent when no completed main call reported both usage and a window. */
  context?: InspectorContextBudget;
  /** Absent when no attempt in the session reported usage. */
  sessionTokens?: InspectorTokenStats;
  /** Absent when the session made no recorded model call. */
  model?: InspectorModelRef;
  /** Last turn's end — when the session was last active. */
  lastActivityAt?: number;
}

export function deriveInspectorOverviewModel(trace: SessionTrace | undefined): InspectorOverviewModel {
  if (!trace || trace.turns.length === 0) return {};

  const modelSteps = trace.turns.flatMap(modelCallSteps);
  const sessionTokens = tokenStats(modelSteps.flatMap((step) => step.attempts));

  const latestStep = modelSteps.reduce<TraceModelCallStep | undefined>(
    (latest, step) => (latest === undefined || step.endedAt >= latest.endedAt ? step : latest),
    undefined,
  );

  const context = contextBudget(modelSteps);

  return {
    ...(context ? { context } : {}),
    ...(sessionTokens ? { sessionTokens } : {}),
    ...(latestStep
      ? {
          model: {
            providerId: latestStep.providerId,
            modelId: latestStep.modelId,
            callCount: modelSteps.length,
          },
        }
      : {}),
    lastActivityAt: trace.turns.reduce((latest, turn) => Math.max(latest, turn.endedAt), 0),
  };
}

function modelCallSteps(turn: TurnTrace): TraceModelCallStep[] {
  return turn.steps.filter((step): step is TraceModelCallStep => step.kind === 'model_call');
}

/**
 * Every field sums only the attempts that reported it: a provider that never
 * breaks out reasoning leaves the row unknown, not zero, because "did not
 * report" and "reported none" are different facts (#1679 keeps them apart in
 * the ledger, and the panel keeps them apart here).
 */
function tokenStats(attempts: readonly TraceModelAttempt[]): InspectorTokenStats | undefined {
  const input = attempts.filter((attempt) => attempt.inputTokens !== undefined);
  const cacheRead = attempts.filter((attempt) => attempt.cacheReadInputTokens !== undefined);
  const output = attempts.filter((attempt) => attempt.outputTokens !== undefined);
  const reasoning = attempts.filter((attempt) => attempt.reasoningTokens !== undefined);
  const metered = new Set([...input, ...cacheRead, ...output, ...reasoning]);
  if (metered.size === 0) return undefined;

  const inputTokens = sum(input, (attempt) => attempt.inputTokens);
  return {
    meteredAttempts: metered.size,
    ...(input.length > 0 ? { inputTokens } : {}),
    ...(cacheRead.length > 0
      ? { cacheReadInputTokens: sum(cacheRead, (attempt) => attempt.cacheReadInputTokens) }
      : {}),
    ...(output.length > 0 ? { outputTokens: sum(output, (attempt) => attempt.outputTokens) } : {}),
    ...(reasoning.length > 0
      ? { reasoningTokens: sum(reasoning, (attempt) => attempt.reasoningTokens) }
      : {}),
    // An input-reported attempt without a cache figure reads as a miss: the
    // providers that cache always count the hits.
    ...(input.length > 0 && inputTokens > 0
      ? {
          cacheHitRate:
            sum(input, (attempt) => attempt.cacheReadInputTokens) / inputTokens,
        }
      : {}),
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
  const usedTokens = latest.inputTokens!;
  const windowTokens = latest.contextWindow!;
  // A cache figure larger than the prompt it belongs to is not a fact about
  // the window, so it is clamped rather than allowed to push `fresh` negative.
  const cacheRead =
    latest.cacheReadInputTokens !== undefined
      ? Math.min(latest.cacheReadInputTokens, usedTokens)
      : undefined;
  const prompt: { kind: InspectorContextSegmentKind; tokens: number }[] =
    cacheRead === undefined
      ? [{ kind: 'used', tokens: usedTokens }]
      : [
          { kind: 'cacheRead', tokens: cacheRead },
          { kind: 'fresh', tokens: usedTokens - cacheRead },
        ];
  return {
    usedTokens,
    windowTokens,
    ratio: usedTokens / windowTokens,
    segments: [
      ...prompt,
      { kind: 'free' as const, tokens: Math.max(0, windowTokens - usedTokens) },
    ]
      .filter((segment) => segment.tokens > 0)
      .map((segment) => ({ ...segment, ratio: segment.tokens / windowTokens })),
  };
}

function sum(attempts: readonly TraceModelAttempt[], pick: (attempt: TraceModelAttempt) => number | undefined): number {
  return attempts.reduce((carry, attempt) => carry + (pick(attempt) ?? 0), 0);
}
