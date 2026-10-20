import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPractice, localDay, localRecord, practiceReducer, practiceView, sendable } from '../../games/letterjoin/play/web/practice.js';

const T0 = new Date(2026, 9, 17, 16, 0, 0).getTime();
const S = 1000;
const MIN = 60 * S;

/** Feeds events in order; each is [secondsAfterT0, event]. Returns the state after the last one. */
function play(steps, start = loaded()) {
  return steps.reduce((state, [at, event]) => practiceReducer(state, event, T0 + at * S), start);
}
function loaded({ minutes = 15, usedSeconds = 0, local = null, noticeDay = null, at = 0 } = {}) {
  return practiceReducer(initialPractice(T0 + at * S), { type: 'loaded', minutes, usedSeconds, local, noticeDay }, T0 + at * S);
}
const tick = { type: 'tick' };
const stroke = { type: 'strokeStart' };
const touch = { type: 'interaction' };
const view = practiceView;

test('0 minutes is off: nothing shows and strokes count nothing', () => {
  const state = play([[0, stroke], [10, touch], [20, tick]], loaded({ minutes: 0 }));
  assert.deepEqual(view(state), { state: 'off', secondsLeft: 0, notice: false });
});

test('the clock waits for the first stroke; browsing and tapping do not start it', () => {
  const before = play([[5, touch], [40, touch], [100, tick]]);
  assert.deepEqual(view(before), { state: 'waiting', secondsLeft: 15 * 60, notice: false });
  const after = play([[5, touch], [100, stroke], [110, tick]]);
  assert.equal(view(after).state, 'running');
  assert.equal(view(after).secondsLeft, 15 * 60 - 10);
});

test('idle: still running at 29 s, paused at exactly 30 s and at 31 s, with the 30 idle seconds counted', () => {
  const at = (s) => play([[0, stroke], [s, tick]]);
  assert.equal(view(at(29)).state, 'running');
  assert.equal(view(at(29)).secondsLeft, 15 * 60 - 29);
  assert.equal(view(at(30)).state, 'paused');
  assert.equal(view(at(30)).secondsLeft, 15 * 60 - 30);
  assert.equal(view(at(31)).state, 'paused');
  assert.equal(view(at(31)).secondsLeft, 15 * 60 - 30);
  assert.equal(view(at(500)).secondsLeft, 15 * 60 - 30, 'a long idle still counts only 30 s');
});

test('any interaction keeps it running past 30 s and resumes it after a pause', () => {
  const kept = play([[0, stroke], [20, touch], [45, tick]]);
  assert.equal(view(kept).state, 'running');
  assert.equal(view(kept).secondsLeft, 15 * 60 - 45);
  const resumed = play([[0, stroke], [100, tick], [200, touch], [210, tick]]);
  assert.equal(view(resumed).state, 'running');
  assert.equal(view(resumed).secondsLeft, 15 * 60 - 30 - 10, 'the gap between pause and resume is not counted');
});

test('hiding the page pauses at once; coming back stays paused until an interaction', () => {
  const hidden = play([[0, stroke], [10, { type: 'hidden' }], [25, tick]]);
  assert.deepEqual(view(hidden), { state: 'paused', secondsLeft: 15 * 60 - 10, notice: false });
  const back = play([[60, { type: 'visible' }], [70, tick]], hidden);
  assert.equal(view(back).state, 'paused');
  assert.equal(view(back).secondsLeft, 15 * 60 - 10);
  const touched = play([[80, touch], [90, tick]], back);
  assert.equal(view(touched).state, 'running');
  assert.equal(view(touched).secondsLeft, 15 * 60 - 20);
});

