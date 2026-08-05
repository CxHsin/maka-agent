import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageQueueSnapshot } from '@maka/core';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';

test('mirrors authoritative queue_update events by session', () => {
  let queues: Record<string, MessageQueueSnapshot> = {};
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'en',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: { current: {} },
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession() {},
    setInteractionBySession() {},
    setMessageQueueBySession(updater) {
      queues = updater(queues);
    },
    showModelSetupToast() {},
    toastApi: { error() {} },
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-1',
    turnId: 'turn-1',
    ts: 1,
    steering: ['change direction'],
    followup: ['then summarize'],
  });

  assert.deepEqual(queues, {
    'session-1': {
      steering: ['change direction'],
      followup: ['then summarize'],
    },
  });
});
