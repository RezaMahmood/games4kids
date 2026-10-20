/**
 * Owns the real clock for a timed attempt. A timer tick, a visibility change and every pointer event all
 * ask `check(t)`, so a throttled background tab or a late tick cannot let ink in after the deadline.
 *
 * @param {{ now: () => number, setTimer: (fn: () => void, ms: number) => unknown, clearTimer: (handle: unknown) => void, onExpire: (deadline: number) => void }} clock
 */
export function createDeadline({ now, setTimer, clearTimer, onExpire }) {
  let deadline = null;
  let handle = null;

  const disarm = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };

  function expire() {
    const at = deadline;
    deadline = null;
    disarm();
    onExpire(at);
  }

  /** Re-armed from the absolute deadline each time, so delays never accumulate. */
  function arm() {
    disarm();
    if (deadline === null) return;
    const wait = deadline - now();
    if (wait <= 0) expire();
    else handle = setTimer(tick, wait);
  }

  function tick() {
    handle = null;
    check(now());
  }

  /** @returns {boolean} true when the attempt has run out of time at `t` (and fires onExpire once). */
  function check(t = now()) {
    if (deadline === null) return false;
    if (t >= deadline) {
      expire();
      return true;
    }
    if (handle === null) arm();
    return false;
  }

  return {
    start(startedAt, limitMs) {
      deadline = startedAt + limitMs;
      arm();
    },
    stop() {
      deadline = null;
      disarm();
    },
    check,
    get deadline() {
      return deadline;
    },
  };
}
