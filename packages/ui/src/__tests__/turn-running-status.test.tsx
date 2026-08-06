import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup as renderReactToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';
import { TurnRunningStatus, TurnView } from '../chat-turn.js';
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

  it('runs no animation of its own', () => {
    // Both idioms above this row are already spoken for: a running tool card
    // spins, and Astryx's `ChatReasoning` shimmers its label while reasoning
    // streams. A second spinner or a second sweep put two of them a few pixels
    // apart, at different speeds. What moves here is the content itself.
    const markup = render(createElement(TurnRunningStatus, { startedAt: 1 }));

    assert.doesNotMatch(markup, /spinner|shimmer/i);
  });

  it('keeps a name on the row now that the spinner is not carrying one', () => {
    // Every visible token here moves on the clock and is hidden from the
    // accessibility tree; the spinner's label used to be the row's whole
    // accessible name.
    const markup = render(createElement(TurnRunningStatus, { startedAt: 1 }));

    assert.match(markup, /aria-label="[^"]+"/);
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

describe('turn duration formatting', () => {
  it('advances in whole seconds and never below one', () => {
    // A one-second timer drives this number, so anything finer than a second
    // is precision the counter cannot deliver: a tenths digit would jump in
    // tenths-of-ten, and a millisecond reading would claim an accuracy the
    // interval never had.
    const cases: Array<[number, string]> = [
      [0, '0s'],
      [450, '0s'],
      [999, '0s'],
      [1_000, '1s'],
      [8_200, '8s'],
      [25_400, '25s'],
      [59_999, '59s'],
      [60_000, '1m 0s'],
      [114_900, '1m 54s'],
      [3_600_000, '60m 0s'],
    ];
    for (const [ms, expected] of cases) assert.equal(formatTurnDuration(ms), expected);
  });

  it('truncates rather than rounds so the clock never runs ahead', () => {
    // Rounding would show 26s at 25.6s elapsed — a counter reporting time that
    // has not passed yet, and one that could reach `1m 60s`.
    assert.equal(formatTurnDuration(25_600), '25s');
    assert.equal(formatTurnDuration(119_800), '1m 59s');
  });

  it('is deliberately coarser than the tool card shape', () => {
    // Tool cards report a span measured after the fact and may resolve below a
    // second; this one is read while it advances. Locked so a future de-dup
    // does not quietly hand the live clock back its milliseconds.
    assert.equal(formatDuration(450), '450 ms');
    assert.equal(formatTurnDuration(450), '0s');
  });
});
