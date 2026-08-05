/**
 * Workspace picker (issue #1044) — the control that decides which project a
 * NEW chat starts in.
 *
 * It sits at the end of the composer footer's send-context group — after the
 * model and thinking pickers — and only while no session owns the composer. The
 * project is a session-creation parameter: it is fixed the moment the first
 * message creates the session, and no other entry point changes it afterwards.
 *
 * That group is the right company for it: model, thinking level and permission
 * mode are all parameters of the send about to happen, and so is the project.
 * Last in the group is what makes its shorter life cheap — when the first
 * message unmounts it, nothing to its left moves.
 *
 * Two other homes were tried. The empty-chat HERO, under the greeting, fixed
 * the lifetime but floated the control in the gap between the greeting and the
 * card, belonging to neither. The composer's HEADER row above the input kept it
 * on the card, but grew the card by a whole row for the draft state alone —
 * a layout jump on every new task, paid to avoid one chip disappearing from the
 * end of a row.
 *
 * Built on the composer footer's ghost-button DropdownMenu family — the same
 * primitive as the model, thinking, ＋ and permission controls beside it —
 * because this row is a toolbar, and toolbar members share one Button chrome:
 * resting, hover, focus, and disabled states plus the tooltip all derive from
 * Astryx Button instead of a product overlay restyling a form field. It used
 * to be an Astryx Selector (rebuilt onto it in #2217, when the model picker
 * beside it was one too); #2230 moved the model and thinking pickers onto the
 * ghost-menu family, and this control followed once the row had one toolbar
 * convention left. Search died with the Selector, matching the model menu's
 * precedent — the panel keeps its 300px scroll and Astryx first-character
 * typeahead. The trigger's tooltip came back with the Button: Selector had no
 * slot for it, so the current git branch rode in the accessible name alone.
 *
 * The current git branch rides in the trigger's tooltip and accessible name
 * only. Switching branches is the agent's job — see the commit that removed
 * the branch picker.
 *
 * Purely presentational: a value control fed by host-injected props.
 */

import type { ProjectRecord } from '@maka/core';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { useMemo } from 'react';
import { AlertTriangle, Check, FolderOpen, Plus, X } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface WorkspacePickerModel {
  label?: string;
  branch?: string | null;
  pending?: boolean;
  projects: readonly ProjectRecord[];
  selectedProjectId?: string | null;
  onAdd(): void;
  onSelectProject(projectId: string): void;
  onRelink(projectId: string): void;
  onSelectNoProject(): void;
}

export function WorkspacePicker(props: { workspacePicker: WorkspacePickerModel }) {
  const wp = props.workspacePicker;
  const copy = getConversationCopy(useUiLocale()).workspace;

  const unavailable = useMemo(
    () => new Set(wp.projects.filter((project) => !project.available).map((project) => project.id)),
    [wp.projects],
  );

  // A project switch is in flight: lock the trigger and every row, like the
  // model switcher beside it — an aria-disabled DropdownMenu trigger still
  // opens on ArrowDown, so the lock must ride on the items too.
  const locked = wp.pending === true;

  return (
    <DropdownMenu
      placement="above"
      hasChevron={false}
      className="maka-composer-quiet-menu"
      button={{
        label: wp.label ?? copy.choose,
        icon: <FolderOpen size={13} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        isDisabled: locked,
        isLoading: locked,
        tooltip: copy.chooseTitle(wp.branch ?? undefined),
        className: 'maka-workspace-picker',
        'aria-label': copy.chooseAriaLabel(wp.label ?? copy.current, wp.branch ?? undefined),
      }}
    >
      {wp.projects.map((project) => {
        const missing = unavailable.has(project.id);
        return (
          <DropdownMenuItem
            key={project.id}
            icon={
              missing ? (
                <AlertTriangle size={13} aria-hidden="true" />
              ) : (
                <FolderOpen size={13} aria-hidden="true" />
              )
            }
            label={project.name}
            // A project whose directory has moved cannot be selected until it
            // is pointed at a path again, so its row relinks instead of
            // switching. The current project wears the same plain check as the
            // model and thinking menus' current values.
            endContent={
              missing ? (
                <span className="maka-workspace-picker-status">{copy.relink}</span>
              ) : project.id === wp.selectedProjectId ? (
                <Check size={13} aria-hidden="true" />
              ) : undefined
            }
            isDisabled={locked}
            onClick={() => {
              if (missing) wp.onRelink(project.id);
              else wp.onSelectProject(project.id);
            }}
          />
        );
      })}
      {/* Catalogue first, then the two actions — pinned to the menu's bottom
          edge while only the catalogue scrolls, so "add a project" never falls
          under the fold on a long list. DropdownMenu scrolls its whole list as
          one region and has no footer slot, so the pinning is done in CSS;
          what makes it one rule instead of a stack of them is the group, which
          renders as a single `role="group"` box. `composer.css` sticks that
          box, and its height is whatever it actually contains.

          Both actions carry an icon so every row shares one text axis. Without
          them the two labels started at the icon column while the projects'
          text started past it, which read as a broken list rather than as a
          separate group. The × also says what its row means: not using a
          project is a deliberate way to work, not a missing setting. */}
      <div role="group" className="maka-workspace-picker-actions">
        <DropdownMenuItem
          icon={<Plus size={13} aria-hidden="true" />}
          label={copy.addProject}
          isDisabled={locked}
          onClick={() => {
            wp.onAdd();
          }}
        />
        <DropdownMenuItem
          icon={<X size={13} aria-hidden="true" />}
          label={copy.noProject}
          endContent={wp.selectedProjectId === null ? <Check size={13} aria-hidden="true" /> : undefined}
          isDisabled={locked}
          onClick={() => {
            wp.onSelectNoProject();
          }}
        />
      </div>
    </DropdownMenu>
  );
}
