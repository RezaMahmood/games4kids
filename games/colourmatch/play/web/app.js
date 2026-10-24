import { createApi } from './api.js';
import { advance, clockLeftAt, clockOut, hide, leave, startGame, tap, toLog, unhide } from './game.js';
import { colourById, roundClockMs, turnsIn } from './rules.js';
import { enter, ready, whileLoading } from '/shell/v1/index.js';

const session = await enter({ game: 'colourmatch' });
const api = createApi(session.api);
const $ = (id) => document.getElementById(id);
const SCREENS = ['start-screen', 'game-screen', 'over-screen', 'board-screen'];
const FLASH_MS = { correct: 400, wrong: 700 };
const ROUND_INTRO_MS = 1500;
const TICK_MS = 100;

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** style.css lays the game out side by side under this query, and the game takes the whole viewport. */
const SHORT_LANDSCAPE = matchMedia('(orientation: landscape) and (max-height: 600px)');

/** Shows one screen and moves focus to its heading, so a keyboard or screen reader user starts at the top of it. */
function show(screen, heading = $(screen).querySelector('h1, h2')) {
  for (const id of SCREENS) $(id).hidden = id !== screen;
  if (screen === 'game-screen' && SHORT_LANDSCAPE.matches) $(screen).scrollIntoView();
  else window.scrollTo(0, 0);
  heading.focus({ preventScroll: true });
}

function say(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text;
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = () => performance.now();

/** What the child plays on, for the log. The first pointer that starts a game wins over the media query's guess. */
function deviceInfo(pointer) {
  return {
    pointer,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: Math.round(window.devicePixelRatio * 100) / 100,
    orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait',
    userAgent: navigator.userAgent.slice(0, 300),
  };
}

const POINTER_TYPES = ['touch', 'mouse', 'pen'];
const pointerOf = (event) => (POINTER_TYPES.includes(event.pointerType) ? event.pointerType : matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse');

/**
 * One game in play, or null between games. `state` is the machine in game.js. `gameId` is made once, so saving again
 * after a failure cannot count the game twice. `timer` is whatever setTimeout or setInterval is pending for the state.
 * @type {{ state: import('./game.js').State, gameId: string, device: object, timer: number, saved: Promise<unknown> | null } | null}
 */
let play = null;

/* The game screen */

const squareButtons = [0, 1, 2, 3].map((index) => {
  const button = h('button', { type: 'button', className: 'square' });
  button.dataset.index = String(index);
  button.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    onTap(index, button, event, pointerOf(event));
  });
  // A keyboard press reaches a button as a click with no pointer. A pointer's click was already handled on pointerdown.
  button.addEventListener('click', (event) => {
    if (event.detail === 0) onTap(index, button, null, 'mouse');
  });
  return button;
});
$('squares').replaceChildren(...squareButtons);

function renderHud(state) {
  const { game } = state;
  $('hud-round').textContent = String(game.round);
  $('hud-score').textContent = String(game.score);
  const dots = Array.from({ length: game.tuning.maxMistakes }, (_, i) => h('i', { className: i < game.mistakes ? 'hit' : '' }));
  $('hud-mistakes').replaceChildren(...dots);
  $('hud-mistakes').setAttribute('aria-label', game.mistakes === 0 ? 'No mistakes in a row' : `${game.mistakes} of ${game.tuning.maxMistakes} mistakes in a row`);
  renderClock(state);
}

function renderClock(state) {
  const left = clockLeftAt(state, now());
  const seconds = Math.ceil(left / 1000);
  $('hud-clock').textContent = String(seconds);
  $('hud-clock').parentElement.classList.toggle('low', seconds <= 3);
}

function renderWord(word) {
  const ink = colourById(word.ink);
  const wordEl = $('word');
  wordEl.textContent = colourById(word.word).name;
  wordEl.style.color = ink.hex;
  wordEl.dataset.word = word.word;
  wordEl.dataset.ink = word.ink;
  wordEl.setAttribute('aria-label', `${colourById(word.word).name}, written in ${ink.name.toLowerCase()}`);
  word.squares.forEach((id, i) => {
    const button = squareButtons[i];
    const colour = colourById(id);
    button.style.setProperty('--square', colour.hex);
    button.dataset.colour = id;
    button.setAttribute('aria-label', colour.name);
    button.classList.remove('tapped', 'right');
  });
}

