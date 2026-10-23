import { createApi } from './api.js';
import { CONFIDENCE, QUESTION_KINDS, offeredChoices } from './rules.js';
import { enterAdmin, ready, whileLoading } from '/shell/v1/index.js';

const STARTERS = ['Ancient Greeks', 'Saxons', 'Vikings', 'Stone Age people', 'Bronze Age people', 'Iron Age people', 'Egyptians'];
const BADGES = { drafting: 'Drafting…', revising: 'Redrafting…', failed: 'Failed', draft: 'Draft', published: 'Published', broken: 'Damaged' };
const KINDS = Object.keys(QUESTION_KINDS);
const POLL_MS = 3000;
const POLL_FOR_MS = 5 * 60_000;
const VIEWS = ['topics-view', 'topic-view', 'round-view'];

const { api: client } = await enterAdmin({ game: 'timedetectives' });
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
  $('status').hidden = false;
  $('status').dataset.tone = tone;
  $('status').textContent = text;
  if (tone === 'ok') statusTimer = setTimeout(() => ($('status').hidden = true), 4000);
}

function problems(listId, err) {
  const list = $(listId);
  list.hidden = !err?.problems?.length;
  list.replaceChildren(...(err?.problems ?? []).map((problem) => h('li', { textContent: problem })));
  if (err) status(err.status === 412 ? `${err.message} The page has been reloaded.` : err.message, 'error');
}

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  $('round-actions').hidden = view !== 'round-view';
  window.scrollTo(0, 0);
  $(view).querySelector('h1').focus({ preventScroll: true });
}

/** When the control that had focus has gone or been disabled, moves focus to the first of these that can take it. */
function refocus(...targets) {
  const active = document.activeElement;
  if (active && active !== document.body && active.checkVisibility() && !active.disabled) return;
  targets.find((target) => target.checkVisibility() && !target.disabled)?.focus();
}

/** @type {import('./api.js').Topic[]} */
let topics = [];
/** @type {import('./api.js').Costs} */
let costs = { topics: {}, rounds: {} };

/** Asks what the AI has cost. A reply that fails leaves the figures as they were, so the page never waits on it or breaks. */
const loadCosts = () => api.costs().then((latest) => { costs = latest; }, () => {});

