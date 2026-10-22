import { LEVELS, LEVEL_INFO, toTraceText, typeLabel } from './activity.js';
import { createAttempt, guidesHidden } from './attempt.js';
import { ask, dismiss, QUESTIONS } from './confirm.js';
import { renderCopyPng } from './copy.js';
import { createDeadline } from './deadline.js';
import { formatClock, formatTenths, shownScore, storedScore, timerLabel } from './format.js';
import { FONT_REGISTRY, loadFace, startingStyle } from './fonts.js';
import { startFireworks } from './fireworks.js';
import { HARD_KEY, HARD_TYPES, createHardMode } from './hard-mode.js';
import { createApi } from './api.js';
import { dayLabel as boardDayLabel, emptyLevelText, pointsText } from './board.js';
import { createInk } from './ink.js';
import { createPracticeClock } from './practice-clock.js';
import { localDay } from './practice.js';
import { dayLabel, localDayKey, summarizeDays } from './progress.js';
import { buildMask, drawPaper, drawTarget, sizeSheet } from './render.js';
import { HARD_BONUS, cheerFor, chipText, summarize } from './scoreboard.js';
import { score, toleranceFor } from './scoring.js';
import { SECTIONS_KEY, childGroups, createSections, nextActivity, workingLevel } from './sections.js';
import { GRID_SCALE, SIZE_STEPS, layoutSheet, stepSize } from './sheet.js';
import { createWriteView } from './write.js';
import { enter, ready } from '/shell/v1/index.js';

const session = await enter({ game: 'letterjoin' });
const api = createApi(session.api);
const settings = await api.settings().catch(() => ({ dailyPracticeMinutes: 0, hardModeDefault: false }));
/** The shell's storage, keyed by game and child, in the shape the models take. */
const storage = { getItem: (key) => session.storage.get(key), setItem: (key, value) => session.storage.set(key, value) };

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const sheet = $('sheet');

/** @type {import('./api.js').ListedActivity[]} */
let activities = [];
/** @type {import('./api.js').ListedActivity | null} */
let current = null;
/** @type {import('./sheet.js').Layout | null} Null while the sheet is being laid out, which also keeps the pen off it. */
let layout = null;
/** The child's choice on the results bar. Whether the guides are actually hidden is guidesHidden(), never stored. */
let showGuides = true;
let laidOutWidth = 0;
/** The letter style of the current attempt. The child may change it until the first stroke. */
let style = /** @type {import('./activity.js').LetterStyle} */ ('print');
/** The child's letter size, a step from SIZE_STEPS. Like the style, it may change until the first stroke. */
let size = 1;
let ticker = null;
/** Bumped when an activity opens, so an upload that finishes late cannot mark the new attempt sent. */
let uploadRun = 0;
/** The daily practice clock, once signed in. */
let practice = null;

const hardMode = createHardMode(() => storage, HARD_KEY, settings.hardModeDefault);
const writeView = createWriteView({
  api: () => api,
  onBack: () => showList(),
  onStroke: () => practice?.stroke(),
  onSaved: () => refreshChip(),
  nextAfter: (activity) => nextAfter(activity),
  onNext: (activity) => open(activity),
});

const TRACE_LABEL = sheet.getAttribute('aria-label');
const now = () => performance.now();
const attempt = createAttempt(onAttempt);
const deadline = createDeadline({ now, setTimer: setTimeout, clearTimer: clearTimeout, onExpire: (at) => end('expire', at) });
const ink = createInk(sheet, {
  allow: (t) => layout !== null && !deadline.check(t),
  onStrokeStart: (t) => {
    attempt.send({ type: 'strokeStart', t });
    practice?.stroke();
  },
});

/** The style and size this device last picked. Storage can be missing or blocked (private browsing), so they are only hints. */
const STYLE_KEY = 'letterStyle';
const SIZE_KEY = 'letterSize';
const remembered = (key) => session.storage.get(key);
const remember = (key, value) => session.storage.set(key, value);

