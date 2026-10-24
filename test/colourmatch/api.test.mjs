import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, KEEPALIVE_MAX_BYTES } from '../../games/colourmatch/play/web/api.js';

const GAME_ID = '0b5f6c7a-1111-4222-8333-444455556666';
const SAVED = { gameId: GAME_ID, score: 10, roundsReached: 1, correct: 1, turns: 1, bestToday: 10 };

test('a save goes as keepalive while its body is under the cap, so leaving mid-save keeps it, and a bigger one goes as a plain request', async () => {
  const sent = [];
  const api = createApi({ put: async (path, body, options) => (sent.push({ path, options }), SAVED) });
  await api.save(GAME_ID, { turns: ['x'.repeat(KEEPALIVE_MAX_BYTES - 100)] });
  await api.save(GAME_ID, { turns: ['x'.repeat(KEEPALIVE_MAX_BYTES)] });
  assert.deepEqual(sent, [
    { path: `games/${GAME_ID}`, options: { keepalive: true } },
    { path: `games/${GAME_ID}`, options: undefined },
  ]);
});
