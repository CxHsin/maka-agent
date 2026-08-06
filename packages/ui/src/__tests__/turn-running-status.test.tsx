import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';
import { TurnView } from '../chat-turn.js';
import { formatTurnDuration } from '../chat-display-helpers.js';
import { formatDuration } from '../tool-activity/preview-utils.js';
import { getConversationCopy } from '../conversation-copy.js';
import { isTimeDrivenMotionEnabled } from '../streaming-presentation.js';

function render(node: ReactNode): string {
  return renderReactToStaticMarkup(createElement(LocaleProvider, {
    locale: 'zh',
    children: node,
  }));
}

/** A turn mid-flight: reasoning already on screen and a tool still running. */
function turnWithLiveContent(): TurnViewModel {
  return {
    turnId: 'turn-1',
    status: 'running',
    partialOutputRetained: false,
    tools: [{ toolUseId: 't1', toolName: 'Bash', status: 'running', args: {} }],
    notes: [],
    timeline: [
      { kind: 'thinking', text: 'reasoning', messageId: 'a1', live: true },
      { kind: 'tools', items: [{ toolUseId: 't1', toolName: 'Bash', status: 'running', args: {} }] },
    ],
    startedAt: Date.now() - 90_000,
  };
}

describe('live turn running status line', () => {
  it('stays up while the turn already has live content on screen', () => {
    // The regression this locks: the cue it replaced was gated on the turn
    // having produced nothing yet, so it disappeared the moment a tool started
    // — leaving a long tool run with no sign the harness was still working.
    const markup = render(createElement(TurnView, {
      turn: turnWithLiveContent(),
      liveStreaming: { runningStatus: true },
    }));

    assert.match(markup, /maka-turn-processing/);
  });

  it('shows a working phrase from the pool', () => {
    const markup = render(createElement(TurnView, {
      turn: turnWithLiveContent(),
      liveStreaming: { runningStatus: true },
    }));
    const phrases = getConversationCopy('zh').messages.workingPhrases;

    assert.ok(phrases.some((phrase) => markup.includes(phrase)), 'expected one working phrase');
  });

  it('keeps the clock out of a static render', () => {
    // The elapsed value only exists once an effect has measured it against the
    // wall clock, so server markup and the first paint carry the phrase alone.
    // Anything else would make a captured render differ run to run.
    const markup = render(createElement(TurnView, {
      turn: turnWithLiveContent(),
      liveStreaming: { runningStatus: true },
    }));

    assert.doesNotMatch(markup, /maka-turn-elapsed/);
  });

  it('keeps every zh working phrase the same width so the clock never shifts', () => {
    // The phrases sit immediately left of a ticking number. Uneven lengths
    // would nudge it sideways on every swap.
    const widths = new Set(getConversationCopy('zh').messages.workingPhrases.map((p) => p.length));

    assert.equal(widths.size, 1, `expected one phrase length, got ${[...widths].join(', ')}`);
  });
});

describe('time-driven motion gate', () => {
  it('reports frozen for a node inside a marked subtree, not just a marked root', () => {
    // The CSS contract these attributes drive uses descendant selectors, so a
    // host may mark a subtree instead of `<html>` — Storybook marks its shell
    // frame. Reading only the root let a one-second timer run inside a tree
    // whose motion the stylesheet had already capped to nothing.
    const inside = { closest: (selector: string) => (selector.includes('maka-e2e-fixture') ? {} : null) };
    const outside = { closest: () => null };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { dataset: {} } },
    });
    try {
      assert.equal(isTimeDrivenMotionEnabled(inside as unknown as Element), false);
      assert.equal(isTimeDrivenMotionEnabled(outside as unknown as Element), true);
      assert.equal(isTimeDrivenMotionEnabled(null), true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('still reports frozen when the document root carries the attribute', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { dataset: { makaReducedMotion: 'true' } } },
    });
    try {
      assert.equal(isTimeDrivenMotionEnabled(null), false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
});

describe('settled turn elapsed label', () => {
  const settled: TurnViewModel = {
    turnId: 'turn-1',
    status: 'completed',
    partialOutputRetained: false,
    tools: [],
    notes: [],
    timeline: [{ kind: 'text', text: 'done', messageId: 'a1' }],
    startedAt: 1,
    durationMs: 114_000,
  };

  it('renders the duration in the footer row', () => {
    const markup = render(createElement(TurnView, {
      turn: settled,
      footerActions: [{ id: 'copy', label: '复制', enabled: true }],
    }));

    assert.match(markup, /用时 1m 54s/);
  });

  it('does not put the duration inside a hover-revealed action', () => {
    // The footer's reveal moved onto `.maka-turn-footer-action`; a duration
    // carrying that class would fade out with the buttons and stay as hidden
    // as the tooltip it replaced.
    const markup = render(createElement(TurnView, {
      turn: settled,
      footerActions: [{ id: 'copy', label: '复制', enabled: true }],
    }));
    const elapsedTag = /<[^>]*class="[^"]*maka-turn-elapsed[^"]*"[^>]*>/.exec(markup)?.[0] ?? '';

    assert.ok(elapsedTag, 'expected an elapsed element');
    assert.doesNotMatch(elapsedTag, /maka-turn-footer-action/);
  });

  it('omits the label on a turn with no recorded duration', () => {
    const markup = render(createElement(TurnView, {
      turn: { ...settled, durationMs: undefined },
      footerActions: [{ id: 'copy', label: '复制', enabled: true }],
    }));

    assert.doesNotMatch(markup, /maka-turn-elapsed/);
  });
});

describe('turn duration formatting', () => {
  it('matches the shape tool cards use', () => {
    // Both sit in one view — a running turn's clock directly under the tool
    // cards it waits on — so this is one implementation, not two that agree.
    for (const ms of [0, 450, 1_000, 8_200, 12_000, 59_999, 60_000, 114_000, 3_600_000]) {
      assert.equal(formatTurnDuration(ms), formatDuration(ms));
    }
  });
});