const percent = (v) => `${Math.round(v * 100)}%`;
const toneFor = (s) => (s >= 80 ? 'good' : s >= 55 ? 'ok' : 'low');
const verdictFor = { good: 'Great tracing!', ok: 'Lovely work! Stay a little closer to the lines next time.', low: 'Well done for finishing! Try again any time and watch your score grow.' };

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Published activities in the order the list shows them, level by level, which is what Next walks through. */
const playable = () => childGroups(activities).flatMap((group) => group.items).filter((a) => a.status === 'published');
const nextAfter = (activity) => nextActivity(playable(), activity);

/** A hard mode result had no timer to beat, so the card says it was hard instead of how long it took. */
const doneText = (result) => `✓ ${shownScore(result.score)} · ${result.hard ? 'Hard' : formatClock(result.timeMs)}`;

/**
 * The card opens the activity. Its hard mode toggle is a separate button beside it, because a button inside a
 * button is not allowed, and is placed over the card's corner.
 */
function activityCard(activity) {
  const { result } = activity;
  const preview = activity.type === 'words' ? activity.category : toTraceText(activity).split('\n')[0];
  const card = h('button', { type: 'button', className: 'activity-card', onclick: () => open(activity) },
    h('div', { className: 'top' },
      h('span', { className: 'badge', textContent: typeLabel(activity.type) }),
      ...(activity.status === 'draft' ? [h('span', { className: 'badge draft', textContent: 'Draft' })] : []),
      ...(result ? [h('span', { className: 'done', textContent: doneText(result) })] : [])),
    h('span', { className: 'title', textContent: activity.title }),
    h('span', { className: 'preview', textContent: activity.description || preview }),
    h('span', { className: 'meta', textContent: timerLabel(activity.timeLimitSec) }));
  card.dataset.id = activity.id;
  if (result) card.dataset.done = '';
  if (!HARD_TYPES.has(activity.type)) return h('li', { className: 'card-slot' }, card);
  const toggle = h('button', {
    type: 'button',
    className: 'hard-toggle',
    ariaLabel: `Hard mode for ${activity.title}`,
    onclick: () => {
      hardMode.setCard(activity.id, !hardMode.isHard(activity));
      showHardMode();
    },
  }, h('span', { className: 'hard-track', ariaHidden: 'true' }), h('span', { textContent: 'Hard' }));
  toggle.setAttribute('role', 'switch');
  return h('li', { className: 'card-slot' }, card, toggle);
}

/** Marks hard mode on the switch and on every card in place, so the list keeps its scroll, its open levels and the focus. */
function showHardMode() {
  $('hard-all').setAttribute('aria-checked', String(hardMode.all()));
  for (const card of $('activity-list').querySelectorAll('.activity-card')) {
    const activity = activities.find((a) => a.id === card.dataset.id);
    const on = hardMode.isHard(activity);
    card.toggleAttribute('data-hard', on);
    card.parentElement.querySelector('.hard-toggle')?.setAttribute('aria-checked', String(on));
  }
}

const sections = createSections(() => storage, SECTIONS_KEY.child);

function renderList() {
  const groups = childGroups(activities).filter((group) => group.items.length > 0);
  const working = workingLevel(groups);
  $('activity-list').replaceChildren(...groups.map(({ level, items }) => {
    const info = LEVEL_INFO[level];
    const done = items.filter((a) => a.result).length;
    const head = h('summary', { className: 'level-head' },
      h('h3', { textContent: info.label }),
      h('span', { className: 'level-ages', textContent: info.ages }),
      h('span', { className: 'level-blurb', textContent: info.blurb }),
      h('span', { className: 'level-done', textContent: `${done} of ${items.length} done` }),
      h('span', { className: 'chevron', ariaHidden: 'true' }));
    const section = h('details', { className: 'level', open: sections.isOpen(level, level === working) },
      head,
      h('ol', { className: 'activity-grid' }, ...items.map(activityCard)));
    section.dataset.level = level;
    head.addEventListener('click', () => sections.choose(level, !section.open));
    // A heading stuck at the top would leave the closed band out of sight above.
    section.addEventListener('toggle', () => section.open || head.scrollIntoView({ block: 'nearest' }));
    return h('li', {}, section);
  }));
  $('list-empty').hidden = activities.length > 0;
  showHardMode();
}

