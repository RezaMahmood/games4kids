import type { DrawingMeta, Picture, PictureKind, UsageToday } from '../../../../data/types';

export type PlayerView =
  | { kind: 'home' }
  | { kind: 'picker'; mode: PictureKind }
  | { kind: 'history' }
  | { kind: 'canvas'; picture: Picture; drawing: DrawingMeta; returnTo: 'picker' | 'history'; startFinish?: boolean };

export type Time =
  | { kind: 'unknown' }
  | { kind: 'open'; minutesLeft: number }
  | { kind: 'up'; dialog: boolean };

/** The portal has already admitted this child to this game, so a page is only ever in a view with a clock beside it. */
export type State = { view: PlayerView; time: Time };

export type Action =
  | { type: 'goHome' }
  | { type: 'openPicker'; mode: PictureKind }
  | { type: 'openHistory' }
  | { type: 'openCanvas'; picture: Picture; drawing: DrawingMeta; returnTo: 'picker' | 'history'; startFinish?: boolean }
  | { type: 'leaveCanvas' }
  | { type: 'usage'; usage: UsageToday }
  | { type: 'timeUp' }
  | { type: 'dismissTimeUp' };

const home: PlayerView = { kind: 'home' };

export const initialState: State = { view: home, time: { kind: 'unknown' } };

export const journeysOpen = (s: State): boolean => s.time.kind !== 'up';

function toTime(u: UsageToday): Time {
  return u.remainingSeconds <= 0
    ? { kind: 'up', dialog: true }
    : { kind: 'open', minutesLeft: Math.ceil(u.remainingSeconds / 60) };
}

function applyTime(s: State, next: Time): State {
  if (next.kind !== 'up') {
    if (s.time.kind === 'open' && next.kind === 'open' && s.time.minutesLeft === next.minutesLeft) return s;
    return { ...s, time: next };
  }
  if (s.time.kind === 'up') return s;
  return { view: home, time: next };
}

const withView = (s: State, view: PlayerView): State => ({ ...s, view });

export function reduce(s: State, a: Action): State {
  switch (a.type) {
    case 'goHome':
      return withView(s, home);
    case 'openPicker':
      return journeysOpen(s) ? withView(s, { kind: 'picker', mode: a.mode }) : s;
    case 'openHistory':
      return withView(s, { kind: 'history' });
    case 'openCanvas':
      return journeysOpen(s)
        ? withView(s, { kind: 'canvas', picture: a.picture, drawing: a.drawing, returnTo: a.returnTo, startFinish: a.startFinish })
        : s;
    case 'leaveCanvas':
      if (s.view.kind !== 'canvas') return s;
      return withView(s, s.view.returnTo === 'history' ? { kind: 'history' } : { kind: 'picker', mode: s.view.drawing.kind });
    case 'usage':
      return applyTime(s, toTime(a.usage));
    case 'timeUp':
      return applyTime(s, { kind: 'up', dialog: true });
    case 'dismissTimeUp':
      return s.time.kind === 'up' && s.time.dialog ? { ...s, time: { kind: 'up', dialog: false } } : s;
  }
}
