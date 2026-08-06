/**
 * Small pure helpers backing the chat surface (TurnView,
 * RelativeTime, StreamingAssistantBubble, etc.) —
 * time formatters, turn duration + abort marker copy.
 *
 * PR-UI-LIB-EXTRACT-4 (round 5/10) introduced this module with a
 * deliberate ESM circular import on `./components.js` for
 * locale resolution. PR-UI-LIB-EXTRACT-5 (round 6/10) broke the
 * cycle by lifting locale helpers into a new `locale-helpers`
 * leaf module; this file now depends on that leaf instead.
 *
 * Why this seam: duration formatting has ms→s→m bucket rules, and
 * the abort-marker label is i18n-able copy. Each rule was
 * previously buried between TurnView's 200-line JSX block and
 * StreamingAssistantBubble's rendering lifecycle; the bundle now
 * sits as short pure functions easy to unit-test in isolation.
 *
 * PR-CHAT-CHROME-FOLLOWUP-0: `messageRoleLabel` / `avatarInitial`
 * were removed — the chat surface dropped per-message avatars and
 * name labels (MessageMeta), leaving both helpers with zero call
 * sites.
 */

import { uiLocaleToIntlLocale, type UiLocale } from '@maka/core';
import { getConversationCopy } from './conversation-copy.js';
import { formatDuration } from './tool-activity/preview-utils.js';

function createAbsoluteTimeFormat(locale: UiLocale): Intl.DateTimeFormat {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
    return { format: (d: Date) => d.toISOString() } as unknown as Intl.DateTimeFormat;
  }
  return new Intl.DateTimeFormat(
    uiLocaleToIntlLocale(locale),
    { dateStyle: 'medium', timeStyle: 'short' },
  );
}

export function formatAbsoluteTimestamp(ts: number, locale: UiLocale): string {
  return createAbsoluteTimeFormat(locale).format(new Date(ts));
}

/* `formatClockTime` (a 24-hour `HH:mm` for the user-message time) lived here
   until the meta row moved to Astryx's `Timestamp`. Locking the hour cycle was
   the app overriding a preference that belongs to the reader's system, which is
   why `Timestamp` formats against the host locale and offers no hour-cycle
   knob. Absolute readings now come from that component, not from a local bag of
   `Intl` options. */

/**
 * A turn's duration, in the same shape tool cards use.
 *
 * The rule this enforces has always been written down here ("same shape as
 * tool-activity's formatDuration —「1 m 0 s」vs「8.2s」read as two different
 * products"), but it used to be enforced by a hand-kept copy of that function.
 * The turn status line puts the two side by side — a running turn's clock sits
 * directly under the tool cards it is waiting on — so the shape is now shared
 * rather than mirrored. `formatDuration` returns null only for a negative or
 * absent input, neither of which a duration can be.
 */
export function formatTurnDuration(ms: number): string {
  return formatDuration(Math.max(0, ms)) ?? '0 ms';
}

export function turnAbortMarkerLabel(abortSource: string | undefined, locale: UiLocale): string {
  const copy = getConversationCopy(locale).messages;
  switch (abortSource) {
    case 'renderer.stop_button': return copy.abortedByStop;
    default: return copy.aborted;
  }
}
