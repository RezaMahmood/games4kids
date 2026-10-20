import { svgNode } from './render.js';

export const INK = { fill: 'none', stroke: '#2563eb', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/**
 * Points are in sheet units with the event time, so scrolling and rotating never move the ink and an expiry
 * can cut a stroke at the deadline.
 * @typedef {{ x: number, y: number, t: number }} Point
 * @typedef {Point[]} Stroke
 */

/** Pen and mouse draw. Touch never draws: a finger scrolls the sheet and a resting palm does nothing. Hover never gets here. */
export function acceptsPointer(e, locked) {
  if (locked || e.pointerType === 'touch') return false;
  return e.pointerType === 'pen' || e.button === 0;
}

const pathData = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}${i ? '' : 'l0 0'}`).join('');

/**
 * @param {SVGSVGElement} svg the sheet; the ink layer it returns must be appended to it.
 * Every point is mapped with the sheet's position at that moment, because the page can move under the pen (a toolbar
 * resizing, a scroll). A matrix kept from the start of the stroke would draw the rest of it offset from the pen.
 * @param {{ allow: (t: number) => boolean, onStrokeStart: (t: number, stroke: Stroke) => void, onStrokeEnd?: (stroke: Stroke) => void }} hooks
 *   `allow` answers whether input at time t may still draw; `onStrokeStart` fires for every accepted stroke, with
 *   its first point, and `onStrokeEnd` when the pen lifts. The stroke array grows in between.
 */
export function createInk(svg, { allow, onStrokeStart, onStrokeEnd }) {
  const layer = svgNode('g', INK);
  /** @type {Stroke[]} */
  let strokes = [];
  /** @type {{ id: number, points: Stroke, path: SVGPathElement } | null} */
  let active = null;
  let locked = false;

  const release = () => {
    if (active && svg.hasPointerCapture(active.id)) svg.releasePointerCapture(active.id);
    active = null;
  };
  const wipe = () => {
    release();
    strokes = [];
    layer.replaceChildren();
  };
  // The layer's own matrix, so a layer inside a moved group (the writing pad scrolls) still takes sheet units.
  const toPoint = (e, toSheet = layer.getScreenCTM().inverse()) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(toSheet);
    return { x: p.x, y: p.y, t: e.timeStamp };
  };

  // iPad Safari scrolls under an Apple Pencil unless its touches are cancelled; fingers keep scrolling.
  const holdPencil = (e) => {
    if ([...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault();
  };
  svg.addEventListener('touchstart', holdPencil, { passive: false });
  svg.addEventListener('touchmove', holdPencil, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    if (active || !acceptsPointer(e, locked) || !allow(e.timeStamp)) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const points = [toPoint(e)];
    const path = svgNode('path', { d: pathData(points) });
    layer.append(path);
    strokes.push(points);
    active = { id: e.pointerId, points, path };
    onStrokeStart(e.timeStamp, points);
  });

  svg.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== active.id) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() ?? [];
    const toSheet = layer.getScreenCTM().inverse();
    let d = '';
    for (const ev of events.length ? events : [e]) {
      if (!allow(ev.timeStamp) || !active) break;
      const p = toPoint(ev, toSheet);
      active.points.push(p);
      d += `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
    if (d && active) active.path.setAttribute('d', active.path.getAttribute('d') + d);
  });

  const end = (e) => {
    if (!active || e.pointerId !== active.id) return;
    const { points } = active;
    release();
    onStrokeEnd?.(points);
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  return {
    layer,
    /** @returns {Stroke[]} every stroke on the sheet, in sheet units */
    get strokes() {
      return strokes;
    },
    /** A new attempt: no ink, input open. */
    reset() {
      wipe();
      locked = false;
    },
    /** Clear wipes the whole sheet. */
    clear: wipe,
    /** Stop taking input; the stroke in progress keeps only the points made by `at`. */
    halt(at) {
      if (active) {
        active.points.splice(0, Infinity, ...active.points.filter((p) => p.t <= at));
        if (active.points.length) active.path.setAttribute('d', pathData(active.points));
        else active.path.remove();
      }
      release();
      locked = true;
    },
  };
}
