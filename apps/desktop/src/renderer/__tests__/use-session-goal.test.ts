import assert from 'node:assert/strict';
import test from 'node:test';
import { isGoalArmedAwaitingFirstTurn } from '../use-session-goal.js';

test('only the Turn bound to an armed Goal ends its awaiting phase', () => {
  assert.equal(isGoalArmedAwaitingFirstTurn({ armedAt: 1 }), true);
  assert.equal(
    isGoalArmedAwaitingFirstTurn({ armedAt: 1, boundTurnId: 'goal-turn-1' }),
    false,
  );
  assert.equal(isGoalArmedAwaitingFirstTurn({}), false);
});
