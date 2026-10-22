import { createApi } from './api.js';
import { fresh, isDone, phase, shuffled, tap } from './quiz.js';
import { CONFIDENCE, POINTS, questionPoints } from './rules.js';
import { enter, ready, whileLoading } from '/shell/v1/index.js';

const session = await enter({ game: 'timedetectives' });
const api = createApi(session.api);
const $ = (id) => document.getElementById(id);
const SCREENS = ['home-screen', 'sure-screen', 'read-screen', 'quiz-screen', 'result-screen'];

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Shows one screen and moves focus to its heading, so a keyboard or screen reader user starts at the top of it. */
function show(screen, heading = $(screen).querySelector('h1, h2')) {
  for (const id of SCREENS) $(id).hidden = id !== screen;
  window.scrollTo(0, 0);
  heading.focus({ preventScroll: true });
}

function say(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text;
}

/** Blank lines in a paragraph start a new one. */
const paragraphs = (node, text) => node.replaceChildren(...text.split(/\n\s*\n/).map((part) => h('p', { textContent: part.trim() })));

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** @type {import('./api.js').Topic[]} */
let topics = [];
/** @type {import('./api.js').Topic | null} */
let topic = null;
/**
 * The round being played. `attemptId` is made once, so saving again after a failure cannot count the round twice.
 * @type {{ round: import('./api.js').Round, attemptId: string, choices: Map<string, string[]>, answers: Map<string, import('./quiz.js').Answer> } | null}
 */
let play = null;

function renderTopics() {
  $('topics').replaceChildren(...topics.map((t, i) => h('li', {},
    h('button', { type: 'button', className: `topic tone-${i % 4}`, onclick: () => chooseTopic(t) },
      h('span', { className: 'topic-title', textContent: t.title }),
      h('span', { className: 'topic-go', textContent: 'Investigate' })))));
  say('topics-status', topics.length === 0 ? 'There are no mysteries yet. Ask your grown-up to add some.' : '');
}

function showTopics() {
  $('topics-panel').hidden = false;
  show('home-screen', $('topics-heading'));
  $('cover').setAttribute('aria-expanded', 'true');
  $('cover').classList.add('opened');
  renderTopics();
}

function chooseTopic(chosen) {
  topic = chosen;
  $('sure-topic').textContent = chosen.title;
  say('sure-status', '');
  show('sure-screen');
}

function sureDetail({ paragraph, choices, bonus }) {
  const reading = paragraph === 'brief' ? 'A short clue' : 'The whole story';
  return `${reading}, ${choices} answers to pick from, ${bonus > 1 ? `×${bonus} points` : 'normal points'}`;
}

$('sure-choices').replaceChildren(...Object.entries(CONFIDENCE).map(([confidence, rule]) =>
  h('button', { type: 'button', className: `sure sure-${confidence}`, onclick: () => start(confidence) },
    h('span', { className: 'sure-label', textContent: rule.label }),
    h('span', { className: 'sure-detail', textContent: sureDetail(rule) }))));

async function start(confidence) {
  say('sure-status', '');
  try {
    const { round, picture } = await whileLoading((async () => {
      const next = await api.next(topic.id, confidence);
      return { round: next, picture: await api.picture(next.id) };
    })());
    play = {
      round,
      attemptId: crypto.randomUUID(),
      choices: new Map(round.questions.map((q) => [q.kind, shuffled(q.choices)])),
      answers: new Map(round.questions.map((q) => [q.kind, fresh()])),
    };
    $('quiz-picture').src = picture;
    $('quiz-picture').alt = round.pictureAlt;
    paragraphs($('read-text'), round.paragraph);
    paragraphs($('clue-text'), round.paragraph);
    show('read-screen');
  } catch (err) {
    say('sure-status', err.code === 'no_rounds' ? 'There are no mysteries in that topic yet. Try another one.' : err.message);
  }
}

function feedbackFor(answer, question) {
  const points = questionPoints(answer, question.answer);
  switch (phase(answer, question.answer)) {
    case 'right': return { tone: 'right', text: `${answer.tries.length === 1 ? 'Brilliant!' : 'You got it!'} +${points}` };
    case 'missed': return { tone: 'missed', text: `The answer was ${question.answer}.` };
    case 'retry': return { tone: 'retry', text: 'Not quite. Have another go!' };
    default: return { tone: '', text: '' };
  }
}

function renderQuestion(question, item) {
  const answer = play.answers.get(question.kind);
  const done = isDone(answer, question.answer);
  item.dataset.phase = phase(answer, question.answer);
  for (const button of item.querySelectorAll('.choice')) {
    const choice = button.dataset.choice;
    const tried = answer.tries.includes(choice);
    const right = choice === question.answer;
    button.classList.toggle('wrong', tried && !right);
    button.classList.toggle('right', right && done);
    button.disabled = done || tried;
    button.setAttribute('aria-pressed', String(tried));
  }
  const { tone, text } = feedbackFor(answer, question);
  const feedback = item.querySelector('.feedback');
  feedback.dataset.tone = tone;
  feedback.textContent = text;
  item.querySelector('.hint').hidden = answer.hint || done;
  item.querySelector('.hint-text').hidden = !answer.hint;
}

