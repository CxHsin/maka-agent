import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolResultContent } from '@maka/core';
import { LocaleProvider } from '../locale-context.js';
import { SubagentPreview } from '../tool-activity/agent-preview.js';

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

function render(result: Extract<ToolResultContent, { kind: 'subagent' }>): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SubagentPreview result={result} onOpenSession={() => undefined} />
    </LocaleProvider>,
  );
}

describe('SubagentPreview open session', () => {
  it('renders an open control when childSessionId and onOpenSession are present', () => {
    const html = render(subagentResult({ childSessionId: 'child-1' }));
    assert.match(html, /data-maka-contract="open-subagent-session"/);
    assert.match(html, /Open session/);
  });

  it('hides the open control when childSessionId is missing', () => {
    const html = render(subagentResult());
    assert.doesNotMatch(html, /data-maka-contract="open-subagent-session"/);
  });
});
