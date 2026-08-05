import { useMemo, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Section } from '@astryxdesign/core/Section';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { PROVIDER_REGISTRY, uiLocaleToIntlLocale, type UiLocale } from '@maka/core';
import { useUiLocale } from '@maka/ui';
import { Activity } from '@maka/ui/icons';
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
      padding={3}
      className="maka-inspector-panel"
      data-maka-contract="session-inspector"
      aria-label={copy.ariaLabel}
      aria-busy={snapshot.loading || undefined}
    >
      <VStack gap={2} height="100%">
        {snapshot.error && (
          <Banner
            status="error"
            title={snapshot.error}
            endContent={
              <Button variant="ghost" size="sm" label={copy.retry} onClick={snapshot.retry} />
            }
          />
        )}

        {model.coverage && (
          <Banner
            status="warning"
            data-maka-contract="session-inspector-coverage"
            title={model.coverage.kind === 'absent' ? copy.coverageAbsent : copy.coveragePartial}
            description={
              [
                model.coverage.turnsMissing > 0 &&
                  `${model.coverage.turnsMissing} ${copy.turnsMissing}`,
                model.coverage.turnsShort > 0 && `${model.coverage.turnsShort} ${copy.turnsShort}`,
                model.coverage.unreadableRecords > 0 &&
                  `${model.coverage.unreadableRecords} ${copy.unreadable}`,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
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

/** The glance layer: context fullness, then the session's facts as one list. */
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
    <VStack gap={3} data-maka-contract="session-inspector-overview">
      {context && (
        <VStack gap={1} data-maka-contract="session-inspector-context">
          <ProgressBar
            value={context.usedTokens}
            max={context.windowTokens}
            label={copy.overview.context}
            hasValueLabel
            formatValueLabel={() => formatPercent(context.ratio)}
            variant={context.ratio >= 0.9 ? 'error' : context.ratio >= 0.7 ? 'warning' : 'accent'}
          />
          <Text type="supporting" color="secondary" className="maka-inspector-cost">
            {formatNumber(context.usedTokens)} / {formatNumber(context.windowTokens)}
          </Text>
        </VStack>
      )}

      <MetadataList>
        {overview.model && (
          <MetadataListItem label={copy.overview.model}>
            {providerLabel(overview.model.providerId)} / {overview.model.modelId}
          </MetadataListItem>
        )}
        {tokens?.inputTokens !== undefined && (
          <MetadataListItem label={copy.overview.input}>
            {formatNumber(tokens.inputTokens)}
          </MetadataListItem>
        )}
        {tokens?.cacheReadInputTokens !== undefined && (
          <MetadataListItem label={copy.overview.cacheRead}>
            {formatNumber(tokens.cacheReadInputTokens)}
            {tokens.cacheHitRate !== undefined && ` · ${formatPercent(tokens.cacheHitRate)}`}
          </MetadataListItem>
        )}
        {tokens?.outputTokens !== undefined && (
          <MetadataListItem label={copy.overview.output}>
            {formatNumber(tokens.outputTokens)}
            {tokens.reasoningTokens !== undefined &&
              ` · ${copy.overview.reasoning} ${formatNumber(tokens.reasoningTokens)}`}
          </MetadataListItem>
        )}
        {overview.model && (
          <MetadataListItem label={props.copy.totals.calls}>
            {formatNumber(overview.model.callCount)}
            {props.model.totals.retries > 0 &&
              ` · ${copy.totals.retries} ${formatNumber(props.model.totals.retries)}`}
          </MetadataListItem>
        )}
        {props.model.totals.compactions > 0 && (
          <MetadataListItem label={copy.totals.compactions}>
            {formatNumber(props.model.totals.compactions)}
          </MetadataListItem>
        )}
        <MetadataListItem label={copy.totals.cost}>
          {formatCost(props.model.totals.costUsd, copy.costUnavailable)}
        </MetadataListItem>
        <MetadataListItem label={copy.totals.duration}>
          {formatDuration(props.model.totals.durationMs)}
        </MetadataListItem>
        {overview.lastActivityAt !== undefined && (
          <MetadataListItem label={copy.overview.lastActivity}>
            {formatDateTime(props.locale, overview.lastActivityAt)}
          </MetadataListItem>
        )}
      </MetadataList>
    </VStack>
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

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function TurnRow(props: {
  turn: InspectorTurnRow;
  costUnavailable: string;
  failedLabel: string;
  recoveredLabel: string;
}) {
  const { turn } = props;
  return (
    <li className="maka-inspector-turn" data-maka-contract="session-inspector-turn">
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="label" weight="semibold">
          {turn.turnId}
        </Text>
        <Text type="supporting" color="secondary">
          {formatDuration(turn.durationMs)}
        </Text>
        <Text type="supporting" color="secondary" className="maka-inspector-cost">
          {formatCost(turn.totals.costUsd, props.costUnavailable)}
        </Text>
        {turn.failed && (
          <Badge
            variant="error"
            data-maka-contract="session-inspector-turn-failed"
            label={turn.failureCode ? `${props.failedLabel} · ${turn.failureCode}` : props.failedLabel}
          />
        )}
      </HStack>
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

function StepRow(props: {
  step: InspectorStepRow;
  costUnavailable: string;
  recoveredLabel: string;
}) {
  const { step } = props;
  return (
    <li
      className="maka-inspector-step"
      data-maka-contract="session-inspector-step"
      data-kind={step.kind}
      data-failed={step.failed || undefined}
    >
      <Text type="supporting" color="secondary" className="maka-inspector-step-kind">
        {step.kind}
      </Text>
      <Text type="supporting">{step.label}</Text>
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
      {step.retries !== undefined && (
        <Text type="supporting" color="secondary" className="maka-inspector-cost">
          ×{step.retries + 1}
        </Text>
      )}
      {step.durationMs !== undefined && (
        <Text type="supporting" color="secondary">
          {formatDuration(step.durationMs)}
        </Text>
      )}
      {step.kind === 'model_call' && (
        <Text type="supporting" color="secondary" className="maka-inspector-cost">
          {formatCost(step.costUsd, props.costUnavailable)}
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