test('reaching the limit is done once: the notice is asked for until it is shown, then never again that day', () => {
  let state = loaded({ minutes: 1 });
  state = play([[0, stroke], [20, touch], [40, touch], [59, tick]], state);
  assert.equal(view(state).state, 'running');
  state = play([[60, tick]], state);
  assert.deepEqual(view(state), { state: 'done', secondsLeft: 0, notice: true });
  assert.equal(state.usedMs, MIN, 'never counts past the limit');
  state = play([[61, { type: 'noticeShown' }]], state);
  assert.equal(view(state).notice, false);
  state = play([[62, stroke], [70, touch], [200, tick]], state);
  assert.deepEqual(view(state), { state: 'done', secondsLeft: 0, notice: false });
  assert.equal(state.usedMs, MIN);
  const reloaded = loaded({ minutes: 1, usedSeconds: 60, noticeDay: localDay(T0), at: 300 });
  assert.equal(view(reloaded).notice, false, 'a reload the same day does not show it again');
});

test('local midnight while running starts a new day that waits for a stroke', () => {
  const late = new Date(2026, 9, 17, 23, 59, 50).getTime();
  let state = practiceReducer(initialPractice(late), { type: 'loaded', minutes: 15, usedSeconds: 600, local: null, noticeDay: null }, late);
  state = practiceReducer(state, stroke, late);
  state = practiceReducer(state, tick, late + 5 * S);
  assert.equal(view(state).secondsLeft, 5 * 60 - 5);
  state = practiceReducer(state, tick, late + 12 * S);
  assert.equal(state.day, '2026-10-18');
  assert.deepEqual(view(state), { state: 'waiting', secondsLeft: 15 * 60, notice: false });
  assert.equal(state.unsentMs, 0);
  state = practiceReducer(state, stroke, late + 20 * S);
  state = practiceReducer(state, tick, late + 25 * S);
  assert.equal(view(state).secondsLeft, 15 * 60 - 5);
});

test('a clock that jumps forward adds at most the idle allowance, and one that jumps back adds nothing', () => {
  const forward = play([[0, stroke], [10, touch], [10 + 3 * 3600, touch], [10 + 3 * 3600 + 5, tick]]);
  assert.equal(view(forward).secondsLeft, 15 * 60 - 10 - 30 - 5);
  const back = play([[0, stroke], [10, touch], [-3600, tick], [-3595, tick]]);
  assert.equal(view(back).secondsLeft, 15 * 60 - 10 - 5);
  assert.equal(view(back).state, 'running');
  const backThenIdle = play([[0, stroke], [-3600, tick], [-3600 + 31, tick]]);
  assert.equal(view(backThenIdle).state, 'paused', 'idle still works after the clock went back');
});

test('the admin changing the minutes mid-day', () => {
  const used = play([[0, stroke], [20, touch], [40, touch], [50, tick]], loaded({ minutes: 15 }));
  assert.equal(view(practiceReducer(used, { type: 'settingChanged', minutes: 20 }, T0 + 51 * S)).secondsLeft, 20 * 60 - 51);
  const lowered = loaded({ minutes: 5, usedSeconds: 6 * 60 });
  assert.deepEqual(view(lowered), { state: 'done', secondsLeft: 0, notice: true });
  const offNow = practiceReducer(used, { type: 'synced', day: used.day, minutes: 0, usedSeconds: 0, sentSeconds: 0 }, T0 + 52 * S);
  assert.equal(view(offNow).state, 'off');
  const raised = practiceReducer(lowered, { type: 'settingChanged', minutes: 10 }, T0);
  assert.deepEqual(view(raised), { state: 'paused', secondsLeft: 4 * 60, notice: false });
});

