/**
 * The writing pad of hard mode: four-line paper the child writes the text on freely, one line after another.
 * Pure, so the whole flow runs under node:test; web/write.js is the DOM shell around it.
 *
 * Everything is in sheet units, like the tracing sheet: CSS px at the width the pad was laid out for. Line i
 * starts at y = i * lineHeight, and the guide lines are offsets from that top.
 * @typedef {{
 *   width: number,
 *   lineHeight: number,
 *   ascender: number,
 *   xHeight: number,
 *   baseline: number,
 *   descender: number,
 *   edgeMargin: number,
 *   visibleLines: number,
 * }} PadGeometry `ascender`, `baseline` and `descender` are offsets within a line; the dashed x-height line
 *   sits `xHeight` above the baseline. Ink within `edgeMargin` of the right edge is near the end of the line.
 * @typedef {import('./ink.js').Point} Point
 * @typedef {{ points: Point[], line: number }} PadStroke
 *
 * `writing` until the line's ink reaches the edge zone, then `nearEdge` while the pen is down there, and
 * `awaitingWordEnd` once it lifts. The word ending then moves the child to the next line.
 * @typedef {{ kind: 'writing' } | { kind: 'nearEdge' } | { kind: 'awaitingWordEnd' }} PadPhase
 * `line` takes the ink; `view` is the line the paper shows second from the top. The view only catches up with the
 * line once the pen has rested (`liftedAt` is when it last lifted, null while it is down), so the paper never moves
 * under a word being written.
 * @typedef {{ line: number, view: number, strokes: PadStroke[], phase: PadPhase, liftedAt: number | null }} PadState
 *
 * `penUp` carries the finished stroke, which starts with the point `penDown` had.
 * @typedef {{ type: 'penDown', point: Point } | { type: 'penUp', points: Point[] } | { type: 'tick', t: number } | { type: 'newLine' }} PadEvent
 * `advance`: the paper moved on from showing line `from` to the state's view, so scroll. `read`: line is finished.
 * @typedef {{ type: 'advance', from: number } | { type: 'read', line: number }} PadEffect
 */

/** A pen lifted this long ends the word: in the edge zone it moves the child on, and the paper may move. */
export const WORD_END_MS = 600;
export const VISIBLE_LINES = 3;

/**
 * The pad for a stage `width` CSS px wide and the activity's x-height. Ascenders and descenders are one x-height
 * each, as on a child's four-line paper.
 * @param {{ width: number, xHeight: number }} options
 * @returns {PadGeometry}
 */
export function padGeometry({ width, xHeight }) {
  const ascender = 0.3 * xHeight;
  const baseline = ascender + 2 * xHeight;
  const descender = baseline + xHeight;
  return { width, lineHeight: descender + 0.3 * xHeight, ascender, xHeight, baseline, descender, edgeMargin: 3 * xHeight, visibleLines: VISIBLE_LINES };
}

/** A space between words is wider than this; the gaps inside a word are narrower. */
export const wordGap = (geometry) => 0.6 * geometry.xHeight;

/** @param {PadGeometry} geometry */
export const lineOf = (geometry, y) => Math.floor(y / geometry.lineHeight);

/** @returns {PadState} */
export const initialPad = () => ({ line: 0, view: 0, strokes: [], phase: { kind: 'writing' }, liftedAt: null });

/** @param {PadState} state */
export const strokesOn = (state, line) => state.strokes.filter((s) => s.line === line);

const maxX = (strokes) => Math.max(-Infinity, ...strokes.flatMap((s) => s.points.map((p) => p.x)));
const reachesEdge = (geometry, strokes) => maxX(strokes) >= geometry.width - geometry.edgeMargin;

const readEffect = (state, line) => (strokesOn(state, line).length ? [{ type: 'read', line }] : []);

/** Ink moves on to line `to`; the line left is read. */
function moveOn(state, to) {
  return { state: { ...state, line: to, phase: { kind: 'writing' } }, effects: /** @type {PadEffect[]} */ (readEffect(state, state.line)) };
}

/** The paper catches up with the line being written. */
function scrollTo(out) {
  if (out.state.view === out.state.line) return out;
  return { state: { ...out.state, view: out.state.line }, effects: [{ type: 'advance', from: out.state.view }, ...out.effects] };
}

const rested = (state, t) => state.liftedAt !== null && t - state.liftedAt >= WORD_END_MS;

/**
 * @param {PadGeometry} geometry
 * @param {PadState} state
 * @param {PadEvent} event
 * @returns {{ state: PadState, effects: PadEffect[] }}
 */
export function padReducer(geometry, state, event) {
  const same = { state, effects: [] };
  switch (event.type) {
    case 'penDown': {
      // A stroke belongs to the line it starts in. The lines already left never take more ink.
      const line = Math.max(state.line, lineOf(geometry, event.point.y));
      const moved = line > state.line ? moveOn(state, line) : same;
      const stroke = { points: [event.point], line };
      const strokes = [...moved.state.strokes, stroke];
      const phase = reachesEdge(geometry, strokes.filter((s) => s.line === line)) ? { kind: 'nearEdge' } : { kind: 'writing' };
      return { state: { ...moved.state, strokes, phase: /** @type {PadPhase} */ (phase), liftedAt: null }, effects: moved.effects };
    }
    case 'penUp': {
      const last = state.strokes.at(-1);
      if (!last) return same;
      const strokes = [...state.strokes.slice(0, -1), { ...last, points: event.points }];
      const phase = reachesEdge(geometry, strokes.filter((s) => s.line === state.line)) ? { kind: 'awaitingWordEnd' } : { kind: 'writing' };
      return { state: { ...state, strokes, phase: /** @type {PadPhase} */ (phase), liftedAt: event.points.at(-1).t }, effects: [] };
    }
    case 'tick':
      if (!rested(state, event.t)) return same;
      return scrollTo(state.phase.kind === 'awaitingWordEnd' ? moveOn(state, state.line + 1) : same);
    case 'newLine':
      return scrollTo(moveOn(state, state.line + 1));
  }
}
