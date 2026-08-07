import { expect, test } from './fixtures.js';

/**
 * Settings · 偏好 · 项目 — the list, and the default-project control.
 *
 * The seeded catalog deliberately mixes an available project with one whose
 * folder is gone, because the unavailable row is where this page can lie
 * most easily: a "设为默认" that looked live on a folder the app cannot open
 * would set a default that breaks every new conversation.
 */
test('the projects page lists the catalog and moves the default between rows', async ({
  settingsProjectsWindow: page,
}) => {
  await page
    .getByRole('navigation', { name: /设置分组|Settings sections/ })
    .getByRole('button', { name: /项目|Projects/, exact: true })
    .click();

  const main = page.getByRole('main', { name: /设置内容|Settings content/ });
  // Exact match: each project's folder name also appears inside its own path,
  // so a substring lookup matches the name and the mono line both.
  await expect(main.getByText('maka-agent', { exact: true })).toBeVisible();
  await expect(main.getByText('astryx-design-system', { exact: true })).toBeVisible();

  // The row whose folder was never created reports that, instead of showing a
  // path it cannot open.
  await expect(main.getByText('retired-prototype', { exact: true })).toBeVisible();
  await expect(main.getByText('目录不可用').first()).toBeVisible();

  // No default configured yet: every row offers to become one.
  await expect(main.getByText('默认', { exact: true })).toHaveCount(0);

  const setDefaultButtons = main.getByRole('button', { name: '设为默认' });
  const enabled: number[] = [];
  for (let index = 0; index < (await setDefaultButtons.count()); index += 1) {
    if (await setDefaultButtons.nth(index).isEnabled()) enabled.push(index);
  }
  // An unavailable project cannot be made the default, and the disabled
  // control says why rather than leaving the user to guess.
  expect(enabled.length).toBeGreaterThan(0);
  const disabled = setDefaultButtons.nth(
    [...Array(await setDefaultButtons.count()).keys()].find((i) => !enabled.includes(i)) ?? 0,
  );
  await expect(disabled).toBeDisabled();
  // Astryx surfaces a Button tooltip through `aria-describedby`, not `title`,
  // so read the element it points at — asserting on `title` passed vacuously
  // against an empty string.
  const describedText = await disabled.evaluate((el) => {
    const id = el.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? '') : '';
  });
  expect(describedText).toContain('目录不可用');

  await setDefaultButtons.nth(enabled[0]).click();

  // The chosen row swaps its button for the Badge, and it persists.
  await expect(main.getByText('默认', { exact: true })).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.maka.settings.get().then((value) => value.projects.defaultProjectId),
      ),
    )
    .not.toBe(undefined);

  // Exactly one default at a time: setting another moves it rather than
  // adding a second.
  const remaining = main.getByRole('button', { name: '设为默认' });
  const stillEnabled: number[] = [];
  for (let index = 0; index < (await remaining.count()); index += 1) {
    if (await remaining.nth(index).isEnabled()) stillEnabled.push(index);
  }
  if (stillEnabled.length > 0) {
    await remaining.nth(stillEnabled[0]).click();
    await expect(main.getByText('默认', { exact: true })).toHaveCount(1);
  }
});