test('the larger of the server total and this device\'s own count wins, so the clock never goes back', () => {
  const day = localDay(T0);
  const serverAhead = loaded({ usedSeconds: 400, local: { day, usedMs: 100 * S, unsentMs: 0 } });
  assert.deepEqual(view(serverAhead), { state: 'paused', secondsLeft: 15 * 60 - 400, notice: false });
  const localAhead = loaded({ usedSeconds: 100, local: { day, usedMs: 300 * S, unsentMs: 20 * S } });
  assert.equal(view(localAhead).secondsLeft, 15 * 60 - 300);
  assert.equal(localAhead.unsentMs, 200 * S, 'the unsent 20 s and the 180 s the server never got are all sent again');
  const offline = loaded({ usedSeconds: null, local: { day, usedMs: 300 * S, unsentMs: 20 * S } });
  assert.deepEqual([offline.usedMs, offline.unsentMs], [300 * S, 20 * S], 'with no answer from the server, the device\'s record stands as it is');
  const yesterday = loaded({ usedSeconds: 0, local: { day: '2026-10-16', usedMs: 900 * S, unsentMs: 5 * S } });
  assert.deepEqual(view(yesterday), { state: 'waiting', secondsLeft: 15 * 60, notice: false });
});

test('a sync takes what was sent off the unsent time and adds what other devices counted', () => {
  let state = play([[0, stroke], [10, touch], [20, touch], [25, tick]]);
  assert.equal(sendable(state), 25);
  state = practiceReducer(state, { type: 'synced', day: state.day, minutes: 15, usedSeconds: 25 + 120, sentSeconds: 25 }, T0 + 26 * S);
  assert.equal(state.unsentMs, 1 * S, 'the second counted while the call was out stays unsent');
  assert.equal(view(state).secondsLeft, 15 * 60 - 146);
  assert.equal(view(state).state, 'running');
  const stale = practiceReducer(state, { type: 'synced', day: '2026-10-16', minutes: 15, usedSeconds: 900, sentSeconds: 1 }, T0 + 27 * S);
  assert.equal(view(stale).secondsLeft, 15 * 60 - 147, 'a sync for another day leaves today alone');
});

test('at most one call\'s worth is sendable, and the local record is what a reload needs', () => {
  const state = { ...loaded(), unsentMs: 95_400 };
  assert.equal(sendable(state), 60);
  assert.equal(sendable({ ...state, unsentMs: 999 }), 0);
  assert.deepEqual(localRecord(state), { day: localDay(T0), usedMs: 0, unsentMs: 95_400 });
});

test('a report dropped as the page closed is sent again, so the server reaches the goal the child saw', () => {
  // A 20 minute goal. The first visit counts 5 minutes and sends its last 14 s with keepalive as the page closes.
  let state = loaded({ minutes: 20 });
  state = play([[0, stroke], ...Array.from({ length: 10 }, (_, i) => [(i + 1) * 30 - 1, touch]), [300, tick]], state);
  state = practiceReducer(state, { type: 'synced', day: state.day, minutes: 20, usedSeconds: 286, sentSeconds: 286 }, T0 + 300 * S);
  state = practiceReducer(state, { type: 'sentUnconfirmed', seconds: 14 }, T0 + 300 * S);
  assert.deepEqual([state.usedMs, state.unsentMs], [300 * S, 0]);
  // The iPad dropped it, so the server has 286 s. The next visit sends the 14 s again.
  let server = 286;
  state = loaded({ minutes: 20, usedSeconds: server, local: localRecord(state), at: 600 });
  assert.equal(view(state).secondsLeft, 20 * 60 - 300, 'the child\'s clock does not jump');
  assert.equal(sendable(state), 14);
  // Practise to the end, with the page sending all it can each time the server answers.
  let at = 600;
  state = practiceReducer(state, stroke, T0 + at * S);
  while (view(state).state !== 'done') {
    at += 15;
    state = practiceReducer(state, touch, T0 + at * S);
    const seconds = sendable(state);
    server += seconds;
    state = practiceReducer(state, { type: 'synced', day: state.day, minutes: 20, usedSeconds: server, sentSeconds: seconds }, T0 + at * S);
  }
  for (let seconds = sendable(state); seconds > 0; seconds = sendable(state)) {
    server += seconds;
    state = practiceReducer(state, { type: 'synced', day: state.day, minutes: 20, usedSeconds: server, sentSeconds: seconds }, T0 + at * S);
  }
  assert.equal(server, 20 * 60, 'the server has the full 20 minutes');
  assert.equal(state.unsentMs, 0);
});
