/**
 * The daily practice clock: a parent sets how many minutes a child should write each day, and the clock counts
 * that time down while the child is using the app. It is a pure state machine; the page feeds it events with the
 * time they happened and draws `view(state)`.
 *
 * - `off` the admin set 0 minutes; nothing is counted or shown.
 * - `waiting` today's clock has not started. Only a pen or mouse stroke starts it.
 * - `running` counting. Any interaction keeps it running.
 * - `paused` started today, but idle for IDLE_MS or the page was hidden. Any interaction resumes it.
 * - `done` today's minutes are used up. Nothing more is counted.
 *
 * @typedef {'off' | 'waiting' | 'running' | 'paused' | 'done'} Phase
 * @typedef {{
 *   minutes: number,
 *   day: string,
 *   phase: Phase,
 *   usedMs: number,
 *   unsentMs: number,
 *   lastActive: number,
 *   countedTo: number,
 *   noticeDay: string | null,
 * }} Practice
 * `usedMs` is today's total from every device; `unsentMs` is the part counted here that the server has not taken yet.
 * Each answer from the server makes `usedMs` its total plus `unsentMs`, so time that was sent but never arrived,
 * such as a report the iPad dropped while the page closed, is sent again instead of lost.
 * While running, time is counted up to `countedTo`, and `lastActive` is the last interaction.
 *
 * @typedef {{ day: string, usedMs: number, unsentMs: number }} LocalRecord what this device keeps between visits
 * @typedef {{ type: 'tick' | 'strokeStart' | 'interaction' | 'hidden' | 'visible' | 'noticeShown' }
 *   | { type: 'loaded', minutes: number, usedSeconds: number | null, local: LocalRecord | null, noticeDay: string | null }
 *   | { type: 'synced', day: string, minutes: number, usedSeconds: number, sentSeconds: number }
 *   | { type: 'sentUnconfirmed', seconds: number }
 *   | { type: 'settingChanged', minutes: number }} PracticeEvent
 */

/** The idle seconds before a pause are counted as practice: simple, and the child sees no jump back. */
export const IDLE_MS = 30_000;
/** The server takes at most this much in one call; the page sends larger amounts in several. */
export const MAX_SEND_SECONDS = 60;
/** Unsent time worth a call to the server while the clock is running. */
export const SEND_EVERY_MS = 15_000;

const pad = (n) => String(n).padStart(2, '0');

/** The device's local calendar day, which is where the parent's "every day" resets. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const limitMs = (state) => state.minutes * 60_000;

/** The phase that follows from the setting and the time used, keeping a clock that is running or waiting as it is. */
function settle(state) {
  if (state.minutes === 0) return { ...state, phase: 'off' };
  if (state.usedMs >= limitMs(state)) return { ...state, phase: 'done' };
  if (state.phase === 'running') return state;
  return { ...state, phase: state.usedMs > 0 ? 'paused' : 'waiting' };
}

/** @returns {Practice} */
export function initialPractice(now) {
  return { minutes: 0, day: localDay(now), phase: 'off', usedMs: 0, unsentMs: 0, lastActive: now, countedTo: now, noticeDay: null };
}

/**
 * Counts the running time up to `now`, but never past IDLE_MS after the last interaction. That one bound also caps
 * a clock that jumps forward (sleep, wake, a changed device clock). A clock that jumps back counts nothing.
 */
function count(state, now) {
  if (state.phase !== 'running') return state;
  if (now < state.countedTo) return { ...state, countedTo: now, lastActive: now };
  const end = Math.min(now, state.lastActive + IDLE_MS);
  const add = Math.min(end - state.countedTo, limitMs(state) - state.usedMs);
  const counted = { ...state, usedMs: state.usedMs + add, unsentMs: state.unsentMs + add, countedTo: end };
  if (counted.usedMs >= limitMs(counted)) return { ...counted, phase: 'done' };
  return now >= state.lastActive + IDLE_MS ? { ...counted, phase: 'paused' } : counted;
}

/**
 * The server's total joined with this device's count. The larger wins, so the clock never goes back, and anything
 * this device counted that the server lacks is unsent again. Only one report is out at a time and it is not taken
 * off `unsentMs` until it is answered, so a gap means a report was lost.
 */
function withServer({ usedMs, unsentMs }, usedSeconds) {
  const serverMs = usedSeconds * 1000;
  const total = Math.max(usedMs, serverMs + unsentMs);
  return { usedMs: total, unsentMs: total - serverMs };
}

const run = (state, now) => ({ ...state, phase: 'running', lastActive: now, countedTo: now });

/** A new local day starts a fresh clock that waits for the first stroke. The page sends the old day's unsent time first. */
function rollOver(state, now) {
  const day = localDay(now);
  if (day === state.day) return state;
  return settle({ ...state, day, phase: 'waiting', usedMs: 0, unsentMs: 0, lastActive: now, countedTo: now });
}

/**
 * @param {Practice} state
 * @param {PracticeEvent} event
 * @param {number} now milliseconds since the epoch, from the device clock
 * @returns {Practice}
 */
export function practiceReducer(state, event, now) {
  const today = rollOver(state, now);
  switch (event.type) {
    case 'tick':
    case 'visible':
      return count(today, now);
    case 'hidden': {
      const counted = count(today, now);
      return counted.phase === 'running' ? { ...counted, phase: 'paused' } : counted;
    }
    case 'strokeStart':
    case 'interaction': {
      const counted = count(today, now);
      if (counted.phase === 'running') return { ...counted, lastActive: now };
      const starts = counted.phase === 'paused' || (counted.phase === 'waiting' && event.type === 'strokeStart');
      return starts ? run(counted, now) : counted;
    }
    case 'loaded': {
      const local = event.local?.day === today.day ? event.local : null;
      const kept = { usedMs: local?.usedMs ?? 0, unsentMs: local?.unsentMs ?? 0 };
      const totals = event.usedSeconds === null ? kept : withServer(kept, event.usedSeconds);
      return settle({ ...today, minutes: event.minutes, ...totals, noticeDay: event.noticeDay, phase: 'waiting' });
    }
    case 'synced': {
      const counted = count(today, now);
      if (event.day !== counted.day) return settle({ ...counted, minutes: event.minutes });
      const unsentMs = Math.max(0, counted.unsentMs - event.sentSeconds * 1000);
      return settle({ ...counted, minutes: event.minutes, ...withServer({ usedMs: counted.usedMs, unsentMs }, event.usedSeconds) });
    }
    case 'sentUnconfirmed':
      return { ...today, unsentMs: Math.max(0, today.unsentMs - event.seconds * 1000) };
    case 'settingChanged':
      return settle({ ...count(today, now), minutes: event.minutes });
    case 'noticeShown':
      return { ...today, noticeDay: today.day };
    default:
      return today;
  }
}

/**
 * What the header shows. `notice` asks for the one time's-up message of the day; the page shows it when the pen is up.
 * @returns {{ state: Phase, secondsLeft: number, notice: boolean }}
 */
export function practiceView(state) {
  const secondsLeft = Math.max(0, Math.ceil((limitMs(state) - state.usedMs) / 1000));
  return { state: state.phase, secondsLeft, notice: state.phase === 'done' && state.noticeDay !== state.day };
}

/** Whole seconds ready for the server, at most one call's worth. The fraction stays until it adds up. */
export const sendable = (state) => Math.min(MAX_SEND_SECONDS, Math.floor(state.unsentMs / 1000));

/** @returns {LocalRecord} */
export const localRecord = (state) => ({ day: state.day, usedMs: state.usedMs, unsentMs: state.unsentMs });
