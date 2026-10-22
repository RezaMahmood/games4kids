import { createApi } from './api.js';
import { CONFIDENCE, QUESTION_KINDS, offeredChoices } from './rules.js';
import { enterAdmin, ready, whileLoading } from '/shell/v1/index.js';

const STARTERS = ['Ancient Greeks', 'Saxons', 'Vikings', 'Stone Age people', 'Bronze Age people', 'Iron Age people', 'Egyptians'];
const BADGES = { drafting: 'Drafting…', failed: 'Failed', draft: 'Draft', published: 'Published', broken: 'Damaged' };
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
}

/** @type {import('./api.js').Topic[]} */
let topics = [];
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
const damage = (round) => `This round's stored data is damaged, so nobody can edit or play it: ${round.broken.join('; ')}. Delete it and make it again.`;

function roundTitle(round) {
  if (round.broken) return 'Damaged round';
  const { state } = round;
  if (state.content) return state.content.title;
  return state.focus ? `About ${state.focus}` : 'A round the AI chooses';
}

const badge = (kind) => h('span', { className: `badge ${kind}`, textContent: BADGES[kind] });

/* Topics */

function topicCard(t) {
  const counts = `${t.rounds} ${t.rounds === 1 ? 'round' : 'rounds'}, ${t.published} published`;
  return h('li', { className: 'card' },
    h('a', { className: 'card-title', href: `#topic/${t.id}`, textContent: t.title }),
    h('span', { className: 'meta', textContent: counts }),
    ...(t.guidance ? [h('p', { className: 'note', textContent: t.guidance })] : []),
    h('div', { className: 'actions' },
      h('button', { type: 'button', textContent: 'Edit', onclick: () => openTopicForm(t) }),
      ...(t.rounds === 0 ? [h('button', { type: 'button', className: 'danger', textContent: 'Delete', onclick: () => deleteTopic(t) })] : [])));
}

function renderTopics() {
  $('topics').replaceChildren(...topics.map(topicCard));
  $('topics-empty').hidden = topics.length > 0;
}

async function loadTopics() {
  topics = await api.topics();
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
    if (editingTopic) await api.updateTopic(editingTopic.id, { ...body, etag: editingTopic.etag });
    else await api.createTopic(body);
    $('topic-form').hidden = true;
    status('Saved.');
  } catch (err) {
    problems('topic-problems', err);
    $('t-title').focus();
  } finally {
    $('t-save').disabled = false;
    await loadTopics().catch((err) => status(err.message, 'error'));
  }
}

async function deleteTopic(t) {
  if (!confirm(`Delete the topic "${t.title}"?`)) return;
  try {
    await api.deleteTopic(t.id);
    await loadTopics();
  } catch (err) {
    status(err.message, 'error');
  }
}

/* One topic and its rounds */

function roundCard(round) {
  const thumb = h('img', { className: 'thumb', alt: '' });
  if (round.hasPicture) api.picture(round.id).then((url) => (thumb.src = url), () => {});
  const kind = kindOf(round);
  const reason = kind === 'broken' ? damage(round) : kind === 'failed' ? round.state.reason : '';
  return h('li', { className: 'card round-card' },
    round.hasPicture ? thumb : h('span', { className: 'thumb empty', ariaHidden: 'true' }),
    h('div', { className: 'round-body' },
      h('a', { className: 'card-title', href: `#round/${round.id}`, textContent: roundTitle(round) }),
      h('div', { className: 'badges' }, badge(kind), ...(round.state?.source === 'human' ? [h('span', { className: 'badge', textContent: 'Edited by hand' })] : [])),
      ...(reason ? [h('p', { className: 'reason', textContent: reason })] : [])));
}

async function loadRounds() {
  const rounds = await api.rounds(topic.id);
  $('rounds').replaceChildren(...rounds.map(roundCard));
  $('rounds-empty').hidden = rounds.length > 0;
  return rounds;
}

const drafting = (rounds) => rounds.some((round) => round.state?.kind === 'drafting');

