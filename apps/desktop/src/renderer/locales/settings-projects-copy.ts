import type { UiCatalog, UiLocale } from '@maka/core';

export type SettingsProjectsCopy = {
  section: string;
  sectionHelp: string;
  addProject: string;
  defaultBadge: string;
  setDefault: string;
  setDefaultTitle: string;
  /** Why the control is disabled — a disabled control must say so itself. */
  setDefaultDisabledTitle: string;
  setDefaultFailed: string;
  clearDefault: string;
  remove: string;
  removeConfirmTitle: string;
  removeConfirmBody: string;
  removeConfirm: string;
  removeCancel: string;
  actionFailed: string;
  unavailable: string;
  /** Shown when the configured default no longer names a usable project. */
  defaultUnavailable: string;
  emptyTitle: string;
  emptyBody: string;
  moreActions: string;
};

const SETTINGS_PROJECTS_COPY_BY_LOCALE = {
  zh: {
    section: '项目',
    // Says all three layers of the rule in one sentence, because a help line
    // that only mentions the default would leave the user guessing what
    // happens before they set one.
    sectionHelp: '新对话默认打开此项目；未设置时沿用上次使用的项目。任何对话都能在输入框旁临时切换。',
    addProject: '添加项目',
    defaultBadge: '默认',
    setDefault: '设为默认',
    setDefaultTitle: '新对话默认打开这个项目',
    setDefaultDisabledTitle: '目录不可用，无法设为默认',
    setDefaultFailed: '设置默认项目失败',
    clearDefault: '取消默认',
    remove: '从 Maka 移除',
    removeConfirmTitle: '从 Maka 移除这个项目？',
    // The one thing a user actually fears here, stated first and plainly.
    removeConfirmBody: '仅从 Maka 的项目列表移除，磁盘上的文件不受影响。该项目下已有的对话会移到"未归属"分组，不会被删除。',
    removeConfirm: '移除',
    removeCancel: '取消',
    actionFailed: '操作失败',
    unavailable: '目录不可用',
    defaultUnavailable: '原来的默认项目已不可用，新对话暂时沿用上次使用的项目。',
    emptyTitle: '还没有项目',
    emptyBody: '添加一个项目目录后，新对话就能默认从它打开，侧边栏也会按项目归类对话。',
    moreActions: '更多操作',
  },
  en: {
    section: 'Projects',
    sectionHelp:
      'New conversations open in the default project; without one, they reuse the project you last used. Any conversation can switch next to the input box.',
    addProject: 'Add project',
    defaultBadge: 'Default',
    setDefault: 'Set as default',
    setDefaultTitle: 'Open new conversations in this project',
    setDefaultDisabledTitle: 'The folder is unavailable, so this cannot be the default',
    setDefaultFailed: 'Could not set the default project',
    clearDefault: 'Clear default',
    remove: 'Remove from Maka',
    removeConfirmTitle: 'Remove this project from Maka?',
    removeConfirmBody:
      'This only removes it from Maka’s project list; the files on disk are untouched. Conversations under this project move to “Ungrouped” and are not deleted.',
    removeConfirm: 'Remove',
    removeCancel: 'Cancel',
    actionFailed: 'Action failed',
    unavailable: 'Folder unavailable',
    defaultUnavailable:
      'The default project is no longer available, so new conversations reuse the project you last used.',
    emptyTitle: 'No projects yet',
    emptyBody:
      'Add a project folder and new conversations can start in it, with the sidebar grouping conversations by project.',
    moreActions: 'More actions',
  },
} satisfies UiCatalog<SettingsProjectsCopy>;

export function getSettingsProjectsCopy(locale: UiLocale): SettingsProjectsCopy {
  return SETTINGS_PROJECTS_COPY_BY_LOCALE[locale];
}