/** Leaving the tracing page, whichever screen comes next. */
function leaveTracing() {
  deadline.stop();
  stopTicker();
  current = null;
  $('trace-screen').hidden = true;
  writeView.close();
}

function showList() {
  const played = current;
  leaveTracing();
  $('scoreboard-screen').hidden = true;
  $('progress-screen').hidden = true;
  $('board-screen').hidden = true;
  $('list-screen').hidden = false;
  if (played) sections.choose(played.level, true);
  renderList();
  refreshChip();
  if (played) document.querySelector(`.activity-card[data-id="${CSS.escape(played.id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** The overall points in the header, from the latest result of every activity. */
function refreshChip() {
  const summary = summarize(activities);
  $('score-chip-text').textContent = chipText(summary);
  $('score-chip').setAttribute('aria-label', summary.done === 0 ? 'Open my scoreboard' : `Open my scoreboard. You have ${summary.points} points from ${summary.done} activities.`);
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const medals = ['🥇', '🥈', '🥉'];

function countUp(node, to) {
  node.textContent = to.toLocaleString('en-GB');
  if (reducedMotion() || to === 0) return;
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 900);
    node.textContent = Math.round(to * (1 - (1 - k) ** 3)).toLocaleString('en-GB');
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function scoreRow(entry, i) {
  const { activity, points, hard, timeMs, stars, cheer } = entry;
  const row = h('li', { className: 'sb-row' },
    h('span', { className: 'sb-rank', textContent: medals[i] ?? String(i + 1) }),
    h('div', { className: 'sb-main' },
      h('button', { type: 'button', className: 'sb-link', textContent: activity.title, onclick: () => open(activity), ariaLabel: `${activity.title}. Open this activity again.` }),
      h('span', { className: 'sb-cheer', textContent: hard ? `${cheer} Hard mode ×${HARD_BONUS}` : cheer })),
    h('span', { className: 'sb-stars', role: 'img', ariaLabel: `${stars} out of 5 stars`, textContent: '★'.repeat(stars) + '☆'.repeat(5 - stars) }),
    h('span', { className: 'sb-score', textContent: `${points}` }),
    h('span', { className: 'sb-time', textContent: formatClock(timeMs) }));
  row.dataset.id = activity.id;
  row.dataset.level = activity.level;
  return row;
}

function showScoreboard() {
  leaveTracing();
  $('list-screen').hidden = true;
  $('progress-screen').hidden = true;
  $('board-screen').hidden = true;
  $('scoreboard-screen').hidden = false;
  const summary = summarize(activities);
  countUp($('sb-points'), summary.points);
  const finished = summary.total > 0 && summary.done === summary.total;
  $('sb-message').textContent = summary.done === 0
    ? 'Finish your first activity to start collecting points. Every one counts!'
    : finished
      ? `Amazing! You finished every activity and collected ${summary.points.toLocaleString('en-GB')} points.`
      : `You have collected ${summary.points.toLocaleString('en-GB')} points from ${summary.done} ${summary.done === 1 ? 'activity' : 'activities'}. Every activity you finish adds more!`;
  $('sb-progress-bar').style.width = `${summary.total ? (100 * summary.done) / summary.total : 0}%`;
  $('sb-progress-text').textContent = `${summary.done} of ${summary.total} activities explored`;
  $('sb-progress-img').setAttribute('aria-label', $('sb-progress-text').textContent);
  const next = summary.todo[0] ?? null;
  $('sb-next').hidden = !next;
  $('sb-next').textContent = summary.done === 0 ? 'Start your first activity' : 'Try something new';
  $('sb-next').onclick = () => next && open(next);
  $('sb-list').replaceChildren(...summary.entries.map(scoreRow));
  $('sb-list').hidden = summary.entries.length === 0;
  $('sb-heading').scrollIntoView?.({ block: 'start' });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const childSpeed = (speed) => (speed === null ? 'no time' : `${speed.toFixed(1)} letters a minute`);

function stat(value, label) {
  return h('div', { className: 'pg-stat' }, h('span', { className: 'pg-num', textContent: value }), h('span', { className: 'pg-label', textContent: label }));
}

/** Every screen shows whole-number scores, so the day's average is rounded the same way. */
function dayCard(day, today) {
  const levels = LEVELS.filter((level) => day.byLevel[level]).map((level) => {
    const { count, accuracy, speed } = day.byLevel[level];
    const item = h('li', { className: 'pg-level', textContent: `${LEVEL_INFO[level].label} · ${plural(count, 'activity', 'activities')} · score ${Math.round(accuracy)} · ${childSpeed(speed)}` });
    item.dataset.level = level;
    return item;
  });
  const card = h('li', { className: 'pg-day' },
    h('h3', { textContent: day.date === today ? 'Today' : dayLabel(day.date) }),
    h('div', { className: 'pg-stats' },
      stat(String(day.count), day.count === 1 ? 'activity' : 'activities'),
      stat(String(Math.round(day.accuracy)), 'average score'),
      stat(day.speed === null ? 'no time' : day.speed.toFixed(1), 'letters a minute')),
    h('ul', { className: 'pg-levels' }, ...levels));
  card.dataset.date = day.date;
  return card;
}

/** Bumped each time the screen opens, so a slow answer cannot fill a screen the child already left. */
let progressRun = 0;

async function showProgress() {
  leaveTracing();
  $('list-screen').hidden = true;
  $('scoreboard-screen').hidden = true;
  $('board-screen').hidden = true;
  $('progress-screen').hidden = false;
  const run = ++progressRun;
  $('pg-status').hidden = false;
  $('pg-status').textContent = 'Loading…';
  $('pg-days').replaceChildren();
  $('pg-note').hidden = true;
  try {
    const days = summarizeDays(await api.progress());
    if (run !== progressRun) return;
    const today = localDayKey(new Date().toISOString());
    $('pg-days').replaceChildren(...days.map((day) => dayCard(day, today)));
    $('pg-status').hidden = days.length > 0;
    $('pg-status').textContent = 'Finish an activity and your day will show up here.';
    $('pg-note').hidden = days.length === 0;
  } catch (err) {
    if (run === progressRun) $('pg-status').textContent = err.message;
  }
}

/** One level's table: a row per child, a column per day, and the child's own row marked. */
function boardLevel({ level, children }, days) {
  const { label } = LEVEL_INFO[level];
  const today = days.at(-1);
  const table = h('table', { className: 'bd-table' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', textContent: 'Name' }),
      ...days.map((day) => h('th', { scope: 'col', textContent: boardDayLabel(day), className: day === today ? 'today' : '' })),
      h('th', { scope: 'col', textContent: 'Total' }))),
    h('tbody', {}, ...children.map((child) => h('tr', { className: child.me ? 'me' : '' },
      h('th', { scope: 'row' }, child.name, ...(child.me ? [h('span', { className: 'bd-you', textContent: 'You' })] : [])),
      ...child.points.map((points) => h('td', { textContent: pointsText(points), className: points === 0 ? 'none' : '' })),
      h('td', { className: 'total', textContent: pointsText(child.total) })))));
  const section = h('section', { className: 'bd-level' },
    h('h3', { textContent: label }),
    children.length > 0 ? h('div', { className: 'bd-wrap' }, table) : h('p', { className: 'empty', textContent: emptyLevelText(label) }));
  section.dataset.level = level;
  return section;
}

function renderBoard(board) {
  $('bd-status').hidden = true;
  $('bd-switch').hidden = false;
  $('bd-switch').disabled = false;
  $('bd-switch').setAttribute('aria-checked', String(board.optedIn));
  $('bd-explain').hidden = board.optedIn;
  $('bd-note').hidden = !board.optedIn;
  $('bd-levels').replaceChildren(...(board.optedIn ? board.levels.map((group) => boardLevel(group, board.days)) : []));
}

/** Bumped each time the board loads, so a slow answer cannot replace a newer one. */
let boardRun = 0;

async function loadBoard() {
  const run = ++boardRun;
  try {
    const board = await api.board(localDay(Date.now()));
    if (run === boardRun) renderBoard(board);
  } catch (err) {
    if (run !== boardRun) return;
    $('bd-switch').disabled = false;
    $('bd-status').hidden = false;
    $('bd-status').textContent = err.message;
  }
}

function showBoard() {
  leaveTracing();
  $('list-screen').hidden = true;
  $('scoreboard-screen').hidden = true;
  $('progress-screen').hidden = true;
  $('board-screen').hidden = false;
  $('bd-switch').hidden = true;
  $('bd-explain').hidden = true;
  $('bd-note').hidden = true;
  $('bd-levels').replaceChildren();
  $('bd-status').hidden = false;
  $('bd-status').textContent = 'Loading…';
  return loadBoard();
}

async function toggleBoard() {
  const sw = $('bd-switch');
  const on = sw.getAttribute('aria-checked') !== 'true';
  sw.disabled = true;
  try {
    await api.setBoard(on);
  } catch (err) {
    sw.disabled = false;
    $('bd-status').hidden = false;
    $('bd-status').textContent = err.message;
    return;
  }
  sw.setAttribute('aria-checked', String(on));
  $('bd-status').hidden = true;
  await loadBoard();
}

let fireworks = null;
let cheerTimer = 0;

/** Fireworks and a cheer in the middle of the screen when an activity is scored. It never blocks the pen or the buttons. */
function celebrate(score) {
  fireworks?.stop();
  clearTimeout(cheerTimer);
  const cheer = $('cheer');
  cheer.textContent = cheerFor(score);
  cheer.hidden = false;
  cheer.classList.remove('pop');
  void cheer.offsetWidth;
  cheer.classList.add('pop');
  const canvas = $('fireworks');
  const reduced = reducedMotion();
  canvas.classList.toggle('on', !reduced);
  const show = startFireworks(canvas, { reduced });
  fireworks = show;
  show.done.then(() => { if (fireworks === show) canvas.classList.remove('on'); });
  cheerTimer = setTimeout(() => { cheer.hidden = true; }, 2600);
}

/** An activity opens in the mode its card is in: written freely in hard mode, traced otherwise. */
function open(activity) {
  leaveTracing();
  current = activity;
  $('list-screen').hidden = true;
  $('scoreboard-screen').hidden = true;
  $('progress-screen').hidden = true;
  $('board-screen').hidden = true;
  if (hardMode.isHard(activity)) {
    writeView.open(activity);
    return;
  }
  showGuides = true;
  $('trace-screen').hidden = false;
  $('activity-title').textContent = activity.title;
  style = startingStyle(activity, remembered(STYLE_KEY));
  size = SIZE_STEPS.includes(Number(remembered(SIZE_KEY))) ? Number(remembered(SIZE_KEY)) : 1;
  $('styles').replaceChildren(...(activity.allowedStyles.length > 1 ? activity.allowedStyles : []).map((value) => {
    const button = h('button', { type: 'button', textContent: FONT_REGISTRY[value].label, onclick: () => chooseStyle(value) });
    button.dataset.style = value;
    return button;
  }));
  layout = null;
  sheet.replaceChildren();
  sheet.setAttribute('aria-label', TRACE_LABEL);
  stage.scrollTop = 0;
  ink.reset();
  uploadRun++;
  attempt.send({ type: 'load', limitMs: activity.timeLimitSec && activity.timeLimitSec * 1000, mode: activity.mode });
  relayout();
}

const tracingStarted = () => attempt.state.phase !== 'idle';

/** Before the first stroke a new style lays the sheet out again in its font. After it the style is locked. */
function chooseStyle(value) {
  if (tracingStarted() || value === style) return;
  style = value;
  remember(STYLE_KEY, value);
  layout = null;
  render();
  relayout();
}

/** Bigger or smaller letters lay the sheet out again, and are locked by the first stroke like the style. */
function chooseSize(by) {
  const next = stepSize(size, by);
  if (tracingStarted() || next === size) return;
  size = next;
  remember(SIZE_KEY, String(next));
  layout = null;
  render();
  relayout();
}

/**
 * Before the first stroke the text reflows to the stage width. After it the layout is kept and the sheet only
 * scales, so rotating keeps the ink where it was drawn.
 */
async function relayout() {
  const activity = current;
  const chosen = style;
  const chosenSize = size;
  if (!activity || (layout && tracingStarted())) return;
  const face = await loadFace(chosen);
  const width = stage.clientWidth;
  if (current !== activity || chosen !== style || chosenSize !== size || width < 10 || (layout && tracingStarted())) return;
  layout = layoutSheet(toTraceText(activity), { width, face, lineSize: activity.lineSize, size });
  laidOutWidth = width;
  sizeSheet(sheet, layout);
  sheet.replaceChildren(drawTarget(layout, activity.paper), ink.layer);
}

/** One score over the whole sheet: text the child never reached is untraced and lowers coverage. */
function scoreSheet() {
  const mask = buildMask(layout);
  return score({
    mask: mask.data,
    width: mask.width,
    height: mask.height,
    strokes: ink.strokes.map((s) => s.map((p) => ({ x: p.x * GRID_SCALE, y: p.y * GRID_SCALE }))),
    tolerance: toleranceFor(layout.fontSize * GRID_SCALE),
  });
}

/** Finish or expire: halt input at `t` and score what was drawn by then. */
function end(type, t) {
  if (attempt.state.phase !== 'tracing') return;
  dismiss();
  deadline.stop();
  ink.halt(t);
  attempt.send({ type, t, result: scoreSheet() });
}

function onAttempt(state, event) {
  if (event.type === 'strokeStart' && state.phase === 'tracing') {
    if (state.limitMs !== null) deadline.start(state.startedAt, state.limitMs);
    startTicker();
  }
  if (state.phase === 'scored' && (event.type === 'finish' || event.type === 'expire')) {
    stopTicker();
    save();
  }
  if (event.type === 'startCopy') showCopySheet();
  if (event.type === 'submit') upload();
  render();
}

/** The same lines on the same paper, with no outline. The layout is kept, so rotation only scales the sheet. */
function showCopySheet() {
  showGuides = true;
  ink.reset();
  sheet.replaceChildren(drawPaper(layout, current.paper), ink.layer);
  sheet.setAttribute('aria-label', 'Blank lines to write on. Write with the pencil, scroll with a finger.');
  stage.scrollTop = 0;
  $('copy-text').textContent = toTraceText(current);
  $('copy-text').style.fontFamily = layout.font.slice(layout.font.indexOf(' ') + 1);
}

/** Only the ink goes up, as a PNG for an admin to look at. Nothing is scored and no result is saved. */
async function upload() {
  const activity = current;
  const run = uploadRun;
  try {
    await api.submitCopy(activity.id, await renderCopyPng(layout, ink.strokes));
    if (run === uploadRun) attempt.send({ type: 'sent' });
  } catch (err) {
    if (run === uploadRun) attempt.send({ type: 'sendFailed', error: err.message });
  }
}

function startTicker() {
  stopTicker();
  ticker = setInterval(renderClock, 100);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

function renderClock() {
  const state = attempt.state;
  const clock = $('clock');
  if (COPY_PHASES.has(state.phase)) {
    clock.dataset.state = 'waiting';
    clock.textContent = 'No timer';
    return;
  }
  if (state.phase === 'idle') {
    clock.dataset.state = 'waiting';
    clock.textContent = formatClock(state.limitMs ?? 0);
    return;
  }
  const elapsed = state.phase === 'scored' ? state.elapsedMs : now() - state.startedAt;
  if (state.limitMs === null) {
    clock.dataset.state = 'running';
    clock.textContent = formatClock(elapsed);
    return;
  }
  const left = Math.max(0, state.limitMs - elapsed);
  clock.dataset.state = left <= 10_000 ? 'warning' : 'running';
  clock.textContent = formatClock(left, { roundUp: true });
}

const COPY_PHASES = new Set(['copying', 'sending', 'unsent', 'sent']);

let lastPhase = 'idle';

function render() {
  const state = attempt.state;
  const { phase } = state;
  const justScored = phase === 'scored' && lastPhase !== 'scored';
  lastPhase = phase;
  const tracing = phase === 'idle' || phase === 'tracing';
  const copying = COPY_PHASES.has(phase);
  for (const button of $('styles').children) {
    button.setAttribute('aria-pressed', String(button.dataset.style === style));
    button.disabled = phase !== 'idle';
  }
  $('size-down').disabled = phase !== 'idle' || size === SIZE_STEPS[0];
  $('size-up').disabled = phase !== 'idle' || size === SIZE_STEPS.at(-1);
  $('styles').hidden = phase !== 'idle';
  $('sizes').hidden = phase !== 'idle';
  $('controls').hidden = phase !== 'tracing';
  $('copy-controls').hidden = phase !== 'copying' && phase !== 'sending';
  $('copy-clear').disabled = !(phase === 'copying' && state.inked);
  $('copy-done').disabled = !(phase === 'copying' && state.inked);
  $('copy-done').textContent = phase === 'sending' ? 'Sending…' : 'Done';
  $('copy-model').hidden = !copying;
  const clean = guidesHidden(showGuides, phase);
  stage.toggleAttribute('data-clean', clean);
  $('guide-toggle').textContent = clean ? 'Show guides' : 'Hide guides';
  $('after').hidden = tracing || phase === 'copying' || phase === 'sending';
  $('start-copy').hidden = !(phase === 'scored' && state.mode === 'traceThenCopy');
  $('copy-retry').hidden = phase !== 'unsent';
  renderClock();
  renderCopyStatus(state);

  if (tracing) {
    show('idle', '', phase === 'tracing' ? 'Keep going, then press Finish.' : state.limitMs === null ? 'Start tracing when you are ready.' : 'The timer starts with your first stroke.', '', '');
    $('save-status').hidden = true;
    return;
  }
  const next = current && nextAfter(current);
  const copyWaits = phase === 'scored' && state.mode === 'traceThenCopy';
  $('next-activity').hidden = !next || copyWaits;
  $('last-note').hidden = Boolean(next) || copyWaits;
  $('next-activity').classList.toggle('primary', phase !== 'unsent');
  if (copying) {
    show(phase === 'sent' ? 'sent' : 'copy', '', phase === 'sent' ? 'Sent for review' : 'Now write it yourself',
      phase === 'copying' ? 'No outline and no timer. Write it on the lines, then press Done.' : '', '');
    return;
  }
  const { result } = state;
  const tone = toneFor(result.score);
  const timeText = state.outcome === 'expired'
    ? `Time's up · ${formatClock(state.limitMs)} limit`
    : `Time ${formatTenths(state.elapsedMs)}`;
  show(tone, shownScore(result.score), verdictFor[tone],
    `Letters covered ${percent(result.coverage)}  ·  On the lines ${percent(result.precision)}`,
    timeText);
  if (justScored) celebrate(shownScore(result.score));
}

const COPY_STATUS = {
  sending: () => ['ok', 'Sending your writing…'],
  unsent: (state) => ['error', `Couldn't send your writing. ${state.error}`],
  sent: () => ['ok', 'Your writing was sent for review.'],
};

function renderCopyStatus(state) {
  const line = $('copy-status');
  const status = COPY_STATUS[state.phase];
  line.hidden = !status;
  if (!status) return;
  [line.dataset.tone, line.textContent] = status(state);
}

function show(tone, scoreText, message, breakdown, time) {
  $('result').dataset.tone = tone;
  $('score').textContent = scoreText;
  $('message').textContent = message;
  $('breakdown').textContent = breakdown;
  $('time-taken').textContent = time;
}

/** A failed save never hides the score or blocks Next and Back. */
async function save() {
  const activity = current;
  const { result, elapsedMs } = attempt.state;
  // One id per scored attempt, reused by Retry, so the server never stores the same attempt twice.
  const payload = { attemptId: crypto.randomUUID(), score: storedScore(result.score), timeMs: elapsedMs };
  const line = (text, tone, retry) => {
    $('save-status').hidden = false;
    $('save-status').dataset.tone = tone;
    $('save-message').textContent = text;
    $('save-retry').hidden = !retry;
  };
  const attemptSave = async () => {
    line('Saving your result…', 'ok', false);
    try {
      const saved = await api.saveResult(activity.id, payload);
      activity.result = saved;
      refreshChip();
      if (current === activity) line('Result saved.', 'ok', false);
    } catch {
      if (current === activity) line("Couldn't save your result.", 'error', true);
    }
  };
  $('save-retry').onclick = attemptSave;
  await attemptSave();
}

// The time is the moment Finish was pressed, so deciding in the question costs nothing. The timer can still end the attempt meanwhile.
$('finish').addEventListener('click', async () => {
  const t = now();
  if (deadline.check(t)) return;
  if (await ask(QUESTIONS.finishTrace)) end('finish', t);
});
$('clear').addEventListener('click', () => ink.clear());
$('size-down').addEventListener('click', () => chooseSize(-1));
$('size-up').addEventListener('click', () => chooseSize(1));
$('guide-toggle').addEventListener('click', () => {
  showGuides = !showGuides;
  render();
});
$('start-copy').addEventListener('click', () => attempt.send({ type: 'startCopy' }));
$('copy-clear').addEventListener('click', () => {
  ink.clear();
  attempt.send({ type: 'clear' });
});
$('copy-done').addEventListener('click', async () => {
  const { state } = attempt;
  if (state.phase !== 'copying' || !state.inked || !await ask(QUESTIONS.sendCopy)) return;
  ink.halt(now());
  attempt.send({ type: 'submit' });
});
$('copy-retry').addEventListener('click', () => attempt.send({ type: 'submit' }));
$('back').addEventListener('click', async () => {
  const { state } = attempt;
  const unsaved = state.phase === 'tracing' || (state.phase === 'copying' && state.inked);
  if (!unsaved || await ask(QUESTIONS.leave)) showList();
});
$('hard-all').addEventListener('click', () => {
  hardMode.setAll(!hardMode.all());
  showHardMode();
});
$('score-chip').addEventListener('click', showScoreboard);
$('sb-back').addEventListener('click', showList);
$('progress-open').addEventListener('click', showProgress);
$('pg-back').addEventListener('click', showList);
$('board-open').addEventListener('click', showBoard);
$('bd-back').addEventListener('click', showList);
$('bd-switch').addEventListener('click', toggleBoard);
$('back-to-list').addEventListener('click', showList);
$('next-activity').addEventListener('click', () => open(nextAfter(current)));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) deadline.check(now());
});

new ResizeObserver(() => {
  if (Math.abs(stage.clientWidth - laidOutWidth) > 1) relayout();
}).observe(stage);

if (new URLSearchParams(location.search).has('debug')) {
  window.__tracing = {
    gridScale: GRID_SCALE,
    state: () => attempt.state,
    practice: () => practice?.state,
    style: () => style,
    size: () => size,
    layout: () => layout,
    strokes: () => ink.strokes,
    mask: () => {
      const m = buildMask(layout);
      return { width: m.width, height: m.height, data: Array.from(m.data) };
    },
  };
  window.__writing = writeView.inspect;
}

/** The time's-up notice waits while it would cost the child something: a timed attempt or the celebration of a score. */
const practiceWaits = () => (attempt.state.phase === 'tracing' && attempt.state.limitMs !== null)
  || !$('cheer').hidden || $('fireworks').classList.contains('on');

practice = createPracticeClock({ api, storage: session.storage, busy: practiceWaits });
practice.start();
try {
  activities = await api.activities();
  showList();
} catch (err) {
  $('list-empty').hidden = false;
  $('list-empty').textContent = err.message;
}
ready();
