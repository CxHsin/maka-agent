import type { StatusDotVariant } from '@astryxdesign/core/StatusDot';

/**
 * What a state MEANS, named once for the whole app.
 *
 * Seven places used to map their own domain states straight onto StatusDot
 * variants, which made the app's status colours a matter of seven independent
 * opinions: the same "success" was `accent` on the MCP page and `success` in
 * session history, and the same "error" was called `destructive` in one file
 * and `error` in five others.
 *
 * The fix is a layer, not a merge. Domain knowledge — that a blocked plan run
 * is a warning, that a shadowed skill needs attention — stays with the surface
 * that owns it, because only that surface knows it. What those surfaces now
 * share is the vocabulary they express it in, and the single decision below
 * about what each word looks like.
 *
 * There is deliberately no `info`. Two callers had one and meant opposite
 * things by it: the MCP page meant "informational, do not draw the eye" and
 * session history meant "something is happening here". One vague word standing
 * for both is what let them drift apart unnoticed — they now pick `neutral` and
 * `active` respectively, and the disagreement is visible in the call site
 * rather than hidden in a shared name.
 */
export type StatusSemantic =
  /** Healthy, connected, finished well. */
  | 'success'
  /** Live right now — running, scheduled, in flight. */
  | 'active'
  /** Needs a human eventually: paused, shadowed, degraded, review pending. */
  | 'attention'
  /** Broken now: failed delivery, invalid metadata, unreachable server. */
  | 'error'
  /** Present but not participating: disabled, completed-and-spent, off. */
  | 'neutral';

/**
 * The one place a status word becomes a colour.
 *
 * `active` is `accent` because accent has always meant "live" here (a
 * scheduled reminder waiting to fire wears it); it is not a second green.
 * `attention` is `warning` rather than `error` because the state is "look at
 * this when you can", not "this is broken".
 */
const SEMANTIC_TO_DOT: Record<StatusSemantic, StatusDotVariant> = {
  success: 'success',
  active: 'accent',
  attention: 'warning',
  error: 'error',
  neutral: 'neutral',
};

/**
 * Named `dotForStatus` rather than `statusDotVariant` only to avoid colliding
 * with the settings surface's own `statusDotVariant`
 * (`settings-status-badge.ts`), which nine files still import.
 *
 * That file is the eighth mapper and the largest — it predates this one and
 * carries the settings surface's whole status language. The end state is that
 * it becomes another adapter onto this vocabulary rather than a parallel
 * system, at which point these two names collapse into one. It is not migrated
 * here because its `info` states need a per-surface semantic decision (nine of
 * them: does this mean "do not draw the eye" or "something is live?"), which is
 * a design call and deserves its own pass rather than being guessed mid-refactor.
 *
 * Until then: new code uses this vocabulary; the settings surface keeps its
 * own; neither grows a second opinion about what a state colour means.
 */
export function dotForStatus(semantic: StatusSemantic): StatusDotVariant {
  return SEMANTIC_TO_DOT[semantic];
}