async function openTopic(id) {
  topic = topics.find((t) => t.id === id) ?? null;
  if (!topic) {
    location.hash = '';
    return;
  }
  $('topic-heading').textContent = topic.title;
  $('topic-guidance').textContent = topic.guidance;
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

async function showPicture(round) {
  $('r-picture').hidden = !round.hasPicture;
  $('r-no-picture').hidden = round.hasPicture;
  if (round.hasPicture) $('r-picture').src = await api.picture(round.id);
  $('r-picture').alt = round.state.content?.pictureAlt ?? '';
}

function renderRound(round) {
  editing.round = round;
  const kind = round ? kindOf(round) : 'new';
  const content = round?.state?.content;
  $('round-heading').textContent = round ? roundTitle(round) : 'New round';
  $('round-badge').hidden = !round;
  $('round-badge').className = `badge ${kind}`;
  $('round-badge').textContent = BADGES[kind] ?? '';
  const working = kind === 'drafting';
  const editable = kind === 'new' || kind === 'draft' || kind === 'published';
  const notes = {
    new: 'Fill in every field and save, then add a picture.',
    drafting: content ? 'The AI is drawing a new picture. This page updates when it is done.' : 'The AI is writing this round. This page updates when it is done.',
    failed: round?.state?.reason,
    broken: kind === 'broken' ? damage(round) : '',
    draft: round?.state?.notice ?? (round?.hasPicture ? 'Only admins can see this round until you publish it.' : 'Add a picture before publishing.'),
  };
  $('round-note').hidden = !notes[kind];
  $('round-note').textContent = notes[kind] ?? '';
  $('round-note').dataset.tone = kind === 'failed' || kind === 'broken' || round?.state?.notice ? 'error' : '';
  $('round-picture').hidden = !round || working || kind === 'failed' || kind === 'broken';
  $('r-redraw').hidden = kind !== 'draft';
  $('r-redraw-note').hidden = kind !== 'published';
  $('round-form').hidden = !editable && !content;
  for (const control of $('round-form').elements) control.disabled = !editable;
  $('r-save').hidden = !editable;
  $('r-publish').hidden = kind !== 'draft';
  $('r-publish').disabled = !round?.hasPicture;
  $('r-unpublish').hidden = kind !== 'published';
  $('r-retry').hidden = kind !== 'failed';
  $('r-delete').hidden = !round;
  $('preview').hidden = !editable && !content;
  fillForm(content);
  pristine = JSON.stringify(readForm());
  problems('round-problems', null);
  renderPreview();
  if (round && !working && kind !== 'failed' && kind !== 'broken') showPicture(round).catch((err) => status(err.message, 'error'));
}

async function openRound(id) {
  show('round-view');
  const round = await whileLoading(api.round(id));
  editing = { topicId: round.topicId, round };
  $('round-back').href = `#topic/${round.topicId}`;
  renderRound(round);
  if (round.state?.kind === 'drafting') {
    pollWhile(async () => {
      const latest = await api.round(id);
      if (latest.state?.kind !== 'drafting') renderRound(latest);
      return latest;
    }, (latest) => latest.state?.kind === 'drafting');
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

async function publish() {
  const round = await saveEdits();
  if (round) await change(() => api.publish(round.id), 'Published. Children can play it now.');
}

async function unpublish() {
  const round = await saveEdits();
  if (round) await change(() => api.unpublish(round.id), 'Unpublished.');
}

async function retry() {
  const queued = await change(() => api.retry(editing.round.id), 'The AI is trying again.');
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
$('t-cancel').addEventListener('click', () => ($('topic-form').hidden = true));
$('topic-form').addEventListener('submit', saveTopic);
$('draft-form').addEventListener('submit', draftRound);
$('write').addEventListener('click', () => (location.hash = `#new/${topic.id}`));
$('round-form').addEventListener('submit', saveRound);
$('round-form').addEventListener('input', renderPreview);
$('r-publish').addEventListener('click', publish);
$('r-unpublish').addEventListener('click', unpublish);
$('r-delete').addEventListener('click', deleteRound);
$('r-redraw').addEventListener('click', redraw);
$('r-retry').addEventListener('click', retry);
$('r-upload').addEventListener('change', upload);
addEventListener('hashchange', route);

await route();
ready();
