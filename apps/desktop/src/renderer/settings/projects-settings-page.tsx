import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, ProjectRecord, UpdateAppSettingsResult } from '@maka/core';
import {
  Badge,
  Button,
  EmptyState,
  MoreMenu,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { SettingsExpandableRow } from './settings-expandable-row';
import { useKeyedActionGuard } from './use-action-guard';

/**
 * Settings · 偏好 · 项目 — the management view of the project catalog, and the
 * home of the default project.
 *
 * Project management used to be scattered across the surfaces that happened to
 * need it: adding lived in the composer, renaming in the sidebar row menu, and
 * "which project does a new chat open in" was not a setting at all — it was
 * whichever project you used last, decided implicitly by
 * `project-root-controller` and invisible to the user.
 *
 * This page does not own a second copy of that data. The catalog behind
 * `window.maka.projects` is the same one the sidebar groups by and the composer
 * picker chooses from; what this page adds is a preference stored beside it.
 */
export function ProjectsSettingsPage(props: {
  settings: AppSettings;
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const actionGuard = useKeyedActionGuard<string>();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const reload = useCallback(async () => {
    const next = await window.maka.projects.list();
    if (mountedRef.current) setProjects(next);
  }, [mountedRef]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Archived projects are removed-from-Maka, not deleted; they belong to the
  // restore path, not to a list whose whole purpose is "what can I open".
  const listed = projects.filter((project) => project.archivedAt === undefined);
  const defaultProjectId = props.settings.projects.defaultProjectId;
  // The stored id is a preference, not a guarantee: the project it names can be
  // archived or lose its folder afterwards. Saying so out loud beats silently
  // behaving like no default was ever set — a silent fallback is the same kind
  // of lie as a control that claims a state it does not have.
  const defaultResolves =
    defaultProjectId !== undefined &&
    listed.some((project) => project.id === defaultProjectId && project.available);

  async function runRowAction(key: string, action: () => Promise<void>, failure: string) {
    const release = actionGuard.begin(key);
    if (!release) return;
    try {
      await action();
      await reload();
    } catch (error) {
      if (mountedRef.current) toast.error(failure, settingsActionErrorMessage(error, locale));
    } finally {
      release();
    }
  }

  async function setDefault(projectId: string | undefined) {
    await props.onUpdate({ projects: { defaultProjectId: projectId } });
  }

  return (
    <SettingsPage as="section" aria-label={copy.section}>
      {/* No section title: the page header already says 项目, and repeating it
          straight above the rows is the same duplicate-heading noise we
          removed from the skills page. The rule this page exists for lives in
          the page subtitle; the section keeps only its action. */}
      <SettingsSection
        description={
          defaultProjectId !== undefined && !defaultResolves
            ? `${copy.sectionHelp} ${copy.defaultUnavailable}`
            : copy.sectionHelp
        }
        action={
          <Button
            variant="secondary"
            size="sm"
            label={copy.addProject}
            clickAction={async () => {
              const result = await window.maka.projects.add();
              if (result.ok) await reload();
            }}
          />
        }
      >
        {listed.length === 0 ? (
          <EmptyState title={copy.emptyTitle} description={copy.emptyBody} />
        ) : (
          listed.map((project) => {
            const isDefault = project.id === defaultProjectId;
            const endCluster = (
                  <>
                    {isDefault ? (
                      <Badge variant="neutral" label={copy.defaultBadge} />
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        label={copy.setDefault}
                        // A disabled control explains its own disabling:
                        // the enabled tooltip answers "what does this do",
                        // which is exactly the question the user is NOT
                        // asking once the button is greyed out.
                        tooltip={
                          project.available
                            ? copy.setDefaultTitle
                            : copy.setDefaultDisabledTitle
                        }
                        isDisabled={!project.available}
                        clickAction={() =>
                          runRowAction(
                            `default:${project.id}`,
                            () => setDefault(project.id),
                            copy.setDefaultFailed,
                          )
                        }
                      />
                    )}
                    <MoreMenu
                      label={copy.moreActions(project.name)}
                      size="sm"
                      items={[
                        ...(isDefault
                          ? [{
                              label: copy.clearDefault,
                              onClick: () =>
                                void runRowAction(
                                  `default:${project.id}`,
                                  () => setDefault(undefined),
                                  copy.setDefaultFailed,
                                ),
                            }]
                          : []),
                        {
                          label: copy.rename,
                          onClick: () => {
                            setDraftName(project.name);
                            setRenamingId(project.id);
                          },
                        },
                        {
                          label: copy.openFolder,
                          // Only offered when the catalog still vouches for the
                          // folder; a menu entry that always fails is worse
                          // than one that is not there.
                          isDisabled: !project.available,
                          onClick: () =>
                            void runRowAction(
                              `reveal:${project.id}`,
                              async () => {
                                const result = await window.maka.projects.reveal(project.id);
                                if (!result.ok) throw new Error(result.reason);
                              },
                              copy.openFolderFailed,
                            ),
                        },
                        {
                          label: copy.remove,
                          onClick: () =>
                            void runRowAction(
                              `remove:${project.id}`,
                              async () => {
                                const ok = await toast.confirm({
                                  title: copy.removeConfirmTitle,
                                  description: copy.removeConfirmBody,
                                  confirmLabel: copy.removeConfirm,
                                  cancelLabel: copy.removeCancel,
                                  destructive: true,
                                });
                                if (!ok) return;
                                await window.maka.projects.archive(project.id);
                                // Removing the default leaves the preference
                                // pointing at nothing; clear it in the same
                                // action rather than leaving a dangling id.
                                if (isDefault) await setDefault(undefined);
                              },
                              copy.actionFailed,
                            ),
                        },
                      ]}
                    />
                  </>
            );

            // Renaming swaps the row for the shared expandable editor, which
            // owns the focus move in and back out. The end cluster rides along
            // so the row keeps its default state and menu while collapsed —
            // rename is reached from that menu, not from a competing button.
            return (
              <SettingsExpandableRow
                key={project.id}
                label={project.name}
                value={
                  <code className="settingsReadOnlyValue" data-mono="true">
                    {project.preferredPath ?? copy.unavailable}
                  </code>
                }
                end={endCluster}
                isEditing={renamingId === project.id}
                canSave={draftName.trim() !== '' && draftName.trim() !== project.name}
                saveLabel={copy.save}
                cancelLabel={copy.cancel}
                onEdit={() => {
                  setDraftName(project.name);
                  setRenamingId(project.id);
                }}
                onCancel={() => setRenamingId(null)}
                onSave={async () => {
                  const next = draftName.trim();
                  if (next === '' || next === project.name) return;
                  await runRowAction(
                    `rename:${project.id}`,
                    async () => {
                      await window.maka.projects.rename(project.id, next);
                      setRenamingId(null);
                    },
                    copy.renameFailed,
                  );
                }}
              >
                <TextInput
                  type="text"
                  value={draftName}
                  onChange={(value) => setDraftName(value.slice(0, 80))}
                  label={copy.renameLabel}
                  isLabelHidden
                  width="100%"
                />
              </SettingsExpandableRow>
            );
          })
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
