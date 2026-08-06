import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Section } from '@astryxdesign/core/Section';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { PROVIDER_REGISTRY, uiLocaleToIntlLocale, type UiLocale } from '@maka/core';
import { useUiLocale } from '@maka/ui';
import {
  Activity,
  AlertTriangle,
  Archive,
  ShieldCheck,
  Sparkles,
  Terminal,
  type LucideIcon,
} from '@maka/ui/icons';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import {
  applyInspectorFilter,
  type InspectorFilter,
} from './session-inspector-filter.js';
import { deriveInspectorOverviewModel } from './session-inspector-overview-model.js';
import {
  deriveInspectorPanelModel,
  type InspectorStepRow,
  type InspectorTurnRow,
} from './session-inspector-panel-model.js';
import { useSessionTrace } from './use-session-trace.js';

type InspectorCopy = ReturnType<typeof getDesktopConversationCopy>['inspector'];

/**
 * Per-session trace (#1625), led by what the session cost and where its
 * context stands, with the causal timeline folded underneath as the raw
 * record. The overview answers the glance questions — how full is the
 * context, what did the tokens and cache do, which model — and the timeline
 * stays one disclosure away for "what exactly happened".
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
  const [filter, setFilter] = useState<InspectorFilter>({});
  const model = useMemo(
    () => applyInspectorFilter(deriveInspectorPanelModel(snapshot.trace), filter),
    [snapshot.trace, filter],
  );
  const overview = useMemo(() => deriveInspectorOverviewModel(snapshot.trace), [snapshot.trace]);
  const hidden = model.hiddenTurns + model.hiddenSteps;
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

        {/* Three different silences, kept apart: a read that failed, a filter
            that matches nothing, and a session that did nothing. Only the last
            one is "nothing to trace".
            One persistent live region rather than three conditional ones: a
            container that mounts and unmounts is not announced, and these
            messages change as the reader types. */}
        <div
          role="status"
          aria-live="polite"
          className="maka-inspector-status"
          /* With nothing to trace the region IS the panel, so it takes the
             leftover height and centres its empty state the way every other
             workbar tab does. Carrying a hint beside a timeline, it hugs. */
          data-empty={model.empty || undefined}
        >
          {model.empty && !snapshot.loading && !snapshot.error && (
            <EmptyState
              isCompact
              title={copy.empty}
              icon={<Activity size={20} aria-hidden="true" />}
            />
          )}
          {!model.empty && model.turns.length === 0 && model.filtered && (
            <EmptyState
              isCompact
              title={copy.noMatches}
              data-maka-contract="session-inspector-no-matches"
            />
          )}
          {!model.empty && model.filtered && hidden > 0 && model.turns.length > 0 && (
            <Text
              type="supporting"
              color="secondary"
              data-maka-contract="session-inspector-hidden"
            >
              {hidden} {copy.hiddenByFilter}
            </Text>
          )}
        </div>

        {!model.empty && hasOverview && (
          <InspectorOverview copy={copy} locale={locale} model={model} overview={overview} />
        )}

        {!model.empty && (
          <Collapsible
            className="maka-inspector-raw"
            data-maka-contract="session-inspector-raw"
            defaultIsOpen={!hasOverview}
            trigger={
              <span className="maka-inspector-raw-trigger">
                <span>{copy.overview.raw}</span>
                <Badge variant="neutral" label={model.turns.length} />
              </span>
            }
          >
            <VStack gap={2} className="maka-inspector-raw-body">
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

              <HStack gap={2} vAlign="center" wrap="wrap">
                <TextInput
                  size="sm"
                  label={copy.filterLabel}
                  isLabelHidden
                  hasClear
                  value={filter.query ?? ''}
                  placeholder={copy.filterPlaceholder}
                  onChange={(value) => setFilter({ ...filter, query: value })}
                />
                <Switch
                  label={copy.filterFailedOnly}
                  value={filter.failedOnly ?? false}
                  onChange={(checked) => setFilter({ ...filter, failedOnly: checked })}
                />
                {model.filtered && (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={copy.filterClear}
                    onClick={() => setFilter({})}
                  />
                )}
              </HStack>

              <ol className="maka-inspector-turns">
                {model.turns.map((turn) => (
                  <TurnRow
                    key={turn.turnId}
                    turn={turn}
                    locale={locale}
                    turnLabel={copy.turnLabel}
                    costUnavailable={copy.costUnavailable}
                    failedLabel={copy.turnFailed}
                    recoveredLabel={copy.recovered}
                  />
                ))}
              </ol>
            </VStack>
          </Collapsible>
        )}
      </VStack>
    </Section>
  );
}

