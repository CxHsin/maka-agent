import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPlainTextSendCommand,
  routeSendSteering,
  type SendSteeringCandidate,
} from '../session-send-resolve.js';

describe('isPlainTextSendCommand (#1954 mid-turn send routing)', () => {
  it('treats a bare text send as steerable', () => {
    assert.equal(isPlainTextSendCommand({ text: 'steer me' }), true);
  });

  it('treats blank text as not steerable', () => {
    assert.equal(isPlainTextSendCommand({ text: '   ' }), false);
    assert.equal(isPlainTextSendCommand({ text: '' }), false);
  });

  it('falls through when any complex payload is present', () => {
    const base: SendSteeringCandidate = { text: 'hi' };
    assert.equal(isPlainTextSendCommand({ ...base, attachmentItems: [{}] }), false);
    assert.equal(isPlainTextSendCommand({ ...base, quotes: [{ id: 'q1' }] }), false);
    assert.equal(isPlainTextSendCommand({ ...base, skillIds: ['skill-1'] }), false);
    assert.equal(isPlainTextSendCommand({ ...base, voiceOperationId: 'op-1' }), false);
    assert.equal(isPlainTextSendCommand({ ...base, turnOrchestration: { mode: 'plan' } }), false);
    assert.equal(isPlainTextSendCommand({ ...base, workspaceFileReferences: [{ value: '@x', start: 0 }] }), false);
  });
});

describe('routeSendSteering (#1954)', () => {
  it('steers when the queue accepts a plain-text send', () => {
    assert.equal(
      routeSendSteering({ isPlainText: true, steer: () => ({ kind: 'queued' }) }),
      'steered',
    );
  });

  it('falls through when the queue reports fallback (no steering-capable turn)', () => {
    assert.equal(
      routeSendSteering({ isPlainText: true, steer: () => ({ kind: 'fallback' }) }),
      'fallthrough',
    );
  });

  it('never steers a complex send, even if a queue exists', () => {
    assert.equal(
      routeSendSteering({ isPlainText: false, steer: () => ({ kind: 'queued' }) }),
      'fallthrough',
    );
  });

  it('never invokes the queue for a non-plain-text send', () => {
    let calls = 0;
    const outcome = routeSendSteering({
      isPlainText: false,
      steer: () => { calls += 1; return { kind: 'queued' }; },
    });
    assert.equal(outcome, 'fallthrough');
    assert.equal(calls, 0);
  });
});
