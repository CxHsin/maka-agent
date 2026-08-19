import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { test, expect, COMPOSER_INPUT } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The active-offer lifecycle for the composer's inline completion.
 *
 * This lives here rather than in the Storybook play function on purpose: the
 * render smoke opens stories in embedded mode, which disables autoplay
 * (FIDELITY.md), so a story can only prove that the composer mounts. Every
 * assertion below is about a keystroke, a caret, a focus change or a layout —
 * none of which that lane executes.
 *
 * History is seeded by sending real messages rather than by writing
 * `maka-input-history` directly: the entries are owned by `useComposerHistory`,
 * which reads storage once at mount and thereafter follows the module's own
 * writes, so a test that poked at the key would be seeding a list nobody holds.
 */

const OFFER = '[data-astryx-inline-completion]';

/** The draft as the composer sees it — the offer is in the editable but not in the value. */
async function draft(page: Page): Promise<string> {
  return page.locator(COMPOSER_INPUT).evaluate((editable) => {
    const clone = editable.cloneNode(true) as HTMLElement;
    for (const offer of Array.from(clone.querySelectorAll('[data-astryx-inline-completion]'))) {
      offer.remove();
    }
    return clone.textContent ?? '';
  });
}

/**
 * Type into the composer once it is actually ready to receive it.
 *
 * The first send creates a session and the shell re-keys the composer, so a
 * click-and-type issued straight after a settled turn can land on the element
 * being replaced and be dropped. Asserting focus first, and the draft after,
 * turns that race into a legible failure instead of a mysterious missing offer.
 */
async function typeDraft(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.pressSequentially(text);
  await expect.poll(() => draft(page)).toBe(text);
}

/** Send `text` so it enters prompt history through the path the product uses. */
async function sendAndSettle(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  // Settle on the reply landing in the transcript, not on the Stop button
  // going away: the first send also creates the session and re-keys the
  // composer, and the button disappears before that has finished — typing into
  // the gap is dropped on the element being replaced.
  await expect(page.getByText(`Fake backend received: ${text}`.slice(0, 40))).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: 30_000 });
}

test('a visible offer completes on Tab and never reaches the value before it', async ({
  window: page,
}) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '帮我把');

  const offer = page.locator(OFFER);
  await expect(offer).toHaveCount(1);
  // Offered, not committed: together they read as the recalled prompt, but the
  // value still holds only what was typed.
  await expect(offer).toHaveText(recalled.slice('帮我把'.length));
  expect(await draft(page)).toBe('帮我把');

  await composer.press('Tab');
  await expect(offer).toHaveCount(0);
  expect(await draft(page)).toBe(recalled);
  // Focus stays in the field so the next keystroke keeps typing.
  await expect(composer).toBeFocused();
});

test('an offer that does not fit the field is withdrawn and leaves Tab alone', async ({
  window: page,
}) => {
  // Long enough to lay out past `maxRows`, which is exactly the case where the
  // preview and the insertion used to disagree: the tail is unreadable while
  // Tab would still commit all of it.
  const long = `请审查这个实现，逐条说明：${'键盘路由、输入法、换行、滚动、焦点与撤销栈各自的边界条件；'.repeat(40)}`;
  await sendAndSettle(page, long);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '请审查这个');

  // Withdrawn rather than clipped: nothing is offered at all.
  await expect(page.locator(OFFER)).toHaveCount(0);
  await composer.press('Tab');
  expect(await draft(page)).toBe('请审查这个');
});

test('the offer follows focus and the caret without a render', async ({ window: page }) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '帮我把');
  await expect(page.locator(OFFER)).toHaveCount(1);

  // Blur withdraws, refocus reconciles. Neither fires a render, so an offer
  // that only reappeared on the next keystroke would fail here.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(page.locator(OFFER)).toHaveCount(0);
  await composer.click();
  await expect(page.locator(OFFER)).toHaveCount(1);

  // A caret that leaves the end takes the offer with it, and Tab is ordinary
  // again — the case where a stale offer used to splice itself mid-draft.
  await composer.press('ArrowLeft');
  await expect(page.locator(OFFER)).toHaveCount(0);
  await composer.press('Tab');
  expect(await draft(page)).toBe('帮我把');
});

test('a composing Tab reaches the IME instead of committing the offer', async ({
  window: page,
}) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '帮我把');
  await expect(page.locator(OFFER)).toHaveCount(1);

  const prevented = await composer.evaluate((editable) => {
    editable.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    editable.dispatchEvent(tab);
    return tab.defaultPrevented;
  });

  // The offer goes at `compositionstart`, and the key is left for the IME.
  await expect(page.locator(OFFER)).toHaveCount(0);
  expect(prevented).toBe(false);
  expect(await draft(page)).toBe('帮我把');
});

