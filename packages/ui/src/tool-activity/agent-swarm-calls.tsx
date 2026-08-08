/**
 * Path A: agent_swarm → plain Astryx multi-call (one CallRow per item).
 * Shared by ToolTrow and ToolResultPreview so there is one projection only.
 */

import { useEffect, useRef } from 'react';
import type { ToolResultContent } from '@maka/core';
import { Button as UiButton, ChatToolCalls, type ChatToolCallItem } from '@astryxdesign/core';
import { useUiLocale } from '../locale-context.js';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { getToolActivityCopy } from './copy.js';
import {
  formatDuration,
  formatUserVisibleToolText,
  summarizeErrorText,
} from './preview-utils.js';
import { ToolDetailReveal } from './tool-code-block.js';

// Same token as TOOL_OUTPUT_NOTE_CLASS in tool-result-preview — avoid importing
// that module here (it imports AgentSwarmToolCalls).
const SWARM_SUMMARY_NOTE_CLASS = 'maka-tool-output-note';

type AgentSwarmResult = Extract<ToolResultContent, { kind: 'agent_swarm' }>;
type AgentSwarmItem = AgentSwarmResult['items'][number];

/** items[] → one ChatToolCalls group; Astryx owns fold chrome. */
export function AgentSwarmToolCalls(props: {
  toolUseId: string;
  result: AgentSwarmResult;
  onOpenLinkedSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  const copy = getToolActivityCopy(locale).agent;
  const { toolUseId, result, onOpenLinkedSession } = props;
  // Same slot split as ordinary tools / agent_spawn: name = kind ("Agent"),
  // target = who (preset or child id). Preset strings like "Local Read" are not
  // tool names and must not occupy the name column.
  const calls: ChatToolCallItem[] = result.items.map((swarmItem) => {
    const identity = redactSecrets(
      swarmItem.agentName?.trim() || swarmItem.profile?.trim() || swarmItem.itemId,
    );
    const sessionId = swarmItem.childSessionId;
    const canOpen = Boolean(sessionId && onOpenLinkedSession);
    return {
      key: `${toolUseId}:${swarmItem.itemId}`,
      name: 'Agent',
      status: astryxSwarmItemStatus(swarmItem.status),
      target: identity,
      duration: formatDuration(swarmItem.durationMs) ?? undefined,
      stats: copy.swarm.status[swarmItem.status],
      errorMessage:
        swarmItem.status === 'failed'
          ? summarizeErrorText(
              formatUserVisibleToolText(
                redactSecrets(swarmItem.summary || swarmItem.failureClass || ''),
                locale,
              ),
            ).replace(/^Error:\s*/i, '') || undefined
          : undefined,
      ...(canOpen
        ? {
            resultDetail: (
              <OpenLinkedSessionOnActivate
                sessionId={sessionId!}
                onOpen={onOpenLinkedSession!}
                label={copy.openSession}
                ariaLabel={copy.openSessionAriaLabel(identity)}
              />
            ),
          }
        : swarmItem.summary.trim().length > 0
          ? {
              resultDetail: (
                <ToolDetailReveal>
                  <p className={SWARM_SUMMARY_NOTE_CLASS}>{redactSecrets(swarmItem.summary)}</p>
                </ToolDetailReveal>
              ),
            }
          : {}),
    };
  });

  return (
    <ChatToolCalls
      calls={calls}
      defaultIsExpanded={false}
      data-kind="agent_swarm"
      data-status={result.status}
      data-tool-use-id={toolUseId}
      data-item-count={result.items.length}
    />
  );
}

/**
 * Astryx expands a CallRow by mounting resultDetail. For ready linked children,
 * that activation is the Open gesture — navigate immediately; keep a contract
 * node for tests and as a manual fallback.
 */
export function OpenLinkedSessionOnActivate(props: {
  sessionId: string;
  onOpen: (sessionId: string) => void;
  label: string;
  ariaLabel: string;
}) {
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  useEffect(() => {
    onOpenRef.current(props.sessionId);
  }, [props.sessionId]);

  return (
    <div className={previewVariants({ part: 'agent-actions' })} role="group">
      <UiButton
        variant="ghost"
        size="sm"
        className={previewVariants({ part: 'agent-copy' })}
        data-maka-contract="open-subagent-session"
        data-session-id={props.sessionId}
        onClick={() => props.onOpen(props.sessionId)}
        aria-label={props.ariaLabel}
        label={props.label}
      />
    </div>
  );
}

function astryxSwarmItemStatus(
  status: AgentSwarmItem['status'],
): ChatToolCallItem['status'] {
  switch (status) {
    case 'completed':
      return 'complete';
    case 'failed':
    case 'cancelled':
      return 'error';
    case 'running':
      return 'running';
    case 'queued':
    default:
      return 'pending';
  }
}
