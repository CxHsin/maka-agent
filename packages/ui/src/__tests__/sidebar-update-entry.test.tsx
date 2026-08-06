import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { SessionListPanel } from '../session-list-panel.js';
import type { SidebarUpdateReminder } from '../session-sidebar-nav.js';

function renderSidebar(options: {
  updateReminder?: SidebarUpdateReminder;
  collapsed?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <SessionListPanel
        collapsed={options.collapsed}
        selection={{ section: 'sessions', filter: 'chats' }}
        sessions={[]}
        updateReminder={options.updateReminder}
        onSelectSession={() => {}}
        onSelect={() => {}}
        onOpenSettings={() => {}}
        onOpenUpdate={() => {}}
        onNew={() => {}}
      />
    </LocaleProvider>,
  );
}

/**
 * The deepest run of unclosed <button> tags. The update action is a button and
 * it sits beside a SideNavItem that is also a button, so the only structurally
 * invalid way to build this row — nesting one inside the other, which is what
 * `endContent` would do — has to be something a test can see.
 */
function maxButtonDepth(markup: string): number {
  let depth = 0;
  let deepest = 0;
  for (const [tag] of markup.matchAll(/<button\b|<\/button>/g)) {
    if (tag === '</button>') depth -= 1;
    else deepest = Math.max(deepest, (depth += 1));
  }
  return deepest;
}

describe('sidebar update entry', () => {
  it('shows nothing while the update needs no one', () => {
    const markup = renderSidebar();

    assert.match(markup, /maka-sidebar-footer-row/);
    assert.doesNotMatch(markup, /maka-sidebar-update-button/);
    assert.match(markup, />设置</);
  });

  it('names the whole decision on the downloaded action, not a bare verb', () => {
    const markup = renderSidebar({
      updateReminder: { state: 'downloaded', latestVersion: '0.1.7' },
    });

    assert.match(markup, /maka-sidebar-update-button/);
    assert.match(markup, /aria-label="新版本 0\.1\.7 已下载，重启后安装"/);
  });

  it('keeps the failed update distinguishable from the ready one', () => {
    const markup = renderSidebar({
      updateReminder: { state: 'error', latestVersion: '0.1.7' },
    });

    assert.match(markup, /aria-label="新版本 0\.1\.7 更新失败，点击重试或手动下载"/);
    assert.doesNotMatch(markup, /lucide-download/);
  });

  it('carries the download glyph only when the update is ready to install', () => {
    assert.match(
      renderSidebar({ updateReminder: { state: 'downloaded', latestVersion: '0.1.7' } }),
      /lucide-download/,
    );
  });

  it('keeps the update action a sibling of settings, never nested in it', () => {
    for (const collapsed of [false, true]) {
      const markup = renderSidebar({
        collapsed,
        updateReminder: { state: 'downloaded', latestVersion: '0.1.7' },
      });

      assert.equal(
        maxButtonDepth(markup),
        1,
        `collapsed=${collapsed}: the update action must not render inside another button`,
      );
      assert.ok(
        markup.indexOf('>设置<') < markup.indexOf('maka-sidebar-update-button'),
        `collapsed=${collapsed}: settings leads the row`,
      );
    }
  });

  it('survives the collapsed rail instead of being dropped with the labels', () => {
    const markup = renderSidebar({
      collapsed: true,
      updateReminder: { state: 'downloaded', latestVersion: '0.1.7' },
    });

    assert.match(markup, /maka-sidebar-update-button/);
  });
});
