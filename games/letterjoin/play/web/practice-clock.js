import { formatClock } from './format.js';
import { MAX_SEND_SECONDS, SEND_EVERY_MS, initialPractice, localDay, localRecord, practiceReducer, practiceView, sendable } from './practice.js';

/** After a failed report the page waits this long before trying again, and never blocks anything meanwhile. */
const RETRY_MS = 15_000;
/** Pointer moves come many times a second; the clock only needs to hear about them about once a second. */
const INTERACTION_EVERY_MS = 1000;
const INTERACTIONS = ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'wheel', 'scroll'];

/**
 * Drives the daily practice clock in the page: the header pill, the time's-up notice, the events that feed the
 * model, the copy kept on this device and the reports to the server.
 * @param {{
 *   api: ReturnType<import('./api.js').createApiClient>,
 *   storage: { get(key: string): string | null, set(key: string, value: string): void },
 *   busy: () => boolean,
 *   now?: () => number,
 * }} options `busy` is true while the notice would get in the way, such as during a timed attempt or the celebration.
 */
export function createPracticeClock({ api, storage, busy, now = Date.now }) {
  const $ = (id) => document.getElementById(id);
  const pill = $('practice');
  const text = $('practice-text');
  const notice = $('practice-notice');
  const storageKey = 'practice';
  let state = initialPractice(now());
  /** Seconds in the one report that may be out at a time. */
  let inFlight = 0;
  let lastFailure = -Infinity;
  let lastInteraction = -Infinity;
  const pointersDown = new Set();

  function remembered() {
    try {
      return JSON.parse(storage.get(storageKey) ?? 'null');
    } catch {
      return null;
    }
  }
  function remember() {
    storage.set(storageKey, JSON.stringify({ ...localRecord(state), minutes: state.minutes, noticeDay: state.noticeDay }));
  }

  /** Every event goes through here, so a new local day first sends what the old day still owes. */
  function dispatch(event) {
    const at = now();
    if (localDay(at) !== state.day && !inFlight && sendable(state) > 0) report();
    state = practiceReducer(state, event, at);
    remember();
    render();
    if (shouldReport(at)) report();
  }

  function shouldReport(at) {
    if (inFlight || sendable(state) === 0 || at - lastFailure < RETRY_MS) return false;
    return state.phase !== 'running' || state.unsentMs >= SEND_EVERY_MS;
  }

  async function report() {
    const day = state.day;
    const seconds = sendable(state);
    inFlight = seconds;
    try {
      const { minutes, usedSeconds } = await api.addPractice(day, seconds);
      inFlight = 0;
      dispatch({ type: 'synced', day, minutes, usedSeconds, sentSeconds: seconds });
    } catch {
      inFlight = 0;
      lastFailure = now();
    }
  }

  /**
   * The page is going away: send everything with keepalive and count it as sent, since no answer will come. If a
   * send is dropped, the next answer from the server shows the gap and it is sent again.
   */
  function reportAll() {
    const day = state.day;
    let left = Math.floor(state.unsentMs / 1000) - inFlight;
    while (left > 0) {
      const seconds = Math.min(MAX_SEND_SECONDS, left);
      api.addPractice(day, seconds, { keepalive: true }).catch(() => {});
      state = practiceReducer(state, { type: 'sentUnconfirmed', seconds }, now());
      left -= seconds;
    }
    remember();
  }

  const LABELS = {
    waiting: (clock) => [`${clock} today`, `Daily practice: ${clock} to do today. It starts when you write.`],
    running: (clock) => [clock, `Daily practice: ${clock} left today.`],
    paused: (clock) => [`Paused ${clock}`, `Daily practice is paused with ${clock} left. Touch the screen to carry on.`],
    done: () => ['Done for today', 'Daily practice is done for today.'],
  };

  function render() {
    const view = practiceView(state);
    pill.hidden = view.state === 'off';
    if (view.state === 'off') return;
    pill.dataset.state = view.state;
    const [shown, label] = LABELS[view.state](formatClock(view.secondsLeft * 1000));
    text.textContent = shown;
    pill.setAttribute('aria-label', label);
    if (view.notice && notice.hidden && pointersDown.size === 0 && !busy()) showNotice();
  }

  function showNotice() {
    notice.hidden = false;
    $('practice-notice-ok').focus({ preventScroll: true });
    state = practiceReducer(state, { type: 'noticeShown' }, now());
    remember();
  }

  function interacted() {
    const at = now();
    if (state.phase !== 'paused' && at - lastInteraction < INTERACTION_EVERY_MS) return;
    lastInteraction = at;
    dispatch({ type: 'interaction' });
  }

  async function load() {
    const kept = remembered();
    const today = localDay(now());
    if (kept && kept.day !== today && kept.unsentMs >= 1000) {
      // Yesterday's last few seconds; the server refuses them if that day is too long ago, which is fine.
      for (let left = Math.floor(kept.unsentMs / 1000); left > 0; left -= MAX_SEND_SECONDS) {
        await api.addPractice(kept.day, Math.min(MAX_SEND_SECONDS, left)).catch(() => {});
      }
    }
    let server;
    try {
      server = await api.practice(today);
    } catch {
      server = { minutes: kept?.minutes ?? 0, usedSeconds: null };
    }
    const local = kept ? { day: kept.day, usedMs: kept.usedMs, unsentMs: kept.unsentMs } : null;
    dispatch({ type: 'loaded', minutes: server.minutes, usedSeconds: server.usedSeconds, local, noticeDay: kept?.noticeDay ?? null });
  }

  /** Back on the page: catch up with the admin's setting and other devices before anything is counted. */
  async function refresh() {
    try {
      const { minutes, usedSeconds } = await api.practice(state.day);
      dispatch({ type: 'synced', day: state.day, minutes, usedSeconds, sentSeconds: 0 });
    } catch {
      // The next report tries again.
    }
  }

  return {
    async start() {
      await load();
      for (const type of INTERACTIONS) addEventListener(type, interacted, { capture: true, passive: true });
      addEventListener('pointerdown', (e) => pointersDown.add(e.pointerId), { capture: true, passive: true });
      for (const type of ['pointerup', 'pointercancel']) {
        addEventListener(type, (e) => {
          pointersDown.delete(e.pointerId);
          render();
        }, { passive: true });
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          dispatch({ type: 'hidden' });
        } else {
          dispatch({ type: 'visible' });
          refresh();
        }
      });
      addEventListener('pagehide', reportAll);
      $('practice-notice-ok').addEventListener('click', () => { notice.hidden = true; });
      notice.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') notice.hidden = true;
      });
      setInterval(() => dispatch({ type: 'tick' }), 1000);
    },
    /** A pen or mouse stroke started on the sheet: the only thing that starts the day's clock. */
    stroke: () => dispatch({ type: 'strokeStart' }),
    get state() {
      return state;
    },
  };
}
