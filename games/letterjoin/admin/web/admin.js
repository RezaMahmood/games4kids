import { DEFAULT_LEVEL, DEFAULT_LOOK, LETTER_STYLES, LEVELS, LEVEL_INFO, LIMITS, groupByLevel, parseActivityInput, toTraceText, typeLabel } from './activity.js';
import { createApi } from './api.js';
import { loadFace } from './fonts.js';
import { parseDuration, timerLabel } from './format.js';
import { TABS, tabFromHash } from './admin-tabs.js';
import { localDay } from './practice.js';
import { cellFor, dayLabel, goalText, totalText } from './practice-report.js';
import { ACCURACY_STEP, MIN_TREND_DAYS, SPEED_STEP, TREND_DAYS, accuracyText, dayLabel as progressDayLabel, speedText, summarizeDays, trendByLevel, trendOf, trendWords } from './progress.js';
import { drawTarget, sizeSheet } from './render.js';
import { SECTIONS_KEY, createSections } from './sections.js';
import { IPAD_STAGE_WIDTH, layoutSheet } from './sheet.js';
import { enterAdmin, ready } from '/shell/v1/index.js';

const $ = (id) => document.getElementById(id);
const field = (id) => $(`f-${id}`);

/** @type {import('./api.js').ListedActivity[]} */
let activities = [];
/** The activity being edited, or null when creating one. */
let editing = null;