test('an open trigger menu keeps Tab for itself', async ({ window: page }) => {
  await sendAndSettle(page, '/review 这段实现有没有问题');

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '/rev');
  // The menu owns the caret and Tab while it is open, so nothing is offered
  // beside it even though history would otherwise complete this draft.
  await expect(composer).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator(OFFER)).toHaveCount(0);

  await composer.press('Escape');
  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  // With the menu gone the same draft completes, which is what makes the
  // absence above about ownership rather than about the matcher.
  await expect(page.locator(OFFER)).toHaveCount(1);
});

test('Escape stops a streaming turn on the first press even with an offer up', async ({
  window: page,
}) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.click();
  await composer.fill(FAKE_HOLD_OPEN_PROMPT);
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible({ timeout: 30_000 });

  // An offer is up while the turn runs — the case where the input used to
  // swallow Escape and leave the interrupt to a second press.
  await typeDraft(page, '帮我把');
  await expect(page.locator(OFFER)).toHaveCount(1);

  await composer.press('Escape');
  await expect(page.locator(OFFER)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: 30_000 });
});

test('only a bare Tab commits: ordinary typing and Shift+Tab leave the offer uncommitted', async ({
  window: page,
}) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '帮我把');
  await expect(page.locator(OFFER)).toHaveCount(1);

  // Shift+Tab is back-tab, never an acceptance: the draft is untouched and the
  // key does its ordinary job of leaving the field.
  await composer.press('Shift+Tab');
  expect(await draft(page)).toBe('帮我把');
  await expect(composer).not.toBeFocused();

  // A printable key keeps typing. The offer may re-derive against the longer
  // draft, but nothing of it may have entered the value.
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.pressSequentially('这');
  expect(await draft(page)).toBe('帮我把这');
  expect(await draft(page)).not.toContain('composer');
});

test('accepting is one undoable transaction: Tab, Undo, Redo', async ({ window: page }) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '帮我把');
  await expect(page.locator(OFFER)).toHaveCount(1);
  await composer.press('Tab');
  expect(await draft(page)).toBe(recalled);

  // Undo must take back the completion and nothing else. A scripted range
  // mutation is not on the contentEditable undo stack, so it used to leave the
  // suffix in place and eat the character typed before it instead.
  await composer.press('ControlOrMeta+z');
  await expect.poll(() => draft(page)).toBe('帮我把');

  await composer.press('ControlOrMeta+Shift+z');
  await expect.poll(() => draft(page)).toBe(recalled);
});

test('a programmatic draft replacement invalidates a live offer', async ({ window: page }) => {
  const recalled = '帮我把 composer 的样式再收紧一点';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '帮我把');
  await expect(page.locator(OFFER)).toHaveCount(1);

  // The host replaces the draft out from under the offer — a session switch or
  // a prompt insertion. The offer was derived from text the editor no longer
  // holds, so it must not survive, and Tab must not splice it into what
  // replaced it.
  await composer.fill('完全不同的另一段草稿');
  await expect.poll(() => draft(page)).toBe('完全不同的另一段草稿');
  await expect(page.locator(OFFER)).toHaveCount(0);

  await composer.press('Tab');
  expect(await draft(page)).toBe('完全不同的另一段草稿');
});

test('a multi-line completion keeps its line breaks through Tab, Undo and Redo', async ({
  window: page,
}) => {
  // Two lines, because a `\n` handed to `insertText` becomes a wrapping div in
  // Chromium that the serializer reads without restoring the break — the
  // prompt used to come back joined into one line.
  const recalled = '第一行的要求\n第二行的补充说明';
  await sendAndSettle(page, recalled);

  const composer = page.locator(COMPOSER_INPUT);
  await typeDraft(page, '第一行的');
  await expect(page.locator(OFFER)).toHaveCount(1);

  await composer.press('Tab');
  // Exact value, newline included: the contract is that Tab commits precisely
  // what the offer showed.
  await expect.poll(() => draft(page)).toBe(recalled);

  // And still one undo entry, even though it took several editing commands.
  await composer.press('ControlOrMeta+z');
  await expect.poll(() => draft(page)).toBe('第一行的');
  await composer.press('ControlOrMeta+Shift+z');
  await expect.poll(() => draft(page)).toBe(recalled);
});
