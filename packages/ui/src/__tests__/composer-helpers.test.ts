import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enqueueComposerQueuedInput,
  isComposerResponseBusy,
  isReferenceSizedPaste,
  navigateComposerHistory,
  PASTE_AS_QUOTE_MIN_CHARS,
  PASTE_AS_QUOTE_MIN_LINES,
  readComposerDraft,
  reconcileHistorySync,
  rememberComposerDraft,
  rememberComposerHistoryEntry,
  takeComposerQueuedInput,
  type ComposerHistoryState,
  type ComposerQueuedInput,
} from '../composer-helpers.js';

describe('reconcileHistorySync', () => {
  it('preserves in-memory state when storage cannot be read', () => {
    const current: ComposerHistoryState = {
      entries: ['内存里的历史'],
      index: 0,
      savedDraft: '草稿',
    };
    const result = reconcileHistorySync(current, null);
    assert.equal(result.state, current);
    assert.equal(result.restoreDraft, false);
  });

  it('restores a navigated draft on clear and otherwise adopts bounded synced state', () => {
    const current: ComposerHistoryState = {
      entries: ['旧'],
      index: 5,
      savedDraft: '用户正在编辑的草稿',
    };
    assert.deepEqual(reconcileHistorySync(current, []), {
      state: { entries: [], index: -1, savedDraft: '' },
      restoreDraft: true,
    });
    assert.equal(
      reconcileHistorySync({ ...current, savedDraft: '' }, []).restoreDraft,
      false,
    );
    assert.deepEqual(reconcileHistorySync(current, ['a', 'b']), {
      state: { entries: ['a', 'b'], index: 1, savedDraft: current.savedDraft },
      restoreDraft: false,
    });
  });
});

describe('composer draft storage', () => {
  it('stores, overwrites, and deletes keyed drafts while ignoring missing keys', () => {
    const store = new Map<string, string>();
    rememberComposerDraft(store, undefined, 'ignored');
    rememberComposerDraft(store, 'session-a', 'first');
    rememberComposerDraft(store, 'session-a', 'second');
    assert.deepEqual([...store], [['session-a', 'second']]);
    assert.equal(readComposerDraft(store, 'session-b'), '');
    rememberComposerDraft(store, 'session-a', '   ');
    assert.equal(readComposerDraft(store, 'session-a'), '');
  });

  it('keeps only the trailing 120k characters of an oversized draft', () => {
    const store = new Map<string, string>();
    const tail = 'T'.repeat(120_000);
    rememberComposerDraft(store, 'session-a', `${'H'.repeat(100)}${tail}`);
    assert.equal(readComposerDraft(store, 'session-a'), tail);
  });

  it('caps the LRU store at 32 entries and refreshes remembered keys', () => {
    const store = new Map<string, string>();
    for (let index = 0; index < 32; index++) {
      rememberComposerDraft(store, `key-${index}`, `draft-${index}`);
    }
    rememberComposerDraft(store, 'key-0', 'fresh');
    rememberComposerDraft(store, 'key-32', 'new');
    assert.equal(store.size, 32);
    assert.equal(store.has('key-0'), true);
    assert.equal(store.has('key-1'), false);
  });
});

describe('rememberComposerHistoryEntry', () => {
  it('ignores blanks, trims and refreshes duplicates, and caps history at 50', () => {
    const entries = Array.from({ length: 50 }, (_, index) => `entry-${index}`);
    assert.equal(rememberComposerHistoryEntry(entries, '   '), entries);
    const refreshed = rememberComposerHistoryEntry(entries, '  entry-0  ');
    assert.equal(refreshed.at(-1), 'entry-0');
    assert.equal(refreshed.length, 50);
    const appended = rememberComposerHistoryEntry(refreshed, 'entry-50');
    assert.deepEqual(appended.slice(-2), ['entry-0', 'entry-50']);
    assert.equal(appended.length, 50);
  });
});

