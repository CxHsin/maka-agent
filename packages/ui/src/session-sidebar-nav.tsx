import type { PlanReminder } from '@maka/core';
import { AlertCircle, ArrowUp, Blocks, Settings, SquarePen, Timer } from './icons.js';
import type { NavModuleMemory, NavSelection } from './nav-selection.js';
import { useUiLocale } from './locale-context.js';
import { getShellControlsCopy } from './shell-controls-copy.js';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SideNavItem, SideNavSection, useSideNavCollapse } from '@astryxdesign/core/SideNav';
import { Tooltip } from '@astryxdesign/core/Tooltip';

export function SessionSidebarNav(props: {
  selection: NavSelection;
  planReminders?: PlanReminder[];
  moduleMemory?: NavModuleMemory;
  onSelect(selection: NavSelection): void;
  onNew(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const extensionsActive = props.selection.section === 'extensions';
  const automationsActive = props.selection.section === 'automations';
  const moduleMemory = props.moduleMemory ?? { extensions: 'skills', automations: 'plan-reminders' };
  const activePlanReminderCount = (props.planReminders ?? []).filter(
    (reminder) => reminder.status !== 'completed',
  ).length;

  // Always SideNavItem — expanded and collapsed. Astryx collapse context turns
  // these into icon-only slots without remounting a different control recipe
  // (which read as a squeeze when the rail previously swapped to IconButton).
  //
  // SideNavSection, like the footer below, rather than a bare fragment in a
  // product div: the section is what owns the space BETWEEN nav rows
  // (`items` → --spacing-0-5). Handed to `topContent` as a plain div these three
  // were the only group on the rail outside that authority, so they stacked
  // edge to edge — invisible expanded, where the label separates the rows, and
  // plainly three-icons-as-one-slab at 48px. The header is hidden because the
  // rail landmark already names the panel; the title stays for a11y.
  return (
    <SideNavSection title={copy.mainLabel} isHeaderHidden className="maka-session-panel-top">
      <SideNavItem
        label={copy.newTask}
        icon={SquarePen}
        size="md"
        onClick={props.onNew}
        endContent={<kbd className="maka-nav-kbd" aria-hidden="true">⌘ N</kbd>}
      />
      <SideNavItem
        label={copy.extensions}
        icon={Blocks}
        size="md"
        isSelected={extensionsActive}
        onClick={() => props.onSelect({ section: 'extensions', module: moduleMemory.extensions })}
      />
      <SideNavItem
        label={activePlanReminderCount > 0
          ? copy.pendingReminders(activePlanReminderCount)
          : copy.automations}
        icon={Timer}
        size="md"
        isSelected={automationsActive}
        onClick={() => props.onSelect({ section: 'automations', module: moduleMemory.automations })}
      />
    </SideNavSection>
  );
}

/**
 * Only the two states that need the user.
 *
 * The updater runs with `autoDownload = true` and `autoInstallOnAppQuit =
 * false` (app-update-service.ts), so discovery and download ask nothing of
 * anyone — the shell drops `available` and `downloading` before they reach
 * here rather than the footer rendering a control for them. That is what the
 * old chip did: it sat in the footer through the entire silent phase showing a
 * progress bar whose own percentage label the bar painted over.
 */
export type SidebarUpdateReminder = {
  state: 'downloaded' | 'error';
  latestVersion: string;
};

export function SessionSidebarFooter(props: {
  updateReminder?: SidebarUpdateReminder;
  onOpenSettings(): void;
  onOpenUpdate?(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellControlsCopy(locale).navigation;
  const { isCollapsed } = useSideNavCollapse();
  const reminder = props.updateReminder;
  const updateAction = reminder && props.onOpenUpdate
    ? {
        label: reminder.state === 'downloaded' ? copy.restartUpdate : copy.retryUpdate,
        title: reminder.state === 'downloaded'
          ? copy.updateDownloaded(reminder.latestVersion)
          : copy.updateFailed(reminder.latestVersion),
        // A bare arrow, not CircleArrowUp: the button is a circle, so a ringed
        // glyph draws a second concentric one and the two blur together at
        // 16px. The alert glyph keeps its ring — it has no round container to
        // borrow, and the ring is what makes it read as a warning.
        icon: reminder.state === 'downloaded' ? ArrowUp : AlertCircle,
        onClick: props.onOpenUpdate,
      }
    : undefined;

  // Settings and the update action are SIBLINGS in a row, not one nested in
  // the other: SideNavItem renders `endContent` inside its own <button>, and
  // an <button> cannot contain a second one. This is the same split-action
  // shape SideNavItem itself falls back to when a row carries both a primary
  // action and a collapse toggle ("<div> row with <a> + <button> as siblings"
  // — SideNavItem.tsx), for exactly this reason.
  //
  // Collapsed, the rail is 48px and the label is gone; two controls cannot sit
  // side by side there, so the row stacks and the update button keeps its own
  // slot under settings instead of being dropped.
  return (
    <SideNavSection title={copy.settings} isHeaderHidden className="maka-session-panel-footer">
      <div className="maka-sidebar-footer-row" data-collapsed={isCollapsed ? 'true' : 'false'}>
        <div className="maka-sidebar-footer-row-primary">
          <SideNavItem
            label={copy.settings}
            icon={Settings}
            size="md"
            onClick={props.onOpenSettings}
          />
        </div>
        {updateAction && (
          <Tooltip content={updateAction.title}>
            <IconButton
              className="maka-sidebar-update-button"
              label={updateAction.label}
              icon={<Icon icon={updateAction.icon} size="sm" />}
              // `primary` resolves to the theme's own accent, so the button
              // follows Catppuccin and Tokyo Night instead of a hard-coded
              // blue. The previous chip reached for `--control` through
              // product CSS and had to hand-compute every hover and pressed
              // state in oklch(); none of that is restated here.
              variant={reminder?.state === 'error' ? 'secondary' : 'primary'}
              // `sm` (28px) against the settings row's 32px: a filled button
              // at the row's own height fills it edge to edge and competes
              // with it. Two pixels of air on each side is what makes it read
              // as something ON the row rather than a second row.
              size="sm"
              onClick={updateAction.onClick}
            />
          </Tooltip>
        )}
      </div>
    </SideNavSection>
  );
}
