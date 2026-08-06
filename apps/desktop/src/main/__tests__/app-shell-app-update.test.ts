import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppUpdateStatus } from '../../preload/bridge-contract.js';
import { updateReminderFromStatus } from '../../renderer/app-shell-app-update.js';

describe('updateReminderFromStatus', () => {
  it('leaves the silent phases silent', () => {
    const silent: AppUpdateStatus[] = [
      { state: 'idle', currentVersion: '0.1.6' },
      { state: 'checking', currentVersion: '0.1.6' },
      { state: 'not-available', currentVersion: '0.1.6' },
      { state: 'available', currentVersion: '0.1.6', latestVersion: '0.1.7' },
      {
        state: 'downloading',
        currentVersion: '0.1.6',
        latestVersion: '0.1.7',
        progress: { percent: 42 },
      },
      { state: 'installing', currentVersion: '0.1.6', latestVersion: '0.1.7' },
    ];

    for (const status of silent) {
      assert.equal(
        updateReminderFromStatus(status),
        undefined,
        `${status.state} resolves itself and must not reach the footer`,
      );
    }
    assert.equal(updateReminderFromStatus(null), undefined);
  });

  it('asks for a restart once the update is on disk', () => {
    assert.deepEqual(
      updateReminderFromStatus({
        state: 'downloaded',
        currentVersion: '0.1.6',
        latestVersion: '0.1.7',
      }),
      { state: 'downloaded', latestVersion: '0.1.7' },
    );
  });

  it('offers a retry for a failure that knows which release it was', () => {
    assert.deepEqual(
      updateReminderFromStatus({
        state: 'error',
        currentVersion: '0.1.6',
        latestVersion: '0.1.7',
        message: 'ENOTFOUND',
        operation: 'download',
      }),
      { state: 'error', latestVersion: '0.1.7' },
    );
  });

  it('stays quiet when a failed check never learned of a release', () => {
    assert.equal(
      updateReminderFromStatus({
        state: 'error',
        currentVersion: '0.1.6',
        message: 'ENOTFOUND',
        operation: 'check',
      }),
      undefined,
    );
  });
});