function renderGame(state) {
  const screen = $('game-screen');
  screen.dataset.phase = state.kind;
  delete screen.dataset.outcome;
  $('flash').textContent = '';
  delete $('flash').dataset.tone;
  renderHud(state);
  if (state.kind === 'roundIntro') {
    const { game } = state;
    $('round-intro-heading').textContent = `Round ${game.round}`;
    $('round-intro-detail').textContent = `${turnsIn(game.tuning, game.round)} words, ${Math.round(roundClockMs(game.tuning, game.round) / 1000)} seconds`;
  } else if (state.kind === 'showing') {
    renderWord(state.word);
  } else if (state.kind === 'feedback') {
    screen.dataset.outcome = state.outcome;
    squareButtons[state.tapped].classList.add('tapped');
    squareButtons[state.right].classList.add('right');
    $('flash').dataset.tone = state.outcome;
    $('flash').textContent = state.outcome === 'correct' ? `+${state.points}` : 'Oops';
  }
}

/** Moves the machine on and schedules whatever the new state waits for: the intro's pause, the clock's ticks or the flash. */
function become(state) {
  if (!play) return;
  clearTimeout(play.timer);
  clearInterval(play.timer);
  play.state = state;
  if (state.kind === 'over') return finish();
  renderGame(state);
  const next = () => become(advance(play.state, Math.random, now(), document.visibilityState === 'hidden'));
  if (state.kind === 'roundIntro') play.timer = setTimeout(next, ROUND_INTRO_MS);
  else if (state.kind === 'feedback') play.timer = setTimeout(next, FLASH_MS[state.outcome]);
  else if (state.kind === 'showing') {
    play.timer = setInterval(() => {
      if (play.state.kind !== 'showing') return;
      if (clockLeftAt(play.state, now()) <= 0 && play.state.hiddenAtNow === null) become(clockOut(play.state));
      else renderClock(play.state);
    }, TICK_MS);
  }
}

function onTap(index, button, event, pointer) {
  if (!play || play.state.kind !== 'showing' || play.state.hiddenAtNow !== null) return;
  const rect = button.getBoundingClientRect();
  const x = event ? (event.clientX - rect.left) / rect.width : 0.5;
  const y = event ? (event.clientY - rect.top) / rect.height : 0.5;
  become(tap(play.state, { index, x, y, pointer }, now()));
}

/** The start screen's rules, in the numbers the admin set. */
function describeRules(tuning) {
  $('rule-hard').textContent = String(tuning.hardMultiplier);
  $('rule-end').textContent = `${tuning.maxMistakes === 1 ? 'A mistake' : `${tuning.maxMistakes} mistakes in a row`}, or a round clock at zero, ends the game.`;
}

async function start(mode, pointer) {
  say('start-status', '');
  let settings;
  try {
    settings = await whileLoading(api.start());
  } catch (err) {
    say('start-status', err.message);
    return;
  }
  describeRules(settings.tuning);
  play = { state: startGame({ mode, ...settings, startedAt: new Date().toISOString(), now: now() }), gameId: crypto.randomUUID(), device: deviceInfo(pointer), timer: 0, saved: null };
  show('game-screen');
  become(play.state);
}

/* Game over */

const WHY = {
  mistakes: (game) => `${game.tuning.maxMistakes} mistakes in a row.`,
  clock: () => 'The round clock ran out.',
  left: () => 'You left the game.',
};

function finish() {
  const { state } = play;
  const { game } = state;
  const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  $('over-score').textContent = String(game.score);
  $('over-why').textContent = `${game.mode === 'hard' ? 'Hard mode. ' : ''}${WHY[state.reason](game)}`;
  $('over-rounds').textContent = `You reached round ${game.round} and got ${plural(game.correct, 'word')} right.`;
  $('over-best').textContent = '';
  $('over-screen').insertBefore($('board'), $('again'));
  show('over-screen');
  void save();
}

