import { dotForStatus, type StatusSemantic } from '@maka/ui';

/**
 * Badge tones. Still its own vocabulary because Astryx's Badge has an `info`
 * pill and its own idea of `neutral`, so a Badge can express a shade the dot
 * cannot — mapping it through the status vocabulary would flatten that.
 *
 * Only 一处 still renders these (the subagent settings page). Everything else
 * on the settings surface is a dot plus plain text, per the "no decorative
 * Badge" principle.
 */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';

export function statusBadgeVariant(tone: StatusTone): 'success' | 'warning' | 'error' | 'info' | 'neutral' {
  switch (tone) {
    case 'success': return 'success';
    case 'warning': return 'warning';
    // Astryx Badge names the destructive status 'error' and the plain pill
    // 'neutral'.
    case 'destructive': return 'error';
    case 'info': return 'info';
    case 'neutral': return 'neutral';
  }
}

/**
 * Legacy tone → dot, on its way out.
 *
 * It used to take a `StatusTone` and map `info` onto the accent dot, because
 * Astryx's StatusDot has no `info` rung. That workaround was load-bearing in
 * the wrong direction: nine states across this surface said `info`, and only
 * ONE of them was actually in progress. The other eight — a disabled feature,
 * a configured approval policy, an expired credential waiting on the user —
 * all rendered as the same live accent dot, which is why settings read busier
 * than it was. Each of those nine now names what it means and the colour
 * follows.
 */
export function statusDotVariant(tone: StatusTone) {
  switch (tone) {
    case 'success': return dotForStatus('success');
    case 'warning': return dotForStatus('attention');
    case 'destructive': return dotForStatus('error');
    // The workaround this whole pass exists to remove, kept alive only while
    // surfaces still emit `info`. Every migrated surface names what it means
    // and calls `dotForStatus` directly; this branch shrinks to nothing as the
    // last few move over, and then so does this function.
    case 'info': return dotForStatus('active');
    case 'neutral': return dotForStatus('neutral');
  }
}
