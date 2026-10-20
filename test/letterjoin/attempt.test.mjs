import test from 'node:test';
import assert from 'node:assert/strict';
import { guidesHidden, startAttempt, transition } from '../../games/letterjoin/play/web/attempt.js';
import { createDeadline } from '../../games/letterjoin/play/web/deadline.js';
import { acceptsPointer } from '../../games/letterjoin/play/web/ink.js';

const run = (state, ...events) => events.reduce(transition, state);
const sheet = (score) => ({ coverage: score / 100, precision: score / 100, score });

test('the clock starts at the first stroke, not on load', () => {
  let s = startAttempt(30000);
  assert.equal(s.phase, 'idle');
  assert.equal('startedAt' in s, false);
  s = run(s, { type: 'strokeStart', t: 5000 });
  assert.deepEqual([s.phase, s.startedAt], ['tracing', 5000]);
  s = run(s, { type: 'strokeStart', t: 9000 });
  assert.equal(s.startedAt, 5000, 'later strokes do not restart the clock');
});

test('without a stroke there is nothing to finish or expire', () => {
  const idle = startAttempt(30000);
  assert.equal(run(idle, { type: 'finish', t: 100, result: sheet(90) }), idle);
  assert.equal(run(idle, { type: 'expire', t: 40000, result: sheet(0) }), idle);
});

test('finishing before the limit records the time taken', () => {
  const s = run(startAttempt(30000), { type: 'strokeStart', t: 1000 }, { type: 'finish', t: 13456.7, result: sheet(80) });
  assert.deepEqual([s.phase, s.outcome, s.elapsedMs, s.result.score], ['scored', 'finished', 12457, 80]);
});

test('expiry clamps the time to the limit exactly, even when noticed late', () => {
  const s = run(startAttempt(30000), { type: 'strokeStart', t: 1000 }, { type: 'expire', t: 95000, result: sheet(50) });
  assert.deepEqual([s.outcome, s.elapsedMs], ['expired', 30000]);
  const late = run(startAttempt(30000), { type: 'strokeStart', t: 1000 }, { type: 'finish', t: 99000, result: sheet(50) });
  assert.equal(late.elapsedMs, 30000, 'a finish that lands after the deadline is clamped too');
});

test('untimed attempts never expire and record the full time taken', () => {
  let s = run(startAttempt(null), { type: 'strokeStart', t: 0 }, { type: 'expire', t: 10 ** 9, result: sheet(10) });
  assert.equal(s.phase, 'tracing');
  s = run(s, { type: 'finish', t: 3_600_000, result: sheet(70) });
  assert.deepEqual([s.outcome, s.elapsedMs], ['finished', 3_600_000]);
});

test('once scored, strokes, finishes and expiries are ignored', () => {
  const scored = run(startAttempt(30000), { type: 'strokeStart', t: 0 }, { type: 'expire', t: 30000, result: sheet(60) });
  for (const event of [{ type: 'strokeStart', t: 31000 }, { type: 'finish', t: 31000, result: sheet(100) }, { type: 'expire', t: 40000, result: sheet(0) }]) {
    assert.equal(transition(scored, event), scored, event.type);
  }
});

test('the score is the whole sheet result the caller measured', () => {
  const s = run(startAttempt(null), { type: 'strokeStart', t: 0 }, { type: 'finish', t: 5000, result: sheet(30) });
  assert.deepEqual(s.result, sheet(30));
});

test('a new load starts a fresh idle attempt', () => {
  const scored = run(startAttempt(null), { type: 'strokeStart', t: 0 }, { type: 'finish', t: 5000, result: sheet(30) });
  assert.deepEqual(transition(scored, { type: 'load', limitMs: 9000, mode: 'trace' }), { phase: 'idle', limitMs: 9000, mode: 'trace' });
});

const traceThenCopy = (limitMs = null) => run(startAttempt(limitMs, 'traceThenCopy'), { type: 'strokeStart', t: 1000 }, { type: 'finish', t: 6000, result: sheet(72) });
const COPY_EVENTS = [{ type: 'startCopy' }, { type: 'clear' }, { type: 'submit' }, { type: 'sent' }, { type: 'sendFailed', error: 'offline' }];

