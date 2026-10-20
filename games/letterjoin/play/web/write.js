import { toTraceText } from './activity.js';
import { copyImageSize, renderCopyPng } from './copy.js';
import { formatClock, storedScore } from './format.js';
import { createInk } from './ink.js';
import { svgNode } from './render.js';
import { HARD_BONUS, pointsFor } from './scoreboard.js';
import { SHEET_MAX_WIDTH, SHEET_MIN_WIDTH, X_HEIGHT } from './sheet.js';
import { initialPad, padReducer, padGeometry, strokesOn } from './write-pad.js';
import { alignWords, guidelineFit, textWords, writeScore } from './write-score.js';

/**
 * Hard mode's writing view: the text in a box, a pad of guide lines under it, and the child's own writing, read a
 * line at a time. The rules live in write-pad.js and write-score.js; this is the DOM. A score that includes the
 * reading is saved as a hard result; a score from the guide lines alone is not, since nobody checked the words.
 * @typedef {import('./write-pad.js').PadGeometry} PadGeometry
 * @typedef {{ text: string, box: { x: number, y: number, w: number, h: number }, line: number }} PlacedWord a read word, box in sheet units
 * @typedef {{ status: 'pending' } | { status: 'read', words: PlacedWord[] } | { status: 'failed' }} LineRead
 */

/** Lines are read in order, at most this many at a time. */
const READS_AT_ONCE = 2;
const RULES = ['ascender', 'xLine', 'baseline', 'descender'];

/**
 * @param {{
 *   api: () => ReturnType<import('./api.js').createApiClient>,
 *   onBack: () => void,
 *   onStroke: () => void,
 *   onSaved: () => void,
 *   nextAfter: (activity: import('./api.js').ListedActivity) => import('./api.js').ListedActivity | null,
 *   onNext: (activity: import('./api.js').ListedActivity) => void,
 * }} options `onSaved` runs once the activity's result has been replaced by the one just saved.
 */
