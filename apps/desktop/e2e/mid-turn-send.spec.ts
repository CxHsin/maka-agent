import { test, expect, COMPOSER_INPUT } from './fixtures';
import { FAKE_WAIT_FOR_STEERING_PROMPT } from '@maka/runtime';

/**
 * Mid-turn steering journey (#1954, review 4.1): while a turn runs, a
 * plain-text send must route through main's steering queue into the RUNNING
 * turn — never open a parallel root turn (the embedded backend is single
 * mutable state, so two concurrent sends stomp each other and one run fails).
 *
 * The fake backend's `FAKE_WAIT_FOR_STEERING_PROMPT` seam parks the first
 * turn before it streams any text, so the second message deterministically
 * lands mid-turn. The fake then acknowledges the steer inline
 * (`Acknowledged steering: …`) in the SAME reply — the tell that the steer
 * steered the running turn instead of starting a second one.
 */
test('a mid-turn send steers the running turn instead of opening a parallel one', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(FAKE_WAIT_FOR_STEERING_PROMPT);
  await composer.press('Enter');

  // Wait until the fake turn is actually running (its status flips while the
  // backend parks on the steering seam).
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const sessions = await window.maka.sessions.list();
        return sessions.some((session) => session.status === 'running');
      }),
    )
    .toBe(true);

  // Second plain-text send while the turn streams.
  await composer.fill('改成英文输出');
  await composer.press('Enter');

  // The steer was consumed by the RUNNING turn: the fake acknowledges it in
  // the same reply that echoes the original prompt.
  await expect(page.getByText(/Acknowledged steering: 改成英文输出/)).toBeVisible();

  // The steer renders in the transcript as the mid-turn injection badge.
  await expect(page.getByText('引导已注入')).toBeVisible();

  // Exactly one user message row (the original prompt) — the steer is not a
  // second turn, so no second prompt bubble.
  await expect(page.getByLabel('你发送的消息')).toHaveCount(1);

  // And exactly one run answered: the fake echoed the prompt once. A parallel
  // root turn would echo it a second time.
  await expect(
    page.getByText(new RegExp(`Fake backend received: ${FAKE_WAIT_FOR_STEERING_PROMPT}`)),
  ).toHaveCount(1);
});