test('a trace-only attempt ends at scored: no copy event moves it', () => {
  const scored = run(startAttempt(null, 'trace'), { type: 'strokeStart', t: 0 }, { type: 'finish', t: 5000, result: sheet(50) });
  for (const event of COPY_EVENTS) assert.equal(transition(scored, event), scored, event.type);
  assert.equal(startAttempt(null).mode, 'trace', 'trace is the default mode');
});

test('the copy step opens only after the trace is scored', () => {
  const idle = startAttempt(null, 'traceThenCopy');
  const tracing = run(idle, { type: 'strokeStart', t: 0 });
  for (const state of [idle, tracing]) assert.equal(transition(state, { type: 'startCopy' }), state, state.phase);
  const copying = transition(traceThenCopy(), { type: 'startCopy' });
  assert.deepEqual([copying.phase, copying.inked], ['copying', false]);
});

test('the copy step keeps the trace score and time and is never timed or scored', () => {
  const copying = transition(traceThenCopy(30000), { type: 'startCopy' });
  assert.deepEqual([copying.result.score, copying.elapsedMs, copying.outcome], [72, 5000, 'finished']);
  for (const event of [{ type: 'expire', t: 10 ** 9, result: sheet(0) }, { type: 'finish', t: 10 ** 9, result: sheet(100) }]) {
    assert.equal(transition(copying, event), copying, `${event.type} does nothing while copying`);
  }
  const sent = run(copying, { type: 'strokeStart', t: 99 }, { type: 'submit' }, { type: 'sent' });
  assert.deepEqual([sent.phase, sent.result.score, sent.elapsedMs], ['sent', 72, 5000]);
});

test('Done needs ink: a blank or cleared copy cannot be sent', () => {
  const copying = transition(traceThenCopy(), { type: 'startCopy' });
  assert.equal(transition(copying, { type: 'submit' }), copying, 'nothing drawn yet');
  const inked = transition(copying, { type: 'strokeStart', t: 10 });
  assert.equal(inked.inked, true);
  assert.equal(transition(inked, { type: 'strokeStart', t: 20 }), inked, 'later strokes change nothing');
  const cleared = transition(inked, { type: 'clear' });
  assert.equal(cleared.inked, false);
  assert.equal(transition(cleared, { type: 'submit' }), cleared, 'cleared');
  assert.equal(transition(inked, { type: 'submit' }).phase, 'sending');
});

test('a failed upload keeps the copy and can be sent again until it goes through', () => {
  const sending = run(traceThenCopy(), { type: 'startCopy' }, { type: 'strokeStart', t: 10 }, { type: 'submit' });
  assert.equal(transition(sending, { type: 'submit' }), sending, 'Done twice sends once');
  assert.equal(transition(sending, { type: 'clear' }), sending, 'no clearing while it uploads');
  const unsent = transition(sending, { type: 'sendFailed', error: 'Could not reach the server.' });
  assert.deepEqual([unsent.phase, unsent.error], ['unsent', 'Could not reach the server.']);
  assert.equal(transition(unsent, { type: 'clear' }), unsent, 'the kept copy cannot be wiped');
  assert.equal(transition(unsent, { type: 'sent' }), unsent, 'only an upload in flight can succeed');
  const retried = transition(unsent, { type: 'submit' });
  assert.equal(retried.phase, 'sending');
  assert.equal('error' in retried, false, 'the old error goes with the retry');
  const sent = transition(retried, { type: 'sent' });
  assert.equal(sent.phase, 'sent');
  for (const event of COPY_EVENTS) assert.equal(transition(sent, event), sent, `sent is final: ${event.type}`);
});

test('opening the activity again starts over from idle, whatever step the copy was at', () => {
  const sending = run(traceThenCopy(), { type: 'startCopy' }, { type: 'strokeStart', t: 10 }, { type: 'submit' });
  const reloaded = transition(sending, { type: 'load', limitMs: null, mode: 'traceThenCopy' });
  assert.deepEqual(reloaded, { phase: 'idle', limitMs: null, mode: 'traceThenCopy' });
  assert.equal(transition(reloaded, { type: 'sent' }), reloaded, 'a late upload answer does not touch the new attempt');
});

