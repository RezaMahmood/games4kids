/**
 * One attempt at one activity. Pure: every time arrives in an event, read from performance.now() by the caller.
 *
 * A `trace` activity ends at `scored`. A `traceThenCopy` activity goes on from `scored` to an unaided copy on a
 * blank sheet, which is never timed or scored: `copying` until Done, `sending` while the image uploads, then
 * `sent`, or `unsent` when the upload failed (the ink is kept and Done is offered again as Retry).
 *
 * @typedef {import('./activity.js').Mode} Mode
 * @typedef {{ coverage: number, precision: number, score: number }} Score
 * @typedef {{ phase: 'idle', limitMs: number | null, mode: Mode }} Idle
 * @typedef {Omit<Idle, 'phase'> & { phase: 'tracing', startedAt: number }} Tracing
 * @typedef {{ elapsedMs: number, outcome: 'finished' | 'expired', result: Score }} Traced
 * @typedef {Omit<Tracing, 'phase'> & Traced & { phase: 'scored' }} Scored
 * @typedef {Omit<Scored, 'phase'> & { phase: 'copying', inked: boolean }} Copying
 * @typedef {Omit<Scored, 'phase'> & { phase: 'sending' }} Sending
 * @typedef {Omit<Scored, 'phase'> & { phase: 'unsent', error: string }} Unsent
 * @typedef {Omit<Scored, 'phase'> & { phase: 'sent' }} Sent
 * @typedef {Idle | Tracing | Scored | Copying | Sending | Unsent | Sent} Attempt
 * `result` scores the whole sheet, so text the child never reached counts as untraced.
 * @typedef {{ type: 'load', limitMs: number | null, mode: Mode }
 *   | { type: 'strokeStart', t: number }
 *   | { type: 'finish' | 'expire', t: number, result: Score }
 *   | { type: 'startCopy' | 'clear' | 'submit' | 'sent' }
 *   | { type: 'sendFailed', error: string }} AttemptEvent
 */

/** The copy phases carry the trace's outcome along, so the score stays known after the copy. */
const traced = ({ limitMs, mode, startedAt, elapsedMs, outcome, result }) => ({ limitMs, mode, startedAt, elapsedMs, outcome, result });

/** @returns {Attempt} */
export function startAttempt(limitMs, mode = 'trace') {
  return { phase: 'idle', limitMs, mode };
}

/**
 * @param {Attempt} state
 * @param {AttemptEvent} event
 * @returns {Attempt}
 */
export function transition(state, event) {
  switch (event.type) {
    case 'load':
      return startAttempt(event.limitMs, event.mode);
    case 'strokeStart':
      if (state.phase === 'idle') return { ...state, phase: 'tracing', startedAt: event.t };
      return state.phase === 'copying' && !state.inked ? { ...state, inked: true } : state;
    case 'finish':
    case 'expire': {
      if (state.phase !== 'tracing') return state;
      const expired = event.type === 'expire';
      if (expired && state.limitMs === null) return state;
      const taken = Math.max(0, Math.round(event.t - state.startedAt));
      const elapsedMs = state.limitMs === null ? taken : expired ? state.limitMs : Math.min(taken, state.limitMs);
      return { ...state, phase: 'scored', elapsedMs, outcome: expired ? 'expired' : 'finished', result: event.result };
    }
    case 'startCopy':
      return state.phase === 'scored' && state.mode === 'traceThenCopy' ? { ...traced(state), phase: 'copying', inked: false } : state;
    case 'clear':
      return state.phase === 'copying' && state.inked ? { ...state, inked: false } : state;
    case 'submit':
      return (state.phase === 'copying' && state.inked) || state.phase === 'unsent' ? { ...traced(state), phase: 'sending' } : state;
    case 'sent':
      return state.phase === 'sending' ? { ...traced(state), phase: 'sent' } : state;
    case 'sendFailed':
      return state.phase === 'sending' ? { ...traced(state), phase: 'unsent', error: event.error } : state;
    default:
      return state;
  }
}

const RESULT_PHASES = new Set(['scored', 'unsent', 'sent']);

/** Hiding applies only where the results bar (and so the toggle) is shown, so it can never blank the guides mid-trace or mid-copy. */
export function guidesHidden(showGuides, phase) {
  return !showGuides && RESULT_PHASES.has(phase);
}

export function createAttempt(onChange) {
  let state = startAttempt(null);
  return {
    get state() {
      return state;
    },
    send(event) {
      const next = transition(state, event);
      if (next === state) return;
      state = next;
      onChange(state, event);
    },
  };
}