function choose(question, item, choice, button) {
  const before = play.answers.get(question.kind);
  const after = tap(before, choice, question.answer);
  if (after === before) return;
  play.answers.set(question.kind, after);
  if (choice !== question.answer) {
    button.classList.remove('shake');
    void button.offsetWidth;
    button.classList.add('shake');
  }
  renderQuestion(question, item);
  const finished = play.round.questions.every((q) => isDone(play.answers.get(q.kind), q.answer));
  $('finish').hidden = !finished;
  // The tapped choice is now disabled, so focus moves on: to the next choice still open, else to what the tap meant.
  if (finished) {
    $('finish').focus({ preventScroll: true });
    $('finish').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (isDone(after, question.answer)) item.querySelector('.feedback').focus();
  else {
    const open = [...item.querySelectorAll('.choice')].filter((choice) => !choice.disabled);
    (open.find((choice) => button.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING) ?? open[0]).focus();
  }
}

function questionItem(question) {
  const item = h('li', { className: 'question' });
  const heading = h('h3', { id: `q-${question.kind}`, textContent: question.label });
  const choices = h('div', { className: 'choices', role: 'group' });
  choices.setAttribute('aria-labelledby', heading.id);
  choices.append(...play.choices.get(question.kind).map((choice) => {
    const button = h('button', { type: 'button', className: 'choice', textContent: choice });
    button.dataset.choice = choice;
    button.addEventListener('click', () => choose(question, item, choice, button));
    button.addEventListener('animationend', () => button.classList.remove('shake'));
    return button;
  }));
  const hint = h('button', { type: 'button', className: 'hint quiet', textContent: `Show a hint (costs ${POINTS.hint} points)` });
  hint.addEventListener('click', () => {
    play.answers.set(question.kind, { ...play.answers.get(question.kind), hint: true });
    renderQuestion(question, item);
    item.querySelector('.hint-text').focus();
  });
  item.append(heading, choices, h('p', { className: 'feedback', ariaLive: 'polite', tabIndex: -1 }), hint, h('p', { className: 'hint-text', tabIndex: -1, textContent: question.hint }));
  renderQuestion(question, item);
  return item;
}

function showQuiz() {
  $('questions').replaceChildren(...play.round.questions.map(questionItem));
  $('finish').hidden = true;
  $('finish').disabled = false;
  $('quiz-again').hidden = true;
  say('quiz-status', '');
  show('quiz-screen');
}

async function finish() {
  const { round, attemptId, answers } = play;
  $('finish').disabled = true;
  say('quiz-status', '');
  try {
    const body = { confidence: round.confidence, version: round.version, answers: round.questions.map((q) => ({ kind: q.kind, ...answers.get(q.kind) })) };
    showResult(await whileLoading(api.save(round.id, attemptId, body)));
  } catch (err) {
    if (err.code === 'round_changed') {
      $('quiz-status').dataset.tone = 'kind';
      say('quiz-status', 'A grown-up changed this mystery while you were solving it, so it cannot be scored. Sorry! Try another one.');
      $('finish').hidden = true;
      $('quiz-again').hidden = false;
      $('quiz-again').focus();
      return;
    }
    delete $('quiz-status').dataset.tone;
    say('quiz-status', `${err.message} Press the button to try again.`);
    $('finish').disabled = false;
  }
}

function showResult(saved) {
  const { round, answers } = play;
  const { bonus } = CONFIDENCE[round.confidence];
  const sum = round.questions.reduce((total, q) => total + questionPoints(answers.get(q.kind), q.answer), 0);
  $('result-points').textContent = String(saved.points);
  $('result-bonus').textContent = bonus > 1 ? `${sum} for your answers, times ${bonus} for knowing ${round.confidence === 'lots' ? 'a lot' : 'a bit'}.` : `${sum} for your answers.`;
  $('result-answers').replaceChildren(...round.questions.map((q) => {
    const right = saved.right[q.kind] === true;
    return h('li', { className: right ? 'right' : 'missed' },
      h('span', { className: 'mark', textContent: right ? '✓' : '✗', ariaHidden: 'true' }),
      h('span', { className: 'label', textContent: q.label }),
      h('strong', { textContent: q.answer }),
      h('span', { className: 'visually-hidden', textContent: right ? ' You got it.' : ' Not this time.' }));
  }));
  $('result-today').textContent = `You have ${saved.total} points today.`;
  show('result-screen');
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
    $('board-switch').disabled = false;
    $('board-switch').setAttribute('aria-checked', String(board.optedIn));
    $('board-explain').hidden = board.optedIn;
    $('board-table').hidden = !board.optedIn || board.children.length === 0;
    if (board.optedIn) {
      $('board-rows').replaceChildren(...board.children.map((line) => h('tr', { className: line.me ? 'me' : '' },
        h('th', { scope: 'row', textContent: line.me ? `${line.name} (you)` : line.name }),
        h('td', { textContent: String(line.points.at(-1) ?? 0) }),
        h('td', { textContent: String(line.total) }))));
      if (board.children.length === 0) say('board-status', 'Your points count from now on. Play another round to get on the board!');
    }
  } catch (err) {
    if (run === boardRun) say('board-status', err.message);
  }
}

async function toggleBoard() {
  const button = $('board-switch');
  const on = button.getAttribute('aria-checked') !== 'true';
  button.disabled = true;
  try {
    await api.setBoard(on);
  } catch (err) {
    button.disabled = false;
    say('board-status', err.message);
    return;
  }
  await loadBoard();
}

$('cover').addEventListener('click', showTopics);
$('sure-back').addEventListener('click', showTopics);
$('read-done').addEventListener('click', showQuiz);
$('read-again').addEventListener('click', () => $('clue').showModal());
$('finish').addEventListener('click', finish);
$('board-switch').addEventListener('click', toggleBoard);
function playAnother() {
  showTopics();
  api.topics().then((latest) => {
    topics = latest;
    renderTopics();
  }, () => {});
}

$('again').addEventListener('click', playAnother);
$('quiz-again').addEventListener('click', playAnother);

try {
  topics = await api.topics();
  renderTopics();
} catch (err) {
  say('topics-status', err.message);
}
ready();
