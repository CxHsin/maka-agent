import { type ReactNode, useMemo } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Text } from '@astryxdesign/core/Text';
import { PROVIDER_REGISTRY, uiLocaleToIntlLocale, type UiLocale } from '@maka/core';
import { useUiLocale } from '@maka/ui';
import { Activity, AlertTriangle } from '@maka/ui/icons';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { deriveInspectorOverviewModel } from './session-inspector-overview-model.js';
import {
  deriveInspectorPanelModel,
  type InspectorStepRow,
  type InspectorTurnRow,
} from './session-inspector-panel-model.js';
import { useSessionTrace } from './use-session-trace.js';

type InspectorCopy = ReturnType<typeof getDesktopConversationCopy>['inspector'];

/**
 * Per-session trace (#1625), read top to bottom rather than through a
 * switcher: the overview answers where the session stands — how full the
 * context is, what the tokens and cache did, what it cost — and the timeline
 * under it answers what happened, turn by turn. They are the same question at
 * two zoom levels, so a reader wants one after the other, not one instead of
 * the other; a session with no metered overview simply starts at the timeline.
 *
 * Read-only. Every judgement it makes lives in `deriveInspectorOverviewModel`
 * and `deriveInspectorPanelModel`; this file lays the result out — in the
 * same components the rest of the workbar uses, so a read that failed looks
 * like every other failed read (Banner), and a session that did nothing looks
 * like every other empty surface (EmptyState) rather than like a stray
 * paragraph.
 */
export function SessionInspectorPanel(props: { sessionId: string; active: boolean }) {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).inspector;
  const snapshot = useSessionTrace(props.sessionId, props.active, {
    loadFailed: copy.loadFailed,
    locale,
  });
  const model = useMemo(() => deriveInspectorPanelModel(snapshot.trace), [snapshot.trace]);
  const overview = useMemo(() => deriveInspectorOverviewModel(snapshot.trace), [snapshot.trace]);
  const hasOverview =
    overview.context !== undefined ||
    overview.sessionTokens !== undefined ||
    overview.model !== undefined;

  return (
    <Section
      variant="transparent"
      padding={4}
      className="maka-inspector-panel"
      data-maka-contract="session-inspector"
      aria-label={copy.ariaLabel}
      aria-busy={snapshot.loading || undefined}
    >
      <VStack gap={4} height="100%">
        {snapshot.error && (
          <Banner
            status="error"
            title={snapshot.error}
            endContent={
              <Button variant="ghost" size="sm" label={copy.retry} onClick={snapshot.retry} />
            }
          />
        )}

        {/* Two silences, kept apart: a read that failed (the Banner above) and
            a session that did nothing. A live region rather than a bare block
            because the trace arrives after the tab does. */}
        <div
          role="status"
          aria-live="polite"
          className="maka-inspector-status"
          /* With nothing to trace the region IS the panel, so it takes the
             leftover height and centres its empty state the way every other
             workbar tab does. */
          data-empty={model.empty || undefined}
        >
          {model.empty && !snapshot.loading && !snapshot.error && (
            <EmptyState
              isCompact
              title={copy.empty}
              icon={<Activity size={20} aria-hidden="true" />}
            />
          )}
        </div>

        {!model.empty && hasOverview && (
          <InspectorOverview copy={copy} locale={locale} model={model} overview={overview} />
        )}

        {!model.empty && (
          <div className="maka-inspector-raw" data-maka-contract="session-inspector-raw">
            <VStack gap={2} className="maka-inspector-raw-body">
              <div className="maka-inspector-section-head">
                <Heading level={3} className="maka-inspector-section-title">
                  {copy.overview.timelineTab}
                </Heading>
              </div>

              {model.coverage && (
                <p
                  className="maka-inspector-coverage-note"
                  data-maka-contract="session-inspector-coverage"
                >
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    {model.coverage.kind === 'absent'
                      ? copy.coverageAbsent
                      : copy.coveragePartial}
                    {[
                      model.coverage.turnsMissing > 0 &&
                        `${model.coverage.turnsMissing} ${copy.turnsMissing}`,
                      model.coverage.turnsShort > 0 &&
                        `${model.coverage.turnsShort} ${copy.turnsShort}`,
                      model.coverage.unreadableRecords > 0 &&
                        `${model.coverage.unreadableRecords} ${copy.unreadable}`,
                    ]
                      .filter(Boolean)
                      .map((part) => ` · ${part}`)
                      .join('')}
                  </span>
                </p>
              )}

              <ol className="maka-inspector-turns">
                {model.turns.map((turn) => (
                  <TurnRow
                    key={turn.turnId}
                    turn={turn}
                    turnLabel={copy.turnLabel}
                    costUnavailable={copy.costUnavailable}
                    failedLabel={copy.turnFailed}
                    recoveredLabel={copy.recovered}
                  />
                ))}
              </ol>
            </VStack>
          </div>
        )}
      </VStack>
    </Section>
  );
}