function h(tag, { dataset = {}, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function status(text, tone = 'ok') {
  $('status').hidden = false;
  $('status').dataset.tone = tone;
  $('status').textContent = text;
}

const dialog = $('activity-dialog');

/** The status line sits under a modal dialog, so a failure raised while the form is open shows in the dialog. */
function say(text) {
  if (!dialog.open) return status(text, 'error');
  $('f-error').hidden = false;
  $('f-error').textContent = text;
}

function failed(err) {
  if (err.status === 412) say(`${err.message}\nThe list has been reloaded.`);
  else say(err.problems?.length ? `${err.message}\n${err.problems.join('\n')}` : err.message);
}

const split = (text) => text.split(/[\s,]+/).filter(Boolean);

/** Reads the form into the raw shape the API accepts; the shared rules decide whether it is valid. */
function readForm() {
  const type = field('type').value;
  const base = {
    type,
    title: field('title').value,
    description: field('description').value,
    status: field('status').value,
    level: field('level').value,
    timeLimitSec: field('timed').value === 'yes' ? parseDuration(field('time').value) ?? Number.NaN : null,
    mode: field('mode').value,
    letterStyle: field('style').value,
    allowedStyles: LETTER_STYLES.filter((s) => field(`allowed-${s}`).checked),
    paper: field('paper').value,
    lineSize: field('linesize').value,
  };
  switch (type) {
    case 'letters': return { ...base, sequence: split(field('sequence').value), repeat: Number(field('repeat').value) };
    case 'words': return { ...base, category: field('category').value, words: split(field('words').value) };
    case 'sentence': return { ...base, text: field('sentence').value };
    case 'paragraph': return { ...base, text: field('paragraph').value };
    default: return base;
  }
}

function fillForm(activity) {
  field('type').value = activity?.type ?? 'letters';
  field('title').value = activity?.title ?? '';
  field('description').value = activity?.description ?? '';
  field('status').value = activity?.status ?? 'draft';
  field('level').value = activity?.level ?? DEFAULT_LEVEL;
  field('timed').value = activity?.timeLimitSec ? 'yes' : 'no';
  field('mode').value = activity?.mode ?? 'trace';
  const look = activity ?? DEFAULT_LOOK;
  field('style').value = look.letterStyle;
  for (const s of LETTER_STYLES) field(`allowed-${s}`).checked = look.allowedStyles.includes(s);
  field('paper').value = look.paper;
  field('linesize').value = look.lineSize;
  field('time').value = activity?.timeLimitSec ? `${Math.floor(activity.timeLimitSec / 60)}:${String(activity.timeLimitSec % 60).padStart(2, '0')}` : '1:00';
  field('sequence').value = activity?.type === 'letters' ? activity.sequence.join(' ') : '';
  field('repeat').value = activity?.type === 'letters' ? activity.repeat : 1;
  field('category').value = activity?.type === 'words' ? activity.category : '';
  field('words').value = activity?.type === 'words' ? activity.words.join('\n') : '';
  field('sentence').value = activity?.type === 'sentence' ? activity.text : '';
  field('paragraph').value = activity?.type === 'paragraph' ? activity.text : '';
}

function refreshForm() {
  $('f-error').hidden = true;
  const type = field('type').value;
  for (const t of ['letters', 'words', 'sentence', 'paragraph']) {
    for (const el of document.querySelectorAll(`.type-${t}`)) el.hidden = t !== type;
  }
  const timed = field('timed').value === 'yes';
  $('f-time-label').hidden = !timed;
  const seconds = parseDuration(field('time').value);
  field('timer-summary').textContent = !timed ? 'No timer: the child takes as long as they want and taps Finish.'
    : seconds === null ? 'Enter the time as m:ss or seconds.'
    : `Timed: ${timerLabel(seconds).replace(' timer', '')}. The clock starts at the first stroke.`;
  const parsed = parseActivityInput(readForm());
  drawPreview(parsed.ok ? parsed.value : null);
  field('problems').replaceChildren(...(parsed.ok ? [] : parsed.problems.map((p) => h('li', { textContent: p }))));
}

let previewRun = 0;

/** The sheet the child will see, in the chosen style, paper and line size, laid out as on an iPad in landscape. */
async function drawPreview(value) {
  const run = ++previewRun;
  const svg = field('preview');
  if (!value) {
    svg.replaceChildren();
    return;
  }
  const face = await loadFace(value.letterStyle);
  if (run !== previewRun) return;
  const layout = layoutSheet(toTraceText(value), { width: IPAD_STAGE_WIDTH.landscape, face, lineSize: value.lineSize });
  sizeSheet(svg, layout);
  svg.replaceChildren(drawTarget(layout, value.paper));
}

function showTab() {
  const current = tabFromHash(location.hash);
  for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== current;
  $('new-activity').hidden = current !== 'activities';
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  scrollTo(0, 0);
  if (current === 'practice' && tabApi) loadPractice(tabApi).catch(failed);
  if (current === 'progress' && tabApi && $('p-child').value) loadProgress(tabApi, $('p-child').value);
}

/** Set once signed in, so opening the Practice or Progress tab can load without showTab needing the client. */
let tabApi = null;

const formState = () => Array.from($('activity-form').elements, (el) => (el.type === 'checkbox' ? el.checked : el.value)).join('\0');
let pristine = '';

const discardable = () => formState() === pristine || confirm('Discard your changes to this activity?');

function openForm(activity) {
  editing = activity;
  fillForm(activity);
  $('form-heading').textContent = activity ? `Edit "${activity.title}"` : 'New activity';
  refreshForm();
  pristine = formState();
  dialog.showModal();
  const touch = matchMedia('(pointer: coarse)').matches;
  (touch ? $('form-heading') : field('title')).focus({ preventScroll: true });
}

/** Brings a saved activity's card to the middle of the screen and flashes it. */
function reveal(id, { focus }) {
  const card = document.querySelector(`#activities .card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  card.classList.add('just-saved');
  setTimeout(() => card.classList.remove('just-saved'), 2600);
  if (focus) card.querySelector('[data-action="edit"]').focus({ preventScroll: true });
}

/** @param {import('./api.js').ListedActivity} activity */
function summary(activity) {
  const detail = { letters: () => `${activity.sequence.join(' ')} × ${activity.repeat}`, words: () => `${activity.category}: ${activity.words.length} words`, sentence: () => activity.text, paragraph: () => activity.text.split('\n')[0] };
  return detail[activity.type]();
}

const kept = { getItem: (key) => localStorage.getItem(`g4k:admin:letterjoin:${key}`), setItem: (key, value) => localStorage.setItem(`g4k:admin:letterjoin:${key}`, value) };
const sections = createSections(() => kept, SECTIONS_KEY.admin);

function renderActivities(api) {
  const groups = groupByLevel(activities);
  $('activities').replaceChildren(...groups.map(({ level, items }) => {
    const info = LEVEL_INFO[level];
    const head = h('summary', { className: 'group-head' },
      h('strong', { className: 'group-name', textContent: info.label }),
      h('span', { className: 'group-ages', textContent: info.ages }),
      h('span', { className: 'group-count', textContent: `${items.length}` }),
      h('span', { className: 'chevron', ariaHidden: 'true' }));
    const group = h('details', { className: 'group', open: sections.isOpen(level, true), dataset: { level } },
      head,
      items.length === 0
        ? h('p', { className: 'note group-empty', textContent: 'Nothing here yet. Set an activity to this level in its Edit form.' })
        : h('ol', { className: 'cards' }, ...items.map((activity, i) => activityCard(api, activity, i, items))));
    head.addEventListener('click', () => sections.choose(level, !group.open));
    return h('li', {}, group);
  }));
}

function activityCard(api, activity, i, items) {
  const button = (label, onClick, extra = {}) => h('button', { type: 'button', textContent: label, onclick: onClick, ...extra });
  const move = (to) => async () => {
    const swapped = items.map((a) => a.id);
    [swapped[i], swapped[to]] = [swapped[to], swapped[i]];
    const ids = groupByLevel(activities).flatMap((group) => (group.level === activity.level ? swapped : group.items.map((a) => a.id)));
    try {
      activities = await api.orderActivities(ids);
      renderActivities(api);
      status(`Moved "${activity.title}".`);
    } catch (err) {
      await reload(api);
      failed(err);
    }
  };
  const save = async (changes, message) => {
    try {
      const { id, order, updatedAt, result, etag, ...input } = { ...activity, ...changes };
      const saved = await api.updateActivity(id, input, etag);
      activities[activities.findIndex((a) => a.id === id)] = { ...saved, result };
      renderActivities(api);
      status(message);
    } catch (err) {
      await reload(api);
      failed(err);
    }
  };
  const published = activity.status === 'published';
  return h('li', { className: 'card', dataset: { id: activity.id, level: activity.level } },
    h('strong', { textContent: `${i + 1}.` }),
    h('div', {},
      h('div', {}, h('span', { className: 'badge', textContent: typeLabel(activity.type) }), ' ', h('strong', { className: 'title', textContent: activity.title }), ' ',
        h('span', { className: `badge ${activity.status}`, textContent: published ? 'Published' : 'Draft' })),
      h('div', { className: 'meta', textContent: `${summary(activity)} · ${timerLabel(activity.timeLimitSec)}${activity.mode === 'traceThenCopy' ? ' · then copy' : ''}` })),
    h('span'),
    h('div', { className: 'actions' },
      button('Up', move(i - 1), { disabled: i === 0, ariaLabel: `Move ${activity.title} up` }),
      button('Down', move(i + 1), { disabled: i === items.length - 1, ariaLabel: `Move ${activity.title} down` }),
      button('Edit', () => openForm(activity), { dataset: { action: 'edit' } }),
      button(published ? 'Unpublish' : 'Publish', () => save({ status: published ? 'draft' : 'published' }, `${published ? 'Unpublished' : 'Published'} "${activity.title}".`)),
      button('Delete', async () => {
        if (!confirm(`Delete "${activity.title}"? This cannot be undone.`)) return;
        try {
          await api.deleteActivity(activity.id);
          await reload(api);
          status(`Deleted "${activity.title}".`);
        } catch (err) {
          failed(err);
        }
      }, { className: 'danger' })));
}

/** The children granted this game, by the name each chose, for the Review filter and the Progress picker. */
async function loadChildren(api) {
  const children = await api.children();
  for (const [select, first] of [[$('r-child'), 'All children'], [$('p-child'), 'Choose a child']]) {
    const chosen = select.value;
    select.replaceChildren(h('option', { value: '', textContent: first }), ...children.map((c) => h('option', { value: c.userId, textContent: c.name })));
    select.value = children.some((c) => c.userId === chosen) ? chosen : '';
  }
}

async function reload(api) {
  activities = await api.activities();
  $('count-activities').textContent = activities.length;
  renderActivities(api);
  const chosen = $('r-activity').value;
  $('r-activity').replaceChildren(h('option', { value: '', textContent: 'All activities' }), ...activities.map((a) => h('option', { value: a.id, textContent: a.title })));
  $('r-activity').value = activities.some((a) => a.id === chosen) ? chosen : '';
}

/** Object URLs of the thumbnails on screen, revoked whenever the list is replaced or the page goes away. */
const imageUrls = new Map();
let reviewCursor = null;

function forgetImage(id) {
  URL.revokeObjectURL(imageUrls.get(id));
  imageUrls.delete(id);
}

const when = (iso) => new Date(iso).toLocaleString();

/** @param {import('./api.js').Submission} submission */
function submissionCard(api, submission) {
  const image = h('img', { className: 'thumb', alt: `${submission.activityTitle} copied by ${submission.userName}` });
  api.submissionImage(submission.id).then((blob) => {
    const url = URL.createObjectURL(blob);
    imageUrls.set(submission.id, url);
    image.src = url;
  }, () => {
    image.alt = 'The image could not be loaded.';
  });
  const reviewed = h('input', { type: 'checkbox', checked: submission.reviewed });
  const note = h('textarea', { rows: 2, maxLength: 500, value: submission.note, placeholder: 'Note (optional)', ariaLabel: 'Note' });
  const stamp = h('div', { className: 'meta stamp' });
  const card = h('li', { className: 'card review', dataset: { id: submission.id } });
  const show = (s) => {
    card.dataset.reviewed = String(s.reviewed);
    stamp.textContent = s.reviewed ? `Reviewed ${when(s.reviewedAt)}` : 'Not reviewed yet';
  };
  const save = async () => {
    try {
      const saved = await api.reviewSubmission(submission.id, { reviewed: reviewed.checked, note: note.value });
      show(saved);
      note.value = saved.note;
      status(`Saved the review of ${submission.userName}'s "${submission.activityTitle}".`);
    } catch (err) {
      failed(err);
    }
  };
  reviewed.addEventListener('change', save);
  card.append(
    h('button', { type: 'button', className: 'thumb-button', ariaLabel: 'View full size', onclick: () => {
      $('viewer-image').src = image.src;
      $('viewer-image').alt = image.alt;
      $('viewer').showModal();
    } }, image),
    h('div', { className: 'review-body' },
      h('strong', { className: 'title', textContent: submission.activityTitle }),
      h('div', { className: 'meta', textContent: `${submission.userName} · ${when(submission.createdAt)} · ${Math.ceil(submission.bytes / 1024)} KB` }),
      stamp,
      h('label', { className: 'check' }, reviewed, ' Reviewed'),
      note,
      h('div', { className: 'actions' },
        h('button', { type: 'button', textContent: 'Save note', onclick: save }),
        h('button', { type: 'button', className: 'danger', textContent: 'Delete', onclick: async () => {
          if (!confirm(`Delete ${submission.userName}'s copy of "${submission.activityTitle}"? This cannot be undone.`)) return;
          try {
            await api.discardSubmission(submission.id);
            forgetImage(submission.id);
            card.remove();
            $('review-empty').hidden = $('submissions').children.length > 0;
            status(`Deleted ${submission.userName}'s copy of "${submission.activityTitle}".`);
          } catch (err) {
            failed(err);
          }
        } }))));
  show(submission);
  return card;
}

async function loadSubmissions(api, { more = false } = {}) {
  const page = await api.submissions({
    userId: $('r-child').value,
    activityId: $('r-activity').value,
    unreviewed: $('r-unreviewed').checked,
    after: more ? reviewCursor : undefined,
    limit: 12,
  });
  if (!more) {
    for (const id of [...imageUrls.keys()]) forgetImage(id);
    $('submissions').replaceChildren();
  }
  reviewCursor = page.next;
  $('submissions').append(...page.submissions.map((s) => submissionCard(api, s)));
  $('review-more').hidden = !page.next;
  $('review-empty').hidden = $('submissions').children.length > 0;
}

const practiceSummary = (minutes) => (minutes === 0
  ? 'Off. Children see no daily practice clock.'
  : `On. Each child practises ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} a day.`);

/** The last seven days for every child, from the server. Reloaded each time the Practice tab opens. */
async function loadPractice(api) {
  const report = await api.practiceReport(localDay(Date.now()));
  const today = report.days.at(-1);
  $('practice-goal').textContent = goalText(report.goalMinutes);
  $('practice-head').replaceChildren(h('tr', {},
    h('th', { scope: 'col', textContent: 'Child' }),
    ...report.days.map((day) => {
      const th = h('th', { scope: 'col', textContent: dayLabel(day) });
      if (day === today) th.className = 'today';
      return th;
    }),
    h('th', { scope: 'col', textContent: 'Total' })));
  $('practice-body').replaceChildren(...report.children.map((child) => h('tr', { dataset: { userId: child.userId } },
    h('th', { scope: 'row', textContent: child.name }),
    ...child.seconds.map((seconds) => {
      const { text, met, title } = cellFor(seconds, report.goalMinutes);
      const td = h('td', { textContent: text, title });
      td.className = `${met ? 'met' : ''}${seconds === 0 ? ' none' : ''}`.trim();
      return td;
    }),
    h('td', { className: 'total', textContent: totalText(child.totalSeconds) }))));
  $('practice-empty').hidden = report.children.length > 0;
  $('practice-table').hidden = report.children.length === 0;
}

const metricCells = ({ count, accuracy, speed }) => [String(count), accuracyText(accuracy), speedText(speed)].map((textContent) => h('td', { textContent }));

function renderDays(days) {
  $('progress-days').replaceChildren(...days.flatMap((day) => {
    const row = h('tr', { className: 'day', dataset: { date: day.date } }, h('th', { scope: 'row', textContent: progressDayLabel(day.date) }), ...metricCells(day));
    const levels = LEVELS.filter((level) => day.byLevel[level]).map((level) => h('tr', { className: 'level', dataset: { date: day.date, level } },
      h('th', { scope: 'row', textContent: LEVEL_INFO[level].label }), ...metricCells(day.byLevel[level])));
    return [row, ...levels];
  }));
  $('progress-table').hidden = days.length === 0;
  $('progress-note').hidden = days.length === 0;
}

function renderTrend(attempts) {
  const trend = trendOf(attempts);
  const words = trendWords(trend);
  $('verdict').textContent = words.headline;
  $('verdict').dataset.verdict = trend.verdict;
  $('verdict-accuracy').textContent = words.accuracy;
  $('verdict-speed').textContent = words.speed;
  $('progress-levels').replaceChildren(...Object.entries(trendByLevel(attempts)).map(([level, levelTrend]) => {
    const said = trendWords(levelTrend);
    return h('li', { dataset: { level, verdict: levelTrend.verdict } },
      h('strong', { textContent: `${LEVEL_INFO[level].label}. ` }), said.headline, ...(said.accuracy ? [`. ${said.accuracy}. ${said.speed}.`] : []));
  }));
  $('trend-note').textContent = `Compares the older and newer half of the last ${TREND_DAYS} days of tracing and needs at least ${MIN_TREND_DAYS}. `
    + `Accuracy must move ${ACCURACY_STEP} points and speed ${SPEED_STEP * 100}% to count. A Champion day scores lower than a Starter day, so check each level when the mix changes.`;
  $('progress-trend').hidden = false;
}

/** Bumped per request, so picking another child while one loads never shows the first child's numbers. */
let progressRun = 0;

async function loadProgress(api, userId) {
  const run = ++progressRun;
  const name = $('p-child').selectedOptions[0]?.textContent ?? 'this child';
  history.replaceState(null, '', `?child=${encodeURIComponent(userId)}#progress`);
  $('progress-trend').hidden = true;
  renderDays([]);
  $('progress-status').textContent = `Loading ${name}…`;
  try {
    const attempts = await api.childProgress(userId);
    if (run !== progressRun) return;
    $('progress-status').textContent = attempts.length ? `Progress of ${name}` : `No finished tracing from ${name} in the last 120 days.`;
    if (attempts.length) {
      renderTrend(attempts);
      renderDays(summarizeDays(attempts));
    }
  } catch (err) {
    if (run === progressRun) $('progress-status').textContent = err.message;
  }
}

function showSettings({ dailyPracticeMinutes, hardModeDefault }) {
  $('s-minutes').value = String(dailyPracticeMinutes);
  $('s-hard').checked = hardModeDefault;
  $('s-summary').textContent = practiceSummary(dailyPracticeMinutes);
}

const { api: client } = await enterAdmin({ game: 'letterjoin' });
const api = createApi(client);
for (const id of ['type', 'timed', 'time', 'mode', 'title', 'description', 'status', 'style', 'allowed-print', 'allowed-precursive', 'allowed-joined', 'paper', 'linesize', 'sequence', 'repeat', 'category', 'words', 'sentence', 'paragraph']) {
  field(id).addEventListener('input', refreshForm);
}
field('repeat').max = LIMITS.repeat;
$('new-activity').addEventListener('click', () => openForm(null));
field('cancel').addEventListener('click', () => discardable() && dialog.close());
dialog.addEventListener('cancel', (e) => discardable() || e.preventDefault());
dialog.addEventListener('close', () => {
  editing = null;
});
$('activity-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveButton = field('save');
  if (saveButton.disabled) return;
  const parsed = parseActivityInput(readForm());
  if (!parsed.ok) {
    refreshForm();
    say(`Not saved:\n${parsed.problems.join('\n')}`);
    return;
  }
  const wasEditing = editing;
  saveButton.disabled = true;
  try {
    const saved = wasEditing ? await api.updateActivity(wasEditing.id, parsed.value, wasEditing.etag) : await api.createActivity(parsed.value);
    sections.choose(parsed.value.level, true);
    dialog.close();
    status(`Saved "${parsed.value.title}".`);
    await reload(api);
    reveal(saved.id, { focus: Boolean(wasEditing) });
  } catch (err) {
    if (err.status === 412) {
      dialog.close();
      await reload(api);
    }
    failed(err);
  } finally {
    saveButton.disabled = false;
  }
});
$('review-filter').addEventListener('submit', (e) => {
  e.preventDefault();
  loadSubmissions(api).catch(failed);
});
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('s-minutes').value.trim();
  // The server owns the rules; anything that is not plain digits goes as typed so its message explains the problem.
  const minutes = /^\d{1,4}$/.test(text) ? Number(text) : text;
  try {
    const saved = await api.saveSettings({ dailyPracticeMinutes: minutes, hardModeDefault: $('s-hard').checked });
    showSettings(saved);
    status(saved.dailyPracticeMinutes === 0
      ? 'Saved. The daily practice clock is off for every child.'
      : `Saved. ${practiceSummary(saved.dailyPracticeMinutes).replace('On. ', '')} Children see it on their next visit.`);
  } catch (err) {
    failed(err);
  }
});
$('review-more').addEventListener('click', () => loadSubmissions(api, { more: true }).catch(failed));
addEventListener('pagehide', () => {
  for (const id of [...imageUrls.keys()]) forgetImage(id);
});
tabApi = api;
$('progress-filter').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('p-child').value) loadProgress(api, $('p-child').value).catch(failed);
});
$('practice-refresh').addEventListener('click', () => loadPractice(api).catch(failed));
showTab();
addEventListener('hashchange', showTab);
try {
  await reload(api);
  await loadChildren(api);
  showSettings(await api.settings());
  await loadSubmissions(api);
  const wanted = new URLSearchParams(location.search).get('child');
  if (wanted && $('p-child').querySelector(`option[value="${CSS.escape(wanted)}"]`)) {
    $('p-child').value = wanted;
    if (location.hash === '#progress') loadProgress(api, wanted).catch(failed);
  }
} catch (err) {
  failed(err);
}
ready();
