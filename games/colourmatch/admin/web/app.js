import { createApi } from './api.js';
import { colourById, DEFAULT_TUNING, parseTuning, roundClockMs, roundMultiplier, secondsPerTurn, TUNING_FIELDS, TUNING_FIELD_NAMES, turnsIn } from './rules.js';
import { enterAdmin, ready, whileLoading } from '/shell/v1/index.js';

const PREVIEW_ROUNDS = 12;
const TABS = ['settings', 'metrics'];

const { api: client } = await enterAdmin({ game: 'colourmatch' });
const api = createApi(client);
const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let statusTimer = 0;
function status(text, tone = 'ok') {
  clearTimeout(statusTimer);
  $('status').hidden = !text;
  $('status').dataset.tone = tone;
  $('status').textContent = text;
  if (tone === 'ok' && text) statusTimer = setTimeout(() => ($('status').hidden = true), 4000);
}

const when = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/* Tabs */

function showTab(name) {
  const tab = TABS.includes(name) ? name : 'settings';
  for (const section of document.querySelectorAll('main [data-tab]')) section.hidden = section.dataset.tab !== tab;
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

/* Settings */

/** @type {import('./api.js').Version[]} */
let versions = [];
/** @type {import('./api.js').Version} */
let current = { id: 'default', savedAt: '', tuning: DEFAULT_TUNING };

const inputs = new Map(TUNING_FIELD_NAMES.map((name) => {
  const spec = TUNING_FIELDS[name];
  const input = h('input', { id: `t-${name}`, type: 'number', min: String(spec.min), max: String(spec.max), step: spec.integer ? '1' : 'any', inputMode: 'decimal' });
  input.addEventListener('input', renderPreview);
  return [name, input];
}));

$('fields').replaceChildren(...TUNING_FIELD_NAMES.map((name) => {
  const spec = TUNING_FIELDS[name];
  return h('label', {}, h('span', {}, spec.label, h('span', { className: 'bounds', textContent: `${spec.min} to ${spec.max}${spec.integer ? ', whole' : ''}` })), inputs.get(name));
}));

function fillForm(tuning) {
  for (const [name, input] of inputs) input.value = String(tuning[name]);
  renderPreview();
}

/** The form as numbers. A blank or non-numeric field comes through as NaN, which parseTuning names. */
const formValues = () => Object.fromEntries([...inputs].map(([name, input]) => [name, input.value.trim() === '' ? NaN : Number(input.value)]));

function renderPreview() {
  const parsed = parseTuning(formValues());
  for (const [name, input] of inputs) input.setAttribute('aria-invalid', String(!parsed.ok && parsed.problems.some((p) => p.startsWith(`${name} `))));
  $('tuning-problems').hidden = parsed.ok;
  $('tuning-problems').replaceChildren(...(parsed.ok ? [] : parsed.problems).map((problem) => h('li', { textContent: problem })));
  if (!parsed.ok) return;
  const tuning = parsed.value;
  $('preview-rows').replaceChildren(...Array.from({ length: PREVIEW_ROUNDS }, (_, i) => i + 1).map((round) => h('tr', {},
    h('td', { textContent: String(round) }),
    h('td', { textContent: String(turnsIn(tuning, round)) }),
    h('td', { textContent: secondsPerTurn(tuning, round).toFixed(2) }),
    h('td', { textContent: seconds(roundClockMs(tuning, round)) }),
    h('td', { textContent: `×${roundMultiplier(tuning, round).toFixed(2)}` }))));
}

/** The fields a version sets away from the defaults, so a list of versions reads as what each changed. */
function changesOf(tuning) {
  const changed = TUNING_FIELD_NAMES.filter((name) => tuning[name] !== DEFAULT_TUNING[name]).map((name) => `${name} ${tuning[name]}`);
  return changed.length === 0 ? 'the defaults' : changed.join(', ');
}

function renderVersions() {
  $('current-version').textContent = current.id === 'default' ? 'Children play under the defaults.' : `Children play under the version saved ${when(current.savedAt)}.`;
  $('versions-empty').hidden = versions.length > 0;
  $('versions').replaceChildren(...versions.map((version, i) => {
    const load = h('button', { type: 'button', className: 'small', textContent: 'Load into the form' });
    load.addEventListener('click', () => {
      fillForm(version.tuning);
      $(`t-${TUNING_FIELD_NAMES[0]}`).focus();
    });
    return h('li', {},
      h('span', { className: 'when', textContent: when(version.savedAt) }),
      ...(i === 0 ? [h('span', { className: 'badge', textContent: 'Current' })] : []),
      h('span', { className: 'changes', textContent: changesOf(version.tuning) }),
      load);
  }));
}

async function loadTunings() {
  ({ current, versions } = await api.tunings());
  renderVersions();
}

$('tuning-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const parsed = parseTuning(formValues());
  renderPreview();
  if (!parsed.ok) return $('tuning-problems').querySelector('li')?.scrollIntoView({ block: 'nearest' });
  $('t-save').disabled = true;
  try {
    const saved = await whileLoading(api.saveTuning(parsed.value));
    await loadTunings();
    status(`Saved. Children now play under the version saved ${when(saved.savedAt)}.`);
  } catch (err) {
    $('tuning-problems').hidden = !err.problems?.length;
    $('tuning-problems').replaceChildren(...(err.problems ?? []).map((problem) => h('li', { textContent: problem })));
    status(err.message, 'error');
  } finally {
    $('t-save').disabled = false;
  }
});