/** Mirrors the server's estimate wording, for the deleted-rounds part that only the page can work out. */
function estimateText(microUsd) {
  if (microUsd < 1_000) return 'est. <$0.001';
  const usd = microUsd / 1_000_000;
  return `est. $${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}
/** The topic being added or edited, or null for a new one. */
let editingTopic = null;
/** @type {import('./api.js').Topic | null} */
let topic = null;
/** @type {{ topicId: string, round: import('./api.js').Round | null }} null while writing a new round. */
let editing = { topicId: '', round: null };
/** Bumped on every route change and new poll, so a poll for a page that has gone stops. */
let pollRun = 0;

/** Asks again every few seconds while the AI is at work, and gives up after five minutes. */
function pollWhile(load, waiting) {
  const run = ++pollRun;
  const until = Date.now() + POLL_FOR_MS;
  const tick = async () => {
    if (run !== pollRun) return;
    if (Date.now() > until) return status('The AI is taking a long time. Reload the page to check on it.', 'error');
    try {
      const latest = await load();
      if (run === pollRun && waiting(latest)) setTimeout(tick, POLL_MS);
    } catch (err) {
      status(err.message, 'error');
    }
  };
  setTimeout(tick, POLL_MS);
}

const kindOf = (round) => (round.broken ? 'broken' : round.state.kind);
/** The AI has the round queued, so the page asks again until it is done. */
const atWork = (round) => round.state?.kind === 'drafting' || round.state?.kind === 'revising';
const damage = (round) => `This round's stored data is damaged, so nobody can edit or play it: ${round.broken.join('; ')}. Delete it and make it again.`;

function roundTitle(round) {
  if (round.broken) return 'Damaged round';
  const { state } = round;
  if (state.content) return state.content.title;
  return state.focus ? `About ${state.focus}` : 'A round the AI chooses';
}


/* Topics */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** What the topic holds, put as what is left to do. */
function counts(t) {
  if (t.rounds === 0) return 'No rounds yet';
  return [
    plural(t.rounds, 'round', 'rounds'),
    t.published ? `${t.published} published` : 'none published yet',
    ...(t.drafts ? [`${plural(t.drafts, 'draft', 'drafts')} to review`] : []),
  ].join(', ');
}

/** The topic's AI cost so far, or nothing when the AI has not been asked yet. */
const topicCost = (id) => (costs.topics[id]?.calls ? [`AI cost: ${costs.topics[id].text}`] : []);

function topicCard(t) {
  const href = `#topic/${t.id}`;
  return h('li', { className: 'card' },
    h('a', { className: 'card-title', href, textContent: t.title }),
    h('span', { className: 'meta', textContent: counts(t) }),
    ...topicCost(t.id).map((textContent) => h('span', { className: 'cost', textContent })),
    ...(t.guidance ? [h('p', { className: 'note', textContent: t.guidance })] : []),
    h('div', { className: 'actions' },
      h('a', { className: 'button primary', href, textContent: t.rounds === 0 ? 'Add rounds' : 'Open', ariaLabel: `${t.rounds === 0 ? 'Add rounds to' : 'Open'} ${t.title}` }),
      h('button', { type: 'button', textContent: 'Edit title and guidance', onclick: () => openTopicForm(t) }),
      ...(t.rounds === 0 ? [h('button', { type: 'button', className: 'danger', textContent: 'Delete', onclick: () => deleteTopic(t) })] : [])));
}

function renderTopics() {
  $('topics').replaceChildren(...topics.map(topicCard));
  $('topics-empty').hidden = topics.length > 0;
}

async function loadTopics() {
  [topics] = await Promise.all([api.topics(), loadCosts()]);
  renderTopics();
}

function openTopicForm(t) {
  editingTopic = t;
  $('topic-form-heading').textContent = t ? `Edit "${t.title}"` : 'New topic';
  $('suggestions').hidden = Boolean(t);
  $('t-title').value = t?.title ?? '';
  $('t-guidance').value = t?.guidance ?? '';
  problems('topic-problems', null);
  $('topic-form').hidden = false;
  $('t-title').focus();
}

async function saveTopic(event) {
  event.preventDefault();
  const body = { title: $('t-title').value, guidance: $('t-guidance').value };
  $('t-save').disabled = true;
  try {
    if (editingTopic) {
      await api.updateTopic(editingTopic.id, { ...body, etag: editingTopic.etag });
      $('topic-form').hidden = true;
      refocus($('new-topic'));
      status('Saved.');
      await loadTopics();
    } else {
      const made = await api.createTopic(body);
      $('topic-form').hidden = true;
      location.hash = `#topic/${made.id}`;
      status('Topic saved. Now add its first round.');
    }
  } catch (err) {
    problems('topic-problems', err);
    $('t-title').focus();
    await loadTopics().catch((error) => status(error.message, 'error'));
  } finally {
    $('t-save').disabled = false;
  }
}

async function deleteTopic(t) {
  if (!confirm(`Delete the topic "${t.title}"?`)) return;
  try {
    await api.deleteTopic(t.id);
    await loadTopics();
    refocus($('topics-heading'));
  } catch (err) {
    status(err.message, 'error');
  }
}

/* One topic and its rounds */

const findings = (state) => (Array.isArray(state?.checks) ? state.checks : []);

/** Where the round is, in plain words, for its card. */
function roundStatus(round) {
  const kind = kindOf(round);
  if (kind === 'broken') return damage(round);
  const { state } = round;
  if (kind === 'failed') return state.reason;
  if (kind === 'drafting') return state.content ? 'The AI is drawing a new picture…' : 'The AI is writing it…';
  if (kind === 'revising') return 'The AI is redrafting it…';
  if (kind === 'published') return 'Published, children can play it';
  const flagged = findings(state).length;
  return [
    'Draft, only you can see it',
    ...(round.hasPicture ? [] : ['Needs a picture']),
    ...(flagged ? [`${plural(flagged, 'thing', 'things')} worth a second look`] : []),
  ].join('. ');
}

/** What to press on a round's card to move it along. */
const ROUND_ACTIONS = { draft: 'Review and publish', published: 'View', failed: 'Try again', broken: 'Open' };

const roundCost = (id) => {
  const cost = costs.rounds[id];
  return cost?.calls ? `AI cost so far: ${cost.text} (${plural(cost.calls, 'AI call', 'AI calls')})` : '';
};

/**
 * Each card's picture element by round, with the `updatedAt` it shows. The list is redrawn on every poll while the AI
 * works, so a card reuses its element, which keeps the picture on screen, and fetches again only for a changed round.
 */
const thumbs = new Map();

function thumbFor(round) {
  const known = thumbs.get(round.id);
  if (known?.updatedAt === round.updatedAt) return known.img;
  const img = known?.img ?? h('img', { className: 'thumb', alt: '' });
  thumbs.set(round.id, { img, updatedAt: round.updatedAt });
  api.picture(round.id).then((url) => (img.src = url), () => {});
  return img;
}

function roundCard(round) {
  const kind = kindOf(round);
  const href = `#round/${round.id}`;
  const action = ROUND_ACTIONS[kind];
  return h('li', { className: 'card round-card' },
    pickBox(round),
    round.hasPicture ? thumbFor(round) : h('span', { className: 'thumb empty', ariaHidden: 'true' }),
    h('div', { className: 'round-body' },
      h('a', { className: 'card-title', href, textContent: roundTitle(round) }),
      h('p', { className: `badge ${kind}`, textContent: roundStatus(round) }),
      ...(roundCost(round.id) ? [h('p', { className: 'cost', textContent: roundCost(round.id) })] : []),
      ...(round.state?.source === 'human' ? [h('p', { className: 'meta', textContent: 'Edited by hand' })] : [])),
    ...(action ? [h('a', { className: `button${kind === 'published' ? '' : ' primary'}`, href, textContent: action, ariaLabel: `${action}: ${roundTitle(round)}` })] : []));
}

/** The topic's total in its header, with what part of it went on rounds that are gone. */
function renderTopicCost(rounds) {
  const total = costs.topics[topic.id];
  const shown = Boolean(total?.calls);
  $('topic-cost').hidden = !shown;
  if (!shown) return;
  const live = rounds.reduce((sum, round) => sum + (costs.rounds[round.id]?.microUsd ?? 0), 0);
  const deleted = total.microUsd - live;
  $('topic-cost-total').textContent = `AI cost so far: ${total.text}`;
  $('topic-cost-deleted').hidden = deleted <= 0;
  $('topic-cost-deleted').textContent = `Includes ${estimateText(deleted)} spent on rounds since deleted.`;
}

/* Choosing several rounds to publish, unpublish or delete together */

/** @type {(import('./api.js').Round | import('./api.js').Broken)[]} */
let listed = [];
/** Ids of the chosen rounds. Kept across the list's redraws, and emptied after an action. */
const selected = new Set();
let confirmingDelete = false;
let bulkBusy = false;
const BATCH = 3;

const pickable = (round) => !atWork(round);
const chosen = () => listed.filter((round) => selected.has(round.id));

function pickBox(round) {
  const input = h('input', { type: 'checkbox', checked: selected.has(round.id), disabled: !pickable(round) || bulkBusy, ariaLabel: `Select ${roundTitle(round)}` });
  input.addEventListener('change', () => {
    selected[input.checked ? 'add' : 'delete'](round.id);
    renderBulk();
  });
  input.dataset.roundId = round.id;
  return h('label', { className: 'pick' }, input);
}

function renderBulk() {
  const mine = chosen();
  const all = listed.filter(pickable);
  if (mine.length === 0) confirmingDelete = false;
  $('bulk-bar').hidden = listed.length === 0;
  const selectAll = $('bulk-all');
  selectAll.disabled = all.length === 0 || bulkBusy;
  selectAll.checked = all.length > 0 && mine.length === all.length;
  selectAll.indeterminate = mine.length > 0 && mine.length < all.length;
  $('bulk-count').textContent = mine.length ? `${mine.length} selected` : 'None selected';
  const can = (test) => !bulkBusy && mine.some(test);
  $('bulk-publish').disabled = !can((round) => round.state?.kind === 'draft' && round.hasPicture);
  $('bulk-unpublish').disabled = !can((round) => round.state?.kind === 'published');
  $('bulk-delete').disabled = !can(() => true);
  $('bulk-delete').hidden = confirmingDelete;
  $('bulk-confirm').hidden = !confirmingDelete;
  $('bulk-confirm-text').textContent = `Delete ${plural(mine.length, 'round', 'rounds')}? This cannot be undone.`;
  $('bulk-confirm-yes').disabled = bulkBusy;
  $('bulk-confirm-no').disabled = bulkBusy;
}

/** Runs `work` on every item, `BATCH` at a time. Each result says whether that item worked, and why not when it did not. */
async function inBatches(items, work) {
  const results = [];
  for (let i = 0; i < items.length; i += BATCH) {
    results.push(...(await Promise.all(items.slice(i, i + BATCH).map((item) => work(item).then(() => ({ item }), (error) => ({ item, error }))))));
  }
  return results;
}

const BULK = {
  publish: {
    applies: (round) => round.state?.kind === 'draft',
    done: 'Published',
    not: 'published',
    run: async (round) => {
      if (!round.hasPicture) throw new Error(`${roundTitle(round)} needs a picture.`);
      await api.publish(round.id, round.etag);
    },
  },
  unpublish: { applies: (round) => round.state?.kind === 'published', done: 'Unpublished', not: 'unpublished', run: (round) => api.unpublish(round.id) },
  delete: { applies: () => true, done: 'Deleted', not: 'deleted', run: (round) => api.remove(round.id) },
};

/** One line naming how many worked and, for each round that did not, which and why. */
function bulkOutcome({ done, not }, results) {
  const failed = results.filter((result) => result.error);
  const worked = results.length - failed.length;
  const reasons = failed.map(({ item, error }) => (error.message.startsWith(roundTitle(item)) ? error.message : `${roundTitle(item)}: ${error.message}`));
  return {
    text: [worked ? `${done} ${worked}.` : '', failed.length ? `${failed.length} ${failed.length === 1 ? 'was' : 'were'} not ${not}: ${reasons.join(' ')}` : ''].filter(Boolean).join(' '),
    tone: failed.length ? 'error' : 'ok',
  };
}

async function bulk(action) {
  const rule = BULK[action];
  const targets = chosen().filter(rule.applies);
  if (targets.length === 0 || bulkBusy) return;
  bulkBusy = true;
  confirmingDelete = false;
  renderBulk();
  try {
    const results = await whileLoading(inBatches(targets, rule.run));
    selected.clear();
    const { text, tone } = bulkOutcome(rule, results);
    await loadRounds().catch((err) => status(err.message, 'error'));
    status(text, tone);
  } finally {
    bulkBusy = false;
    renderRoundList();
    refocus($('bulk-all'), $('topic-heading'));
  }
}

/** Redraws the cards and the toolbar from the last list, keeping focus on the same round's checkbox. */
function renderRoundList() {
  const focused = document.activeElement?.dataset?.roundId;
  $('rounds').replaceChildren(...listed.map(roundCard));
  renderBulk();
  if (focused) $('rounds').querySelector(`input[data-round-id="${focused}"]`)?.focus();
}

async function loadRounds() {
  const [rounds] = await Promise.all([api.rounds(topic.id), loadCosts()]);
  listed = rounds;
  for (const id of selected) if (!listed.some((round) => round.id === id && pickable(round))) selected.delete(id);
  renderRoundList();
  renderTopicCost(rounds);
  $('rounds-empty').hidden = rounds.length > 0;
  return rounds;
}

const drafting = (rounds) => rounds.some(atWork);

async function openTopic(id) {
  topic = topics.find((t) => t.id === id) ?? null;
  if (!topic) {
    location.hash = '';
    return;
  }
  $('topic-heading').textContent = topic.title;
  $('topic-guidance').textContent = topic.guidance;
  $('topic-cost').hidden = true;
  selected.clear();
  listed = [];
  confirmingDelete = false;
  renderBulk();
  show('topic-view');
  const rounds = await whileLoading(loadRounds());
  if (drafting(rounds)) pollWhile(loadRounds, drafting);
}

async function draftRound(event) {
  event.preventDefault();
  $('d-go').disabled = true;
  try {
    await api.draft(topic.id, $('d-focus').value);
    $('d-focus').value = '';
    status('The AI is drafting a round. It takes about a minute.');
    await loadRounds();
    pollWhile(loadRounds, drafting);
  } catch (err) {
    status(err.message, 'error');
  } finally {
    $('d-go').disabled = false;
  }
}

/* One round */

function questionFields(kind) {
  const input = (suffix, label) => h('label', {}, label, h('input', { id: `q-${kind}-${suffix}`, type: 'text', maxLength: suffix === 'hint' ? 200 : 60 }));
  return h('fieldset', { className: 'question' },
    h('legend', { textContent: QUESTION_KINDS[kind].label }),
    input('answer', 'Answer'),
    h('div', { className: 'decoys' }, input('decoy-0', 'Wrong answer 1'), input('decoy-1', 'Wrong answer 2'), input('decoy-2', 'Wrong answer 3 (not shown on "go easy")')),
    input('hint', 'Hint'));
}

$('r-questions').replaceChildren(...KINDS.map(questionFields));

function fillForm(content) {
  for (const field of ['title', 'full', 'brief', 'pictureAlt']) $(`r-${field}`).value = content?.[field] ?? '';
  for (const kind of KINDS) {
    const question = content?.questions.find((q) => q.kind === kind);
    $(`q-${kind}-answer`).value = question?.answer ?? '';
    $(`q-${kind}-hint`).value = question?.hint ?? '';
    for (let i = 0; i < 3; i++) $(`q-${kind}-decoy-${i}`).value = question?.decoys[i] ?? '';
  }
}

function readForm() {
  const value = (id) => $(id).value;
  return {
    title: value('r-title'),
    full: value('r-full'),
    brief: value('r-brief'),
    pictureAlt: value('r-pictureAlt'),
    questions: KINDS.map((kind) => ({
      kind,
      answer: value(`q-${kind}-answer`),
      decoys: [0, 1, 2].map((i) => value(`q-${kind}-decoy-${i}`)),
      hint: value(`q-${kind}-hint`),
    })),
  };
}

/** The form as the server last filled it, so the page can tell when the admin has changed something. */
let pristine = '';
const edited = () => JSON.stringify(readForm()) !== pristine;

let previewing = 'bit';

function renderPreview() {
  const content = readForm();
  const rule = CONFIDENCE[previewing];
  $('preview-tabs').replaceChildren(...Object.entries(CONFIDENCE).map(([confidence, { label }]) => {
    const tab = h('button', { type: 'button', role: 'tab', textContent: label, onclick: () => { previewing = confidence; renderPreview(); } });
    tab.setAttribute('aria-selected', String(confidence === previewing));
    return tab;
  }));
  $('preview-body').replaceChildren(
    h('p', { className: 'preview-paragraph', textContent: content[rule.paragraph] || 'No text yet.' }),
    ...content.questions.map((question) => h('div', { className: 'preview-question' },
      h('strong', { textContent: QUESTION_KINDS[question.kind].label }),
      h('ul', { className: 'preview-choices' }, ...offeredChoices(question, previewing).map((choice) => h('li', { className: choice === question.answer ? 'answer' : '', textContent: choice || '(empty)' }))),
      h('p', { className: 'note', textContent: `Hint: ${question.hint}` }))),
    h('p', { className: 'note', textContent: `Points times ${rule.bonus}.` }));
}

/** The form input a finding is about. */
const inputFor = (field) => $(field === 'full' || field === 'brief' ? `r-${field}` : `q-${field}`);

/** The field in the words the form labels it with. */
function fieldName(field) {
  if (field === 'full') return 'The whole story';
  if (field === 'brief') return 'The short clue';
  const [kind, part, index] = field.split('-');
  const label = QUESTION_KINDS[kind].label;
  return part === 'decoy' ? `Wrong answer ${Number(index) + 1} for "${label}"` : `The "${label}" ${part}`;
}

const QUOTE_MAX = 90;
const quoted = (text) => `"${text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text}"`;

function goTo(field) {
  const input = inputFor(field);
  input.scrollIntoView({ block: 'center' });
  input.focus({ preventScroll: true });
}

/** The check's findings, each quoting what the field says now, so an edit shows at once. */
function renderChecks() {
  const checks = editing.round?.state?.kind === 'draft' ? editing.round.state.checks : undefined;
  $('round-checks').hidden = !checks || checks.length === 0;
  $('redraft').hidden = !Array.isArray(checks);
  if ($('round-checks').hidden) return;
  if (checks === 'not-run') {
    $('checks-intent').textContent = 'The automatic check could not read this round this time. Read it through before you publish it.';
    $('checks-list').replaceChildren();
    return;
  }
  // The AI rewrites the words as saved, so edits on screen would be lost or out of step with the notes.
  $('r-redraft').disabled = edited();
  $('redraft-hint').hidden = !edited();
  $('checks-intent').textContent = 'An automatic check read this round and thinks these might spoil the quiz. Fix them, or publish as it is if you disagree.';
  $('checks-list').replaceChildren(...checks.map(({ field, problem, sure }) => h('li', {},
    h('span', { textContent: `${fieldName(field)} ${sure ? 'seems to' : 'might'} ${problem}: ${quoted(inputFor(field).value.trim() || '(empty)')}` }),
    ' ',
    h('button', { type: 'button', className: 'link', textContent: 'Go to it', ariaLabel: `Go to it: ${fieldName(field)}`, onclick: () => goTo(field) }))));
}

async function showPicture(round) {
  $('r-picture').hidden = !round.hasPicture;
  $('r-no-picture').hidden = round.hasPicture;
  if (round.hasPicture) $('r-picture').src = await api.picture(round.id);
  $('r-picture').alt = round.state.content?.pictureAlt ?? '';
}

function renderRoundCost(round) {
  $('round-cost').textContent = round ? roundCost(round.id) : '';
  $('round-cost').hidden = !$('round-cost').textContent;
}

function renderRound(round) {
  editing.round = round;
  const kind = round ? kindOf(round) : 'new';
  const content = round?.state?.content;
  $('round-heading').textContent = round ? roundTitle(round) : 'New round';
  $('round-badge').hidden = !round;
  $('round-badge').className = `badge ${kind}`;
  $('round-badge').textContent = BADGES[kind] ?? '';
  const working = kind === 'drafting' || kind === 'revising';
  const editable = kind === 'new' || kind === 'draft' || kind === 'published';
  const notes = {
    new: 'Fill in every field and save, then add a picture.',
    drafting: content ? 'The AI is drawing a new picture. This page updates when it is done.' : 'The AI is writing this round. This page updates when it is done.',
    revising: 'The AI is redrafting this round. This page updates when it is done.',
    failed: round?.state?.reason,
    broken: kind === 'broken' ? damage(round) : '',
    draft: round?.state?.notice ?? (round?.hasPicture ? 'Draft: only you can see this. When you are happy, press Publish at the bottom.' : 'Add a picture, then press Publish at the bottom.'),
  };
  renderRoundCost(round);
  $('round-note').hidden = !notes[kind];
  $('round-note').textContent = notes[kind] ?? '';
  $('round-note').dataset.tone = kind === 'failed' || kind === 'broken' || round?.state?.notice ? 'error' : '';
  $('round-picture').hidden = !round || working || kind === 'failed' || kind === 'broken';
  $('r-redraw').hidden = kind !== 'draft';
  $('r-redraw-note').hidden = kind !== 'published';
  $('round-form').hidden = !editable && !content;
  for (const control of $('round-form').elements) control.disabled = !editable;
  $('r-save').hidden = !editable;
  $('r-save').classList.toggle('primary', kind !== 'draft');
  $('r-publish').hidden = kind !== 'draft';
  $('r-publish').disabled = !round?.hasPicture;
  $('r-unpublish').hidden = kind !== 'published';
  $('r-retry').hidden = kind !== 'failed';
  $('retry-form').hidden = kind !== 'failed';
  $('r-focus').value = kind === 'failed' ? round.state.focus : '';
  $('r-delete').hidden = !round;
  $('preview').hidden = !editable && !content;
  fillForm(content);
  pristine = JSON.stringify(readForm());
  problems('round-problems', null);
  renderPreview();
  renderChecks();
  if (round && !working && kind !== 'failed' && kind !== 'broken') showPicture(round).catch((err) => status(err.message, 'error'));
}

async function openRound(id) {
  show('round-view');
  const [round] = await whileLoading(Promise.all([api.round(id), loadCosts()]));
  editing = { topicId: round.topicId, round };
  $('round-back').href = `#topic/${round.topicId}`;
  renderRound(round);
  if (atWork(round)) {
    pollWhile(async () => {
      const [latest] = await Promise.all([api.round(id), loadCosts()]);
      if (!atWork(latest)) renderRound(latest);
      else renderRoundCost(latest);
      return latest;
    }, atWork);
  }
}

function openNewRound(topicId) {
  editing = { topicId, round: null };
  $('round-back').href = `#topic/${topicId}`;
  show('round-view');
  renderRound(null);
}

/** Runs one change to the round and shows what the server answers. */
async function change(work, done) {
  try {
    const round = await work();
    renderRound(round);
    refocus($('r-publish'), $('r-unpublish'), $('round-heading'));
    if (done) status(done);
    return round;
  } catch (err) {
    problems('round-problems', err);
    if (err.status === 412 && editing.round) renderRound(await api.round(editing.round.id));
    return null;
  }
}

async function saveRound(event) {
  event.preventDefault();
  $('r-save').disabled = true;
  const { topicId, round } = editing;
  try {
    if (!round) {
      const made = await change(() => api.write(topicId, readForm()), 'Saved. Now add a picture.');
      if (made) location.hash = `#round/${made.id}`;
    } else {
      await change(() => api.edit(round.id, readForm(), round.etag), 'Saved.');
    }
  } finally {
    $('r-save').disabled = false;
  }
}

/** Saves what is on screen before another action, so no action throws the admin's edits away. Null when the save failed. */
async function saveEdits() {
  const { round } = editing;
  return edited() ? change(() => api.edit(round.id, readForm(), round.etag)) : round;
}

async function redraw() {
  const round = await saveEdits();
  if (!round) return;
  const queued = await change(() => api.redraw(round.id), 'The AI is drawing a new picture.');
  if (queued) openRound(queued.id);
}

/** Only offered with no unsaved edits, so the AI rewrites exactly the words the notes are about. */
async function redraft() {
  const { round } = editing;
  const queued = await change(() => whileLoading(api.redraft(round.id, round.etag)), 'The AI is redrafting this round.');
  if (queued) openRound(queued.id);
}

async function publish() {
  const round = await saveEdits();
  if (round) await change(() => api.publish(round.id, round.etag), 'Published. Children can play it now.');
}

/** Takes the round down before saving any edits, so words nobody published never reach a child, even for a moment. */
async function unpublish() {
  const unsaved = edited() && readForm();
  const round = await change(() => api.unpublish(editing.round.id), 'Unpublished.');
  if (!round || !unsaved) return;
  fillForm(unsaved);
  renderPreview();
  await change(() => api.edit(round.id, unsaved, round.etag), 'Unpublished, and your changes are saved.');
}

async function retry(event) {
  event.preventDefault();
  const queued = await change(() => api.retry(editing.round.id, $('r-focus').value), 'The AI is trying again.');
  if (queued) openRound(queued.id);
}

async function upload() {
  const file = $('r-upload').files?.[0];
  $('r-upload').value = '';
  const round = file && (await saveEdits());
  if (round) await change(() => api.upload(round.id, file), 'Picture saved.');
}

async function deleteRound() {
  const { round, topicId } = editing;
  if (!confirm('Delete this round and its picture?')) return;
  try {
    await api.remove(round.id);
    location.hash = `#topic/${topicId}`;
  } catch (err) {
    status(err.message, 'error');
  }
}

/* Routing */

async function route() {
  pollRun++;
  const [view, id] = location.hash.slice(1).split('/');
  try {
    if (view === 'topic' && id) {
      if (!topics.some((t) => t.id === id)) await loadTopics();
      await openTopic(id);
    } else if (view === 'round' && id) await openRound(id);
    else if (view === 'new' && id) openNewRound(id);
    else {
      show('topics-view');
      await whileLoading(loadTopics());
    }
  } catch (err) {
    status(err.message, 'error');
  }
}

$('suggestions').replaceChildren(...STARTERS.map((title) => h('button', { type: 'button', className: 'chip', textContent: title, onclick: () => ($('t-title').value = title) })));
$('new-topic').addEventListener('click', () => openTopicForm(null));
$('t-cancel').addEventListener('click', () => {
  $('topic-form').hidden = true;
  $('new-topic').focus();
});
$('topic-form').addEventListener('submit', saveTopic);
$('draft-form').addEventListener('submit', draftRound);
$('bulk-all').addEventListener('change', () => {
  const method = $('bulk-all').checked ? 'add' : 'delete';
  for (const round of listed.filter(pickable)) selected[method](round.id);
  renderRoundList();
});
for (const action of ['publish', 'unpublish']) $(`bulk-${action}`).addEventListener('click', () => bulk(action));
$('bulk-delete').addEventListener('click', () => {
  confirmingDelete = true;
  renderBulk();
  $('bulk-confirm-no').focus();
});
$('bulk-confirm-yes').addEventListener('click', () => bulk('delete'));
$('bulk-confirm-no').addEventListener('click', () => {
  confirmingDelete = false;
  renderBulk();
  $('bulk-delete').focus();
});
$('write').addEventListener('click', () => (location.hash = `#new/${topic.id}`));
$('round-form').addEventListener('submit', saveRound);
$('round-form').addEventListener('input', () => {
  renderPreview();
  renderChecks();
});
$('r-publish').addEventListener('click', publish);
$('r-unpublish').addEventListener('click', unpublish);
$('r-delete').addEventListener('click', deleteRound);
$('r-redraw').addEventListener('click', redraw);
$('r-redraft').addEventListener('click', redraft);
$('r-retry').addEventListener('click', retry);
$('retry-form').addEventListener('submit', retry);
$('r-upload').addEventListener('change', upload);
addEventListener('hashchange', route);

await route();
ready();