export function createWriteView({ api, onBack, onStroke, onSaved, nextAfter, onNext }) {
  const $ = (id) => document.getElementById(id);
  const screen = $('write-screen');
  const pad = /** @type {SVGSVGElement} */ ($('write-pad'));
  const prompt = $('write-prompt');
  const clock = $('write-clock');

  /** @type {import('./api.js').ListedActivity | null} */
  let activity = null;
  /** @type {PadGeometry | null} */
  let geometry = null;
  let state = initialPad();
  /** @type {string[]} */
  let expected = [];
  /** @type {HTMLSpanElement[]} */
  let spans = [];
  /** @type {LineRead[]} sparse: a line left with no ink is never read */
  let reads = [];
  /** @type {number[]} */
  let queue = [];
  let inFlight = 0;
  /** @type {(() => void)[]} */
  let waiting = [];
  let alignment = alignWords([], []);
  let finished = false;
  /** @type {number | null} */
  let startedAt = null;
  let elapsedMs = 0;
  let ticker = 0;
  let result = null;
  /** Bumped by every open and close, so a read that answers late cannot touch the next attempt. */
  let run = 0;

  const content = svgNode('g', { class: 'pad-content' });
  const guides = svgNode('g', { 'data-guide': '' });
  const marks = svgNode('g', { class: 'pad-marks' });
  const edge = svgNode('rect', { class: 'pad-edge' });
  const ink = createInk(pad, {
    allow: () => geometry !== null && !finished,
    onStrokeStart: (t, stroke) => {
      if (startedAt === null) {
        startedAt = t;
        ticker = setInterval(tick, 100);
      }
      onStroke();
      dispatch({ type: 'penDown', point: stroke[0] });
    },
    onStrokeEnd: (stroke) => dispatch({ type: 'penUp', points: [...stroke] }),
  });
  content.append(edge, guides, marks, ink.layer);
  pad.append(content);

  function tick() {
    dispatch({ type: 'tick', t: performance.now() });
    renderClock();
  }

  /** @param {import('./write-pad.js').PadEvent} event */
  function dispatch(event) {
    const out = padReducer(geometry, state, event);
    state = out.state;
    if (out.effects.length) drawGuides();
    for (const effect of out.effects) {
      if (effect.type === 'advance') scroll();
      else enqueue(effect.line);
    }
    renderControls();
  }

  /** Once it has caught up, the line being written is second from the top, at the same height on the screen. */
  function scroll({ animate = true } = {}) {
    const transform = `translateY(${(1 - state.view) * geometry.lineHeight}px)`;
    if (content.style.transform === transform) return;
    if (!animate) content.style.transition = 'none';
    content.style.transform = transform;
    if (!animate) {
      content.getBoundingClientRect();
      content.style.transition = '';
    }
  }

  function drawGuides() {
    const { width, lineHeight, ascender, xHeight, baseline, descender } = geometry;
    const at = { ascender, xLine: baseline - xHeight, baseline, descender };
    const lines = Array.from({ length: state.line + geometry.visibleLines }, (_, i) => i);
    guides.replaceChildren(...lines.flatMap((i) => RULES.map((kind) => {
      const y = i * lineHeight + at[kind];
      return svgNode('line', { x1: 0, x2: width, y1: y, y2: y, 'data-rule': kind });
    })));
  }

  /** The band of one line from above its ascender to below its descender, in sheet units. */
  function lineArea(line) {
    const margin = 0.5 * geometry.xHeight;
    const top = line * geometry.lineHeight;
    return { x: 0, y: top + geometry.ascender - margin, width: geometry.width, height: geometry.descender - geometry.ascender + 2 * margin };
  }

  function enqueue(line) {
    reads[line] = { status: 'pending' };
    queue.push(line);
    pump();
  }

  function pump() {
    while (inFlight < READS_AT_ONCE && queue.length) {
      const line = queue.shift();
      inFlight++;
      readLine(line, run).finally(() => {
        inFlight--;
        pump();
        if (inFlight === 0 && queue.length === 0) for (const resolve of waiting.splice(0)) resolve();
      });
    }
  }

  const allRead = () => new Promise((resolve) => (inFlight === 0 && queue.length === 0 ? resolve() : waiting.push(resolve)));

  async function readLine(line, mine) {
    const area = lineArea(line);
    let read;
    try {
      const png = await renderCopyPng(area, strokesOn(state, line).map((s) => s.points), { color: '#000' });
      const { words } = await api().readHandwriting(png);
      const { scale } = copyImageSize(area);
      read = { status: 'read', words: words.map(({ text, box }) => ({ text, line, box: { x: area.x + box.x / scale, y: area.y + box.y / scale, w: box.w / scale, h: box.h / scale } })) };
    } catch {
      read = { status: 'failed' };
    }
    if (mine !== run) return;
    reads[line] = read;
    realign();
  }

  /** Words read so far, in line order, up to the first line still being read. */
  function readSoFar() {
    const words = [];
    for (const read of reads) {
      if (!read) continue;
      if (read.status === 'pending') break;
      if (read.status === 'read') words.push(...read.words);
    }
    return words;
  }

  function realign() {
    const words = readSoFar();
    alignment = alignWords(expected, words.map((w) => w.text));
    renderPrompt();
    renderMarks(words);
  }

  function renderPrompt() {
    spans.forEach((span, i) => {
      const word = alignment.words[i];
      const status = i < alignment.reached ? word.status : i === alignment.reached ? 'next' : '';
      span.className = status;
      if (status === 'misread') {
        span.dataset.read = word.read;
        span.title = `Read as “${word.read}”`;
      } else {
        delete span.dataset.read;
        span.removeAttribute('title');
      }
    });
    const cursor = spans[alignment.reached];
    if (cursor && (cursor.offsetTop < prompt.scrollTop || cursor.offsetTop + cursor.offsetHeight > prompt.scrollTop + prompt.clientHeight)) {
      prompt.scrollTop = Math.max(0, cursor.offsetTop - prompt.clientHeight / 3);
    }
  }

  /** A tick or a cross under each word read, at the box the reader found it in. */
  function renderMarks(words) {
    const statusOf = new Map(alignment.words.filter((w) => w.readIndex !== null).map((w) => [w.readIndex, w.status]));
    marks.replaceChildren(...words.map((word, i) => {
      const right = statusOf.get(i) === 'correct';
      const mark = svgNode('text', {
        x: word.box.x + word.box.w / 2,
        y: word.line * geometry.lineHeight + geometry.descender + 2,
        'font-size': 0.5 * geometry.xHeight,
        'data-mark': right ? 'right' : 'wrong',
      });
      mark.textContent = right ? '✓' : '✗';
      return mark;
    }));
  }

  function renderClock() {
    if (startedAt !== null && !finished) elapsedMs = performance.now() - startedAt;
    clock.textContent = formatClock(elapsedMs);
    clock.dataset.state = startedAt === null ? 'waiting' : 'running';
  }

  function renderControls() {
    edge.setAttribute('y', String(state.line * geometry.lineHeight));
    if (state.phase.kind !== 'writing') edge.setAttribute('data-on', '');
    else edge.removeAttribute('data-on');
    $('write-newline').disabled = finished;
    $('write-done').disabled = finished || state.strokes.length === 0;
  }

  async function done() {
    if (finished || state.strokes.length === 0) return;
    finished = true;
    const mine = run;
    renderClock();
    clearInterval(ticker);
    ink.halt(performance.now());
    if (strokesOn(state, state.line).length && !reads[state.line]) enqueue(state.line);
    renderControls();
    $('write-done').textContent = 'Reading…';
    await allRead();
    if (mine !== run) return;
    showResults();
  }

  function showResults() {
    const readable = reads.every((read) => !read || read.status === 'read');
    const fit = guidelineFit(state.strokes, geometry);
    result = { ...writeScore({ alignment, fit, readable }), fit };
    const panel = $('write-results');
    panel.dataset.tone = result.score >= 80 ? 'good' : result.score >= 55 ? 'ok' : 'low';
    $('wr-score').textContent = String(result.score);
    $('wr-read').textContent = readable ? `Words read correctly: ${result.correct} of ${result.expected}` : 'Words read correctly: not checked';
    $('wr-lines').textContent = `On the lines: ${Math.round(fit * 100)}%`;
    $('wr-points').hidden = !readable;
    $('wr-points').textContent = `${result.score} × ${HARD_BONUS} = ${pointsFor({ score: result.score, hard: true })} points`;
    $('wr-note').hidden = readable;
    $('wr-note').textContent = "We couldn't read your writing this time, so this one isn't saved. Try again in a minute.";
    const misses = readable ? alignment.words.filter((w) => w.status !== 'correct') : [];
    $('wr-misses').replaceChildren(...misses.map((w) => {
      const item = document.createElement('li');
      item.textContent = w.status === 'misread' ? `${w.expected}: read as “${w.read}”` : `${w.expected}: not found`;
      item.dataset.status = w.status;
      return item;
    }));
    const next = nextAfter(activity);
    $('wr-next').hidden = !next;
    $('wr-back').classList.toggle('primary', !next);
    $('write-controls').hidden = true;
    panel.hidden = false;
    if (result.basis === 'readingAndLines') save();
  }

  /** A failed save never hides the score or blocks Next and Back. */
  async function save() {
    const saving = activity;
    const mine = run;
    // One id per finished attempt, reused by Retry, so the server never stores the same attempt twice.
    const payload = { attemptId: crypto.randomUUID(), score: storedScore(result.score), timeMs: Math.round(elapsedMs), hard: true };
    const line = (text, tone, retry) => {
      if (mine !== run) return;
      $('wr-save').hidden = false;
      $('wr-save').dataset.tone = tone;
      $('wr-save-message').textContent = text;
      $('wr-save-retry').hidden = !retry;
    };
    const attempt = async () => {
      line('Saving your result…', 'ok', false);
      try {
        saving.result = await api().saveResult(saving.id, payload);
        onSaved();
        line('Result saved.', 'ok', false);
      } catch {
        line("Couldn't save your result.", 'error', true);
      }
    };
    $('wr-save-retry').onclick = attempt;
    await attempt();
  }

  function open(next) {
    close();
    activity = next;
    screen.hidden = false;
    $('write-title').textContent = activity.title;
    $('write-results').hidden = true;
    $('wr-save').hidden = true;
    $('write-controls').hidden = false;
    $('write-done').textContent = 'Done';
    expected = textWords(toTraceText(activity));
    spans = expected.map((word) => Object.assign(document.createElement('span'), { textContent: word }));
    prompt.replaceChildren(...spans.flatMap((span, i) => (i ? [' ', span] : [span])));
    prompt.scrollTop = 0;
    const width = Math.min(SHEET_MAX_WIDTH, Math.max(SHEET_MIN_WIDTH, Math.round($('write-stage').clientWidth)));
    geometry = padGeometry({ width, xHeight: X_HEIGHT[activity.lineSize] });
    pad.setAttribute('viewBox', `0 0 ${width} ${geometry.visibleLines * geometry.lineHeight}`);
    pad.style.aspectRatio = `${width} / ${geometry.visibleLines * geometry.lineHeight}`;
    for (const [key, value] of Object.entries({ x: width - geometry.edgeMargin, width: geometry.edgeMargin, height: geometry.lineHeight })) edge.setAttribute(key, String(value));
    ink.reset();
    drawGuides();
    scroll({ animate: false });
    realign();
    renderClock();
    renderControls();
  }

  function close() {
    run++;
    clearInterval(ticker);
    screen.hidden = true;
    state = initialPad();
    reads = [];
    queue = [];
    waiting = [];
    finished = false;
    startedAt = null;
    elapsedMs = 0;
    result = null;
    marks.replaceChildren();
  }

  $('write-newline').addEventListener('click', () => !finished && dispatch({ type: 'newLine' }));
  $('write-done').addEventListener('click', done);
  $('wr-again').addEventListener('click', () => open(activity));
  for (const id of ['write-back', 'wr-back']) $(id).addEventListener('click', onBack);
  $('wr-next').addEventListener('click', () => {
    const next = activity && nextAfter(activity);
    if (next) onNext(next);
  });

  return {
    open,
    close,
    /** For the end to end test under `?debug`. */
    inspect: {
      geometry: () => geometry,
      /** Where a point in sheet units is on the screen right now, scroll included. */
      toClient: (x, y) => {
        const p = new DOMPoint(x, y).matrixTransform(content.getScreenCTM());
        return { x: p.x, y: p.y };
      },
      state: () => state,
      alignment: () => alignment,
      result: () => result,
    },
  };
}