describe('navigateComposerHistory', () => {
  it('leaves empty history and next-from-idle unchanged', () => {
    const empty: ComposerHistoryState = { entries: [], index: -1, savedDraft: '' };
    assert.deepEqual(navigateComposerHistory(empty, 'previous', 'draft'), {
      state: empty,
      value: 'draft',
      changed: false,
    });
    const idle: ComposerHistoryState = { entries: ['a'], index: -1, savedDraft: '' };
    assert.deepEqual(navigateComposerHistory(idle, 'next', 'draft'), {
      state: idle,
      value: 'draft',
      changed: false,
    });
  });

  it('walks, clamps, and round-trips history without losing the draft', () => {
    let state: ComposerHistoryState = { entries: ['one', 'two'], index: -1, savedDraft: '' };
    let value = '原始输入';
    for (const direction of ['previous', 'previous', 'previous', 'next', 'next'] as const) {
      const result = navigateComposerHistory(state, direction, value);
      assert.equal(result.changed, true);
      state = result.state;
      value = result.value;
    }
    assert.equal(value, '原始输入');
    assert.deepEqual(state, { entries: ['one', 'two'], index: -1, savedDraft: '' });
  });
});

describe('isComposerResponseBusy (mid-turn send routing, #1954)', () => {
  it('treats active text streaming as busy even without a session status', () => {
    assert.equal(isComposerResponseBusy({ streaming: true, sessionStatus: undefined }), true);
  });
  it('treats a running session as busy before assistant text streams', () => {
    assert.equal(isComposerResponseBusy({ streaming: false, sessionStatus: 'running' }), true);
  });
  it('treats a session parked on a permission prompt (waiting_for_user) as busy', () => {
    assert.equal(isComposerResponseBusy({ streaming: false, sessionStatus: 'waiting_for_user' }), true);
  });
  it('does not treat an idle non-running session as busy', () => {
    assert.equal(isComposerResponseBusy({ streaming: false, sessionStatus: 'active' }), false);
    assert.equal(isComposerResponseBusy({ streaming: false, sessionStatus: undefined }), false);
  });
});

describe('composer queued inputs', () => {
  it('trims and appends a queued input while preserving order', () => {
    const current: ComposerQueuedInput[] = [{ id: 'q1', text: 'first' }];
    const next = enqueueComposerQueuedInput(current, '  guide the answer  ', 'q2');
    assert.deepEqual(next, [
      { id: 'q1', text: 'first' },
      { id: 'q2', text: 'guide the answer' },
    ]);
  });
  it('ignores blank queued input text', () => {
    const current: ComposerQueuedInput[] = [{ id: 'q1', text: 'first' }];
    assert.equal(enqueueComposerQueuedInput(current, '   ', 'q2'), current);
  });
  it('takes one queued input by id and leaves the rest in order', () => {
    const current: ComposerQueuedInput[] = [
      { id: 'q1', text: 'first' },
      { id: 'q2', text: 'urgent direction' },
      { id: 'q3', text: 'later' },
    ];
    const result = takeComposerQueuedInput(current, 'q2');
    assert.deepEqual(result.item, { id: 'q2', text: 'urgent direction' });
    assert.deepEqual(result.queue, [
      { id: 'q1', text: 'first' },
      { id: 'q3', text: 'later' },
    ]);
  });
  it('returns undefined for an unknown queued id', () => {
    const result = takeComposerQueuedInput([{ id: 'q1', text: 'first' }], 'missing');
    assert.equal(result.item, undefined);
    assert.deepEqual(result.queue, [{ id: 'q1', text: 'first' }]);
  });
});

describe('isReferenceSizedPaste', () => {
  it('uses either the character or line boundary without capturing ordinary prompts', () => {
    const lines = (count: number) => Array.from({ length: count }, () => 'ok').join('\n');
    assert.equal(isReferenceSizedPaste('line one\nline two'), false);
    assert.equal(isReferenceSizedPaste('x'.repeat(PASTE_AS_QUOTE_MIN_CHARS - 1)), false);
    assert.equal(isReferenceSizedPaste('x'.repeat(PASTE_AS_QUOTE_MIN_CHARS)), true);
    assert.equal(isReferenceSizedPaste(lines(PASTE_AS_QUOTE_MIN_LINES)), false);
    assert.equal(isReferenceSizedPaste(lines(PASTE_AS_QUOTE_MIN_LINES + 1)), true);
  });
});