/**
 * The glance layer.
 *
 * What survived a pass over "who reads this number, and to decide what":
 *
 * - Cost, duration and cache hit rate lead as headline stats. They are the
 *   three a reader opens the tab for, and as figures rather than table rows
 *   they also give the column something to fill.
 * - The context bar stays, because it is the only thing here that answers a
 *   question about NOW rather than about the past.
 * - Input and output collapse into one ratio. Two rows of raw counts were two
 *   rows nobody compared; as `81,300 / 740` the shape of the session is
 *   legible at a glance, and the cache figure that used to sit beside them is
 *   already stated as a rate above and as a band in the bar.
 * - Retries and compactions report BY EXCEPTION. A session with neither is
 *   the normal case, and printing `0` twice taught the reader to skip the
 *   block that also carries the exceptions.
 * - Model call count and last-activity are gone. The count was a number with
 *   no decision attached, and the timestamp is already on the session in the
 *   sidebar and the header.
 */
function InspectorOverview(props: {
  copy: InspectorCopy;
  locale: UiLocale;
  model: ReturnType<typeof deriveInspectorPanelModel>;
  overview: ReturnType<typeof deriveInspectorOverviewModel>;
}) {
  const { copy, overview } = props;
  const formatNumber = numberFormatter(props.locale);
  const context = overview.context;
  const tokens = overview.sessionTokens;
  const totals = props.model.totals;

  return (
    <VStack gap={4} data-maka-contract="session-inspector-overview">
      <dl className="maka-inspector-stats" data-maka-contract="session-inspector-stats">
        <StatCell label={copy.totals.cost} value={formatCost(totals.costUsd, copy.costUnavailable)} />
        <StatCell label={copy.totals.duration} value={formatDuration(totals.durationMs)} />
        {tokens?.cacheHitRate !== undefined && (
          <StatCell label={copy.overview.cacheHit} value={formatPercent(tokens.cacheHitRate)} />
        )}
      </dl>

      {context && (
        <InspectorContextSection copy={copy} context={context} formatNumber={formatNumber} />
      )}

      {/* What is left after the stats and the bar have said their part: a
          handful of facts nobody compares with each other. A table gave each
          one a row and a column it did not need and left the right half of the
          panel empty; as one wrapped line they take the width they actually
          occupy. Retries and compactions appear only when they happened — a
          `0` here would be a fact about nothing. */}
      <p className="maka-inspector-meta">
        {[
          overview.model &&
            `${providerLabel(overview.model.providerId)} / ${overview.model.modelId}`,
          tokens?.inputTokens !== undefined &&
            tokens.outputTokens !== undefined &&
            `${copy.overview.inputOutput} ${formatNumber(tokens.inputTokens)} / ${formatNumber(tokens.outputTokens)}`,
          tokens?.reasoningTokens !== undefined &&
            `${copy.overview.reasoning} ${formatNumber(tokens.reasoningTokens)}`,
          totals.retries > 0 && `${copy.totals.retries} ${formatNumber(totals.retries)}`,
          totals.compactions > 0 &&
            `${copy.totals.compactions} ${formatNumber(totals.compactions)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </VStack>
  );
}

/**
 * One headline figure. A label small enough to stay out of the way over a
 * number big enough to be the thing the eye lands on — the inverse of a table
 * row, and the reason these three do not need a section heading to rank them.
 */
function StatCell(props: { label: string; value: ReactNode }) {
  return (
    <div className="maka-inspector-stat">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/** A titled block of the overview; the title is the only heading in it. */
function InspectorSection(props: {
  title: string;
  readout?: ReactNode;
  level?: 'warning' | 'error';
  children: ReactNode;
  'data-maka-contract'?: string;
}) {
  return (
    <VStack
      gap={2}
      className="maka-inspector-section"
      data-maka-contract={props['data-maka-contract']}
    >
      <div className="maka-inspector-section-head" data-level={props.level}>
        <Heading level={3} className="maka-inspector-section-title">
          {props.title}
        </Heading>
        {props.readout !== undefined && (
          <span className="maka-inspector-section-readout">{props.readout}</span>
        )}
      </div>
      {props.children}
    </VStack>
  );
}

/**
 * One legend row: band, figure, share.
 *
 * Three columns, and the alignment IS the point here — every figure is the
 * same unit measured against the same window, so a shared right edge is what
 * makes them comparable at a glance. Facts that compare with nothing do not
 * belong on this grid; they are the trailing meta line instead.
 */
function FactRow(props: { label: string; value: ReactNode; note?: ReactNode; swatch?: ReactNode }) {
  return (
    <div className="maka-inspector-grid-row">
      <dt>
        {props.swatch}
        {props.label}
      </dt>
      <dd className="maka-inspector-grid-value">{props.value}</dd>
      <dd className="maka-inspector-grid-note">{props.note}</dd>
    </div>
  );
}

/**
 * The context window as a band chart rather than a single fill.
 *
 * A one-value bar answers "how full", which is the smaller half of the
 * question; the half a reader acts on is "full of what". Only the split the
 * ledger actually carries is drawn — cache hit vs fresh prompt — and when the
 * provider reports no cache figure the prompt stays one band, because an
 * unreported cache is not a zero cache (#1679).
 *
 * The bands are decoration: the same numbers are read from the legend below,
 * which is why the track is `aria-hidden` and the legend is a real list.
 */
function InspectorContextSection(props: {
  copy: InspectorCopy;
  context: NonNullable<ReturnType<typeof deriveInspectorOverviewModel>['context']>;
  formatNumber: (value: number) => string;
}) {
  const { context, copy, formatNumber } = props;
  const level = context.ratio >= 0.9 ? 'error' : context.ratio >= 0.7 ? 'warning' : undefined;

  return (
    <InspectorSection
      title={copy.overview.context}
      level={level}
      data-maka-contract="session-inspector-context"
      readout={
        <>
          {formatNumber(context.usedTokens)} / {formatNumber(context.windowTokens)} ·{' '}
          {formatPercent(context.ratio)}
        </>
      }
    >
      <div className="maka-inspector-context-track" data-level={level} aria-hidden="true">
        {context.segments.map((segment) => (
          <span
            key={segment.kind}
            className="maka-inspector-context-band"
            data-segment={segment.kind}
            /* Grow-weighted rather than percentage-width so a prompt that
               overran its window still fills exactly one track. */
            style={{ flexGrow: segment.tokens }}
          />
        ))}
      </div>

      {/* The legend is the accessible copy of the bar, on the same grid as the
          session facts below — one reading rhythm across the whole overview. */}
      <dl className="maka-inspector-grid">
        {context.segments.map((segment) => (
          <FactRow
            key={segment.kind}
            label={copy.overview.segment[segment.kind]}
            swatch={
              <span
                className="maka-inspector-context-swatch"
                data-segment={segment.kind}
                data-level={level}
                aria-hidden="true"
              />
            }
            value={formatNumber(segment.tokens)}
            note={formatPercent(segment.ratio)}
          />
        ))}
      </dl>
    </InspectorSection>
  );
}

function providerLabel(providerId: string): string {
  const entry = (PROVIDER_REGISTRY as Readonly<Record<string, { label?: string }>>)[providerId];
  return entry?.label ?? providerId;
}

function numberFormatter(locale: UiLocale): (value: number) => string {
  const formatter = new Intl.NumberFormat(uiLocaleToIntlLocale(locale));
  return (value) => formatter.format(value);
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * One turn, ranked.
 *
 * Three tiers and no fourth: which turn this is and whether it failed carry
 * full ink on the head line; what it cost in time and money trails the same
 * line in supporting grey because nobody reads it until the head line has
 * already caught them; the steps below are the detail you descend into.
 *
 * The failure is stated as red text rather than a filled Badge — a solid chip
 * out-shouts the turn label it qualifies, and the red dot on the rail has
 * already flagged the row from the margin.
 */
function TurnRow(props: {
  turn: InspectorTurnRow;
  turnLabel: (index: number) => string;
  costUnavailable: string;
  failedLabel: string;
  recoveredLabel: string;
}) {
  const { turn } = props;
  return (
    <li
      className="maka-inspector-turn"
      data-maka-contract="session-inspector-turn"
      data-failed={turn.failed || undefined}
    >
      <div className="maka-inspector-turn-head">
        <Text type="label" weight="semibold" className="maka-inspector-turn-label">
          {props.turnLabel(turn.index)}
        </Text>
        {turn.failed && (
          <span
            className="maka-inspector-turn-failure"
            data-maka-contract="session-inspector-turn-failed"
          >
            {turn.failureCode ? `${props.failedLabel} · ${turn.failureCode}` : props.failedLabel}
          </span>
        )}
        <span className="maka-inspector-turn-meta">
          {formatDuration(turn.durationMs)} · {formatCost(turn.totals.costUsd, props.costUnavailable)}
        </span>
      </div>
      <ol className="maka-inspector-steps">
        {turn.steps.map((step) => (
          <StepRow key={step.id} step={step} recoveredLabel={props.recoveredLabel} />
        ))}
      </ol>
    </li>
  );
}

/**
 * One step: what it was, then what qualifies it, then how long it took.
 *
 * The step's own cost is gone. It was the fourth number on a 12px line whose
 * first three already said more, and the turn above states the same money at
 * the level a reader can act on — nobody re-prices a single tool call.
 *
 * A recovery is the one qualifier that changes the reading of the row, so it
 * keeps its own tier; a retry count is left as `×N` on the measurement side,
 * where it is a fact about the attempt rather than about the step.
 */
function StepRow(props: { step: InspectorStepRow; recoveredLabel: string }) {
  const { step } = props;
  const meta = [
    step.retries !== undefined ? `×${step.retries + 1}` : undefined,
    step.durationMs !== undefined ? formatDuration(step.durationMs) : undefined,
  ].filter(Boolean);

  return (
    <li
      className="maka-inspector-step"
      data-maka-contract="session-inspector-step"
      data-failed={step.failed || undefined}
    >
      <span className="maka-inspector-step-text">
        <span className="maka-inspector-step-label">{step.label}</span>
        {step.detail && <span className="maka-inspector-step-detail">{step.detail}</span>}
        {step.recovered && (
          <span className="maka-inspector-step-recovered">
            {props.recoveredLabel}: {step.recovered}
          </span>
        )}
      </span>
      {meta.length > 0 && <span className="maka-inspector-step-meta">{meta.join(' · ')}</span>}
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * Absent cost renders as words, never as `$0.00`: the canonical record keeps
 * "nobody could price this" and "this was free" apart, and so does the panel.
 */
function formatCost(costUsd: number | undefined, unavailable: string): string {
  if (costUsd === undefined) return unavailable;
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}