test('pen and mouse draw, touch never draws, and nothing draws once locked', () => {
  assert.equal(acceptsPointer({ pointerType: 'pen', button: 0 }, false), true);
  assert.equal(acceptsPointer({ pointerType: 'mouse', button: 0 }, false), true);
  assert.equal(acceptsPointer({ pointerType: 'mouse', button: 2 }, false), false, 'a right click does not draw');
  assert.equal(acceptsPointer({ pointerType: 'touch', button: 0 }, false), false, 'a finger scrolls instead');
  assert.equal(acceptsPointer({ pointerType: 'pen', button: 0 }, true), false);
});

function fakeClock() {
  let t = 0;
  let next = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => (timers.set(next, { fn, at: t + ms }), next++),
    clearTimer: (h) => timers.delete(h),
    /** Move time on without running any timer, as a frozen background tab would. */
    jump: (ms) => (t += ms),
    /** Move time on and run the timers that come due. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

test('the deadline fires once, at the deadline', () => {
  const clock = fakeClock();
  const fired = [];
  const d = createDeadline({ ...clock, onExpire: (at) => fired.push([at, clock.now()]) });
  clock.jump(1000);
  d.start(1000, 4000);
  clock.advance(3999);
  assert.deepEqual(fired, []);
  clock.advance(1);
  assert.deepEqual(fired, [[5000, 5000]]);
  clock.advance(10000);
  assert.equal(fired.length, 1);
  assert.equal(clock.pending(), 0);
});

test('a pointer event stamped after the deadline expires the attempt without any timer tick', () => {
  const clock = fakeClock();
  const fired = [];
  const d = createDeadline({ ...clock, onExpire: (at) => fired.push(at) });
  d.start(0, 4000);
  clock.jump(6000);
  assert.equal(d.check(3999), false, 'an event from before the deadline is still in time');
  assert.equal(d.check(4500), true, 'an event after the deadline is refused');
  assert.deepEqual(fired, [4000]);
  assert.equal(d.check(4600), false, 'it only fires once');
});

test('coming back to a hidden tab catches up on the deadline', () => {
  const clock = fakeClock();
  const fired = [];
  const d = createDeadline({ ...clock, onExpire: (at) => fired.push(at) });
  d.start(0, 4000);
  clock.jump(60000);
  d.check(clock.now());
  assert.deepEqual(fired, [4000]);
});

test('a timer that fires early is re-armed from the deadline, not by accumulating ticks', () => {
  let t = 0;
  const calls = [];
  let pendingFn = null;
  const d = createDeadline({
    now: () => t,
    setTimer: (fn, ms) => (calls.push(ms), (pendingFn = fn), 1),
    clearTimer: () => {},
    onExpire: () => calls.push('expired'),
  });
  d.start(0, 4000);
  t = 3000;
  pendingFn();
  assert.deepEqual(calls, [4000, 1000]);
  t = 4000;
  pendingFn();
  assert.deepEqual(calls, [4000, 1000, 'expired']);
});

test('stop cancels the deadline', () => {
  const clock = fakeClock();
  const fired = [];
  const d = createDeadline({ ...clock, onExpire: (at) => fired.push(at) });
  d.start(0, 4000);
  d.stop();
  clock.advance(10000);
  assert.equal(d.check(9000), false);
  assert.deepEqual(fired, []);
});

test('guides are hidden only when switched off and the results bar is showing', () => {
  for (const phase of ['scored', 'unsent', 'sent']) {
    assert.equal(guidesHidden(false, phase), true, `${phase}: hidden when switched off`);
    assert.equal(guidesHidden(true, phase), false, `${phase}: shown when switched on`);
  }
  for (const phase of ['idle', 'tracing', 'copying', 'sending']) {
    assert.equal(guidesHidden(false, phase), false, `${phase}: never hidden`);
    assert.equal(guidesHidden(true, phase), false, `${phase}: shown`);
  }
});