/**
 * The glance layer, in the two sections a reader actually asks about: how full
 * the window is right now, and what the session as a whole did. They are not
 * the same measurement — the bar is one call's prompt, the list is every
 * attempt summed — so they are separate sections rather than one
 * undifferentiated list of numbers.
 *
 * Both sections lay their facts out on ONE grid (`FactRow`) at one type size.
 * Mixing MetadataList's page-sized body type into a 12px instrument panel is
 * what made this read as noise: two neighbouring sections in two sizes claim a
 * hierarchy between them that does not exist, and the Astryx list also paints
 * from the neutral defaults rather than the product palette. Rank here comes
 * from weight, colour and space — never from a second type size.
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

  return (
    <VStack gap={4} data-maka-contract="session-inspector-overview">
      {context && (
        <InspectorContextSection copy={copy} context={context} formatNumber={formatNumber} />
      )}

      <InspectorSection title={copy.overview.session}>
        <dl className="maka-inspector-grid">
          {overview.model && (
            <FactRow
              label={copy.overview.model}
              value={`${providerLabel(overview.model.providerId)} / ${overview.model.modelId}`}
            />
          )}
          {tokens?.inputTokens !== undefined && (
            <FactRow label={copy.overview.input} value={formatNumber(tokens.inputTokens)} />
          )}
          {tokens?.cacheReadInputTokens !== undefined && (
            <FactRow
              label={copy.overview.cacheRead}
              value={formatNumber(tokens.cacheReadInputTokens)}
              note={
                tokens.cacheHitRate !== undefined ? formatPercent(tokens.cacheHitRate) : undefined
              }
            />
          )}
          {tokens?.outputTokens !== undefined && (
            <FactRow
              label={copy.overview.output}
              value={formatNumber(tokens.outputTokens)}
              note={
                tokens.reasoningTokens !== undefined
                  ? `${copy.overview.reasoning} ${formatNumber(tokens.reasoningTokens)}`
                  : undefined
              }
            />
          )}
          {overview.model && (
            <FactRow
              label={copy.totals.calls}
              value={formatNumber(overview.model.callCount)}
              note={
                props.model.totals.retries > 0
                  ? `${copy.totals.retries} ${formatNumber(props.model.totals.retries)}`
                  : undefined
              }
            />
          )}
          {props.model.totals.compactions > 0 && (
            <FactRow
              label={copy.totals.compactions}
              value={formatNumber(props.model.totals.compactions)}
            />
          )}
          <FactRow
            label={copy.totals.cost}
            value={formatCost(props.model.totals.costUsd, copy.costUnavailable)}
          />
          <FactRow
            label={copy.totals.duration}
            value={formatDuration(props.model.totals.durationMs)}
          />
          {overview.lastActivityAt !== undefined && (
            <FactRow
              label={copy.overview.lastActivity}
              value={formatDateTime(props.locale, overview.lastActivityAt)}
            />
          )}
        </dl>
      </InspectorSection>
    </VStack>
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
 * One row of the overview grid: name, figure, and an optional qualifier.
 *
 * The third column is why the rows stay one line each — a cache rate, a retry
 * count or a reasoning split used to be glued onto the figure with a middot,
 * which made the value column ragged and the qualifier look like part of the
 * number. Rows without one leave the column empty rather than collapsing it,
 * so every figure in the section still ends on the same edge.
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

/** Absolute date-time in the reader's locale, the way Pawwork stamps it. */
function formatDateTime(locale: UiLocale, ms: number): string {
  return new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

/** A turn's wall-clock stamp: day + minute, short enough for a meta line. */
function formatTurnTime(locale: UiLocale, ms: number): string {
  return new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function TurnRow(props: {
  turn: InspectorTurnRow;
  locale: UiLocale;
  turnLabel: (index: number) => string;
  costUnavailable: string;
  failedLabel: string;
  recoveredLabel: string;
}) {
  const { turn } = props;
  return (
    <li className="maka-inspector-turn" data-maka-contract="session-inspector-turn">
      <div className="maka-inspector-turn-head">
        <Text type="label" weight="semibold">
          {props.turnLabel(turn.index)}
        </Text>
        {turn.failed && (
          <Badge
            variant="error"
            data-maka-contract="session-inspector-turn-failed"
            label={turn.failureCode ? `${props.failedLabel} · ${turn.failureCode}` : props.failedLabel}
          />
        )}
        <Text type="supporting" color="secondary" className="maka-inspector-turn-meta">
          {formatTurnTime(props.locale, turn.startedAt)} · {formatDuration(turn.durationMs)} ·{' '}
          {formatCost(turn.totals.costUsd, props.costUnavailable)}
        </Text>
      </div>
      <ol className="maka-inspector-steps">
        {turn.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            costUnavailable={props.costUnavailable}
            recoveredLabel={props.recoveredLabel}
          />
        ))}
      </ol>
    </li>
  );
}

const STEP_ICONS: Record<InspectorStepRow['kind'], LucideIcon> = {
  model_call: Sparkles,
  tool: Terminal,
  permission: ShieldCheck,
  compaction: Archive,
  error: AlertTriangle,
};

function StepRow(props: {
  step: InspectorStepRow;
  costUnavailable: string;
  recoveredLabel: string;
}) {
  const { step } = props;
  const Icon = STEP_ICONS[step.kind];
  const meta = [
    step.retries !== undefined ? `×${step.retries + 1}` : undefined,
    step.durationMs !== undefined ? formatDuration(step.durationMs) : undefined,
    step.kind === 'model_call' ? formatCost(step.costUsd, props.costUnavailable) : undefined,
  ].filter(Boolean);

  return (
    <li
      className="maka-inspector-step"
      data-maka-contract="session-inspector-step"
      data-kind={step.kind}
      data-failed={step.failed || undefined}
    >
      <Icon size={14} aria-hidden="true" className="maka-inspector-step-icon" />
      <Text type="supporting" weight="medium" className="maka-inspector-step-label">
        {step.label}
      </Text>
      {step.detail && (
        <Text type="supporting" color="secondary">
          {step.detail}
        </Text>
      )}
      {step.recovered && (
        <Text type="supporting" color="secondary">
          {props.recoveredLabel}: {step.recovered}
        </Text>
      )}
      {meta.length > 0 && (
        <Text type="supporting" color="secondary" className="maka-inspector-step-meta">
          {meta.join(' · ')}
        </Text>
      )}
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
