import type { SidebarUpdateReminder } from '@maka/ui';
import type { AppUpdateStatus } from '../preload/bridge-contract.js';

/**
 * The single answer to "which update states need the user".
 *
 * The updater runs with `autoDownload = true` and `autoInstallOnAppQuit =
 * false` (app-update-service.ts), so `available` and `downloading` resolve
 * themselves and ask nothing of anyone; only `downloaded` (which needs a
 * restart) and `error` (which needs a retry) do. The footer used to carry a
 * control through all four, which meant it spent most of its visible life
 * asking for attention on behalf of a background download.
 *
 * This lives in one function rather than in the shell's render and its click
 * handler both, because two copies of that list are free to disagree — and the
 * one in the handler had already drifted into offering a retry for states that
 * can no longer reach it.
 */
export function updateReminderFromStatus(
  status: AppUpdateStatus | null,
): SidebarUpdateReminder | undefined {
  if (status?.state === 'downloaded') {
    return { state: 'downloaded', latestVersion: status.latestVersion };
  }
  // `error` is the one state whose `latestVersion` is optional: a check that
  // fails before it learns of a release has no version to name, and a reminder
  // that cannot say which update failed is not worth a button.
  if (status?.state === 'error' && status.latestVersion) {
    return { state: 'error', latestVersion: status.latestVersion };
  }
  return undefined;
}