/** Sends the game once per gameId. The server's score is the one that counts, so the screen shows it when it arrives. */
async function save() {
  const current = play;
  if (!current || current.saved) return current?.saved;
  say('over-status', 'Saving your score…');
  $('over-retry').hidden = true;
  current.saved = api.save(current.gameId, toLog(current.state, current.device)).then((saved) => {
    if (play !== current) return;
    $('over-score').textContent = String(saved.score);
    $('over-best').textContent = `Your best today is ${saved.bestToday}.`;
    say('over-status', '');
    loadBoard();
  }, (err) => {
    if (play !== current) return;
    current.saved = null;
    say('over-status', `${err.message} Your score was not saved.`);
    $('over-retry').hidden = false;
    $('over-retry').focus();
  });
  return current.saved;
}

/* Leaving and hiding */

document.addEventListener('visibilitychange', () => {
  if (!play || play.state.kind === 'over') return;
  if (document.visibilityState === 'hidden') {
    play.state = hide(play.state, now());
  } else {
    play.state = unhide(play.state, now());
    renderClock(play.state);
  }
});

window.addEventListener('pagehide', () => {
  if (!play || play.state.kind === 'over') return;
  const left = leave(play.state);
  if (left.kind !== 'over') return;
  clearTimeout(play.timer);
  clearInterval(play.timer);
  play.state = left;
  finish();
});

/* The board */

/** The one board section lives in whichever screen is showing it. */
function openBoard() {
  $('board-screen').insertBefore($('board'), $('board-back'));
  show('board-screen', $('board-heading'));
  loadBoard();
}

/** Bumped each time the board loads, so a slow answer cannot replace a newer one. */
let boardRun = 0;

async function loadBoard() {
  const run = ++boardRun;
  say('board-status', 'Loading the board…');
  try {
    const board = await api.board(localDay());
    if (run !== boardRun) return;
    say('board-status', '');
    $('board-switch').hidden = false;
    showOptedIn(board.optedIn);
    $('board-table').hidden = !board.optedIn || board.children.length === 0;
    if (board.optedIn) {
      $('board-rows').replaceChildren(...board.children.map((line) => h('tr', { className: line.me ? 'me' : '' },
        h('th', { scope: 'row', textContent: line.me ? `${line.name} (you)` : line.name }),
        h('td', { textContent: String(line.points.at(-1) ?? 0) }),
        h('td', { textContent: String(line.total) }))));
      if (board.children.length === 0) say('board-status', 'Your best game each day counts from today. Play one to get on the board!');
    }
  } catch (err) {
    if (run === boardRun) say('board-status', err.message);
  }
}

function showOptedIn(on) {
  $('board-switch').setAttribute('aria-checked', String(on));
  $('board-explain').hidden = on;
  if (!on) $('board-table').hidden = true;
}

/** The switch shows what was saved as soon as it is saved, so a board that then fails to load cannot leave it wrong. */
async function toggleBoard() {
  const button = $('board-switch');
  const on = button.getAttribute('aria-checked') !== 'true';
  button.disabled = true;
  try {
    await api.setBoard(on);
  } catch (err) {
    say('board-status', err.message);
    return;
  } finally {
    button.disabled = false;
  }
  showOptedIn(on);
  await loadBoard();
}

function home() {
  play = null;
  show('start-screen');
}

for (const mode of ['normal', 'hard']) {
  let pointer = null;
  $(`play-${mode}`).addEventListener('pointerdown', (event) => (pointer = pointerOf(event)));
  $(`play-${mode}`).addEventListener('click', () => start(mode, pointer ?? pointerOf({})));
}
$('again').addEventListener('click', () => start(play?.state.game.mode ?? 'normal', play?.device.pointer ?? pointerOf({})));
$('over-retry').addEventListener('click', () => save());
$('over-home').addEventListener('click', home);
$('board-open').addEventListener('click', openBoard);
$('board-back').addEventListener('click', home);
$('board-switch').addEventListener('click', toggleBoard);

try {
  describeRules((await api.start()).tuning);
} catch (err) {
  say('start-status', err.message);
}
ready();