$('t-reset').addEventListener('click', () => fillForm(DEFAULT_TUNING));

/* Metrics */

/** @type {import('./api.js').Child[]} */
let children = [];
/** @type {{ child: import('./api.js').Child, games: import('./api.js').Game[] } | null} */
let shown = null;

const colourCell = (id) => {
  const colour = colourById(id);
  return h('td', {}, h('span', { className: 'swatch', style: `background: ${colour?.hex ?? '#fff'}` }), colour?.name ?? id);
};

async function loadChildren() {
  children = await api.children();
  const keep = $('child').value;
  $('child').replaceChildren(h('option', { value: '', textContent: 'Choose a child' }), ...children.map((child) => h('option', { value: child.userId, textContent: child.name })));
  $('child').value = children.some((child) => child.userId === keep) ? keep : '';
}

function renderGames() {
  $('turns-view').hidden = true;
  const games = shown?.games ?? [];
  $('games').hidden = games.length === 0;
  $('games-empty').hidden = !shown || games.length > 0;
  $('game-rows').replaceChildren(...games.map((game) => {
    const open = h('button', { type: 'button', className: 'small', textContent: 'Turns' });
    open.setAttribute('aria-label', `Turns of the game saved ${when(game.savedAt)}`);
    open.addEventListener('click', () => openTurns(game));
    const ms = (value) => (value === null ? '–' : String(Math.round(value)));
    return h('tr', {},
      h('td', { textContent: when(game.savedAt) }),
      h('td', { textContent: game.mode }),
      h('td', { textContent: String(game.score) }),
      h('td', { textContent: String(game.roundsReached) }),
      h('td', { textContent: String(game.turns) }),
      h('td', { textContent: `${game.correct} (${Math.round(game.accuracy * 100)}%)` }),
      h('td', { textContent: String(game.longestStreak) }),
      h('td', { textContent: ms(game.medianCongruentMs) }),
      h('td', { textContent: ms(game.medianIncongruentMs) }),
      h('td', { textContent: String(game.timeouts) }),
      h('td', { textContent: game.endReason }),
      h('td', { textContent: `${game.pointer} ${game.viewport}` }),
      h('td', { textContent: game.tuningId === 'default' ? 'defaults' : when(versions.find((v) => v.id === game.tuningId)?.savedAt ?? NaN) }),
      h('td', {}, open));
  }));
}

async function chooseChild(userId) {
  const child = children.find((candidate) => candidate.userId === userId);
  if (!child) {
    shown = null;
    return renderGames();
  }
  try {
    shown = { child, games: await whileLoading(api.games(userId)) };
    renderGames();
  } catch (err) {
    status(err.message, 'error');
  }
}

async function openTurns(game) {
  try {
    const { turns } = await whileLoading(api.game(shown.child.userId, game.key));
    $('turns-heading').textContent = `${shown.child.name}, ${game.mode} mode, saved ${when(game.savedAt)}`;
    $('turn-rows').replaceChildren(...turns.map((turn) => h('tr', {},
      h('td', { textContent: `${turn.round}.${turn.turn + 1}` }),
      h('td', {}, h('span', { className: 'ink-word', textContent: colourById(turn.word)?.name ?? turn.word, style: `color: ${colourById(turn.ink)?.hex ?? '#fff'}` })),
      colourCell(turn.ink),
      turn.answer ? colourCell(turn.squares[turn.answer.tapped]) : h('td', { textContent: 'clock ran out' }),
      h('td', { className: turn.correct ? 'right' : 'wrong', textContent: turn.correct ? 'Yes' : 'No' }),
      h('td', { textContent: turn.answer ? String(turn.answer.answerMs) : '–' }),
      h('td', { textContent: String(turn.points) }),
      h('td', { textContent: seconds(turn.clockLeftMs) }))));
    $('turns-view').hidden = false;
    $('turns-heading').focus();
  } catch (err) {
    status(err.message, 'error');
  }
}

$('child').addEventListener('change', () => chooseChild($('child').value));
$('turns-close').addEventListener('click', () => ($('turns-view').hidden = true));
$('csv').addEventListener('click', async () => {
  $('csv').disabled = true;
  try {
    const blob = await whileLoading(api.csv());
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `colourmatch-games-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    status(err.message, 'error');
  } finally {
    $('csv').disabled = false;
  }
});

/* First load */

fillForm(DEFAULT_TUNING);
showTab(location.hash.slice(1));
try {
  await Promise.all([loadTunings(), loadChildren()]);
  fillForm(current.tuning);
} catch (err) {
  status(err.message, 'error');
} finally {
  ready();
}
