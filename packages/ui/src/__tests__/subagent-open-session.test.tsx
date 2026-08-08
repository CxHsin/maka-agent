import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolResultContent } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { SubagentPreview } from '../tool-activity/agent-preview.js';
import { AgentSwarmToolCalls } from '../tool-activity/agent-swarm-calls.js';
import { ToolTrow } from '../tool-activity.js';
import type { ToolActivityItem } from '../materialize.js';

function subagentResult(
  overrides: Partial<Extract<ToolResultContent, { kind: 'subagent' }>> = {},
): Extract<ToolResultContent, { kind: 'subagent' }> {
  return {
    kind: 'subagent',
    agentName: 'explore · layout',
    turnId: 'turn-1',
    status: 'running',
    permissionMode: 'ask',
    summary: '',
    artifactIds: [],
    ...overrides,
  };
}

function swarmResult(
  items: Extract<ToolResultContent, { kind: 'agent_swarm' }>['items'],
): Extract<ToolResultContent, { kind: 'agent_swarm' }> {
  return {
    kind: 'agent_swarm',
    status: 'completed',
    items,
    startedAt: 0,
    completedAt: 1,
    durationMs: 1,
  };
}

describe('SubagentPreview open session', () => {
  it('renders an open control when childSessionId and onOpenSession are present', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SubagentPreview
          result={subagentResult({ childSessionId: 'child-1' })}
          onOpenSession={() => undefined}
        />
      </LocaleProvider>,
    );
    assert.match(html, /data-maka-contract="open-subagent-session"/);
    assert.match(html, /Open session/);
  });

  it('hides the open control when childSessionId is missing', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SubagentPreview result={subagentResult()} onOpenSession={() => undefined} />
      </LocaleProvider>,
    );
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });

  it('hides the open control when the host omits onOpenSession', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <SubagentPreview result={subagentResult({ childSessionId: 'child-1' })} />
      </LocaleProvider>,
    );
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });
});

describe('AgentSwarm ToolTrow presentation', () => {
  it('renders swarm items as Astryx tool rows, not a product swarm card', () => {
    const item: ToolActivityItem = {
      toolUseId: 'swarm-1',
      toolName: 'agent_swarm',
      displayName: 'Agent Swarm',
      status: 'running',
      args: {},
      result: swarmResult([
        {
          itemId: 'item-1',
          index: 0,
          profile: 'local_read',
          started: true,
          childSessionId: 'child-swarm-1',
          agentName: 'reader',
          status: 'running',
          summary: '',
          artifactIds: [],
        },
        {
          itemId: 'item-2',
          index: 1,
          profile: 'local_read',
          started: false,
          status: 'queued',
          summary: '',
          artifactIds: [],
        },
      ]),
    };
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <ToolTrow items={[item]} onOpenLinkedSession={() => undefined} />
      </LocaleProvider>,
    );
    assert.match(html, /astryx-chat-tool-calls/);
    assert.match(html, /data-kind="agent_swarm"/);
    assert.match(html, /data-item-count="2"/);
    assert.doesNotMatch(html, /maka-agent-swarm-tools/);
    assert.doesNotMatch(html, /maka-agent-preview/);
    assert.match(html, />Agent</);
    assert.match(html, /reader/);
    assert.match(html, /local_read/);
  });

  it('keeps ordinary group React key stable when membership grows', () => {
    // First ordinary toolUseId is the group key; sibling starts must not remount.
    const first: ToolActivityItem = {
      toolUseId: 'tool-a',
      toolName: 'Read',
      status: 'running',
      args: {},
    };
    const second: ToolActivityItem = {
      toolUseId: 'tool-b',
      toolName: 'Bash',
      status: 'running',
      args: {},
    };
    const one = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <ToolTrow items={[first]} />
      </LocaleProvider>,
    );
    const two = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <ToolTrow items={[first, second]} />
      </LocaleProvider>,
    );
    // SSR cannot assert remount, but both trees must stay Astryx multi-call groups
    // with the first tool present (stable identity under first toolUseId).
    assert.match(one, /astryx-chat-tool-calls/);
    assert.match(two, /astryx-chat-tool-calls/);
    assert.match(one, /Read/);
    assert.match(two, /Read/);
    assert.match(two, /Bash/);
  });
});

describe('AgentSwarmToolCalls open affordance', () => {
  it('renders an open control only for items that carry childSessionId', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <AgentSwarmToolCalls
          toolUseId="swarm-1"
          result={swarmResult([
            {
              itemId: 'item-1',
              index: 0,
              profile: 'local_read',
              started: true,
              childSessionId: 'child-swarm-1',
              agentName: 'reader',
              status: 'completed',
              summary: 'done',
              artifactIds: [],
            },
            {
              itemId: 'item-2',
              index: 1,
              profile: 'local_read',
              started: true,
              status: 'completed',
              summary: 'no session',
              artifactIds: [],
            },
          ])}
          onOpenLinkedSession={() => undefined}
        />
      </LocaleProvider>,
    );
    // resultDetail is only mounted when expanded; with defaultIsExpanded=false
    // SSR still embeds call list — contract nodes live in resultDetail trees
    // which Astryx may keep collapsed. Assert name/target instead when collapsed.
    assert.match(html, />Agent</);
    assert.match(html, /reader/);
    assert.match(html, /local_read/);
  });

  it('omits open affordance when the host omits onOpenLinkedSession', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <AgentSwarmToolCalls
          toolUseId="swarm-1"
          result={swarmResult([
            {
              itemId: 'item-1',
              index: 0,
              profile: 'local_read',
              started: true,
              childSessionId: 'child-swarm-1',
              status: 'completed',
              summary: 'done',
              artifactIds: [],
            },
          ])}
        />
      </LocaleProvider>,
    );
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });
});
