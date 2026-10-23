import { CONFIDENCE, QUESTION_KINDS } from './rules.js';

/**
 * @typedef {{ id: string, title: string }} Topic
 * @typedef {{ kind: keyof typeof QUESTION_KINDS, label: string, choices: string[], answer: string, hint: string }} Question
 * @typedef {{ id: string, version: string, confidence: import('./rules.js').Confidence, paragraph: string, pictureAlt: string, questions: Question[] }} Round
 * @typedef {{ points: number, right: Record<string, boolean>, total: number }} Saved
 * @typedef {{ name: string, me: boolean, points: number[], total: number }} BoardLine
 * @typedef {{ optedIn: false } | { optedIn: true, days: string[], children: BoardLine[] }} Board
 */

const strange = (what) => new Error(`The server sent ${what} this game does not understand.`);
const isText = (value) => typeof value === 'string';

/** @returns {Topic[]} */
function parseTopics(raw) {
  if (!Array.isArray(raw?.topics) || !raw.topics.every((t) => isText(t?.id) && isText(t.title))) throw strange('topics');
  return raw.topics.map(({ id, title }) => ({ id, title }));
}

/** @returns {Round} */
function parseRound(raw) {
  const question = (q) => q && Object.hasOwn(QUESTION_KINDS, q.kind) && isText(q.label) && isText(q.answer) && isText(q.hint)
    && Array.isArray(q.choices) && q.choices.every(isText) && q.choices.includes(q.answer);
  const ok = isText(raw?.id) && isText(raw.version) && Object.hasOwn(CONFIDENCE, raw.confidence) && isText(raw.paragraph) && isText(raw.pictureAlt)
    && Array.isArray(raw.questions) && raw.questions.length > 0 && raw.questions.every(question);
  if (!ok) throw strange('a round');
  return raw;
}

/** @returns {Saved} */
function parseSaved(raw) {
  if (!Number.isFinite(raw?.points) || !Number.isFinite(raw.total) || typeof raw.right !== 'object' || raw.right === null) throw strange('a score');
  return raw;
}

/** @returns {Board} */
function parseBoard(raw) {
  if (raw?.optedIn === false) return { optedIn: false };
  const line = (c) => isText(c?.name) && typeof c.me === 'boolean' && Array.isArray(c.points) && c.points.every(Number.isFinite) && Number.isFinite(c.total);
  if (raw?.optedIn !== true || !Array.isArray(raw.days) || !Array.isArray(raw.children) || !raw.children.every(line)) throw strange('a board');
  return raw;
}

/**
 * This game's player API over the shell's client, which signs every call and reads the one error shape.
 * @param {import('/shell/v1/index.js').ApiClient} client
 */
export function createApi(client) {
  const id = encodeURIComponent;
  return {
    /** Topics that have at least one round to play. */
    topics: async () => parseTopics(await client.get('topics')),
    /** A round from the topic, one the child has not played when there is one. */
    next: async (topicId, confidence) => parseRound(await client.get(`topics/${id(topicId)}/next`, { confidence })),
    /** The round's picture as an object URL the page can show. */
    picture: (roundId) => client.objectUrl(`rounds/${id(roundId)}/picture`),
    /** Saves the finished round once per attemptId and answers with its points and the child's points today. */
    save: async (roundId, attemptId, body) => parseSaved(await client.put(`rounds/${id(roundId)}/attempts/${id(attemptId)}`, body)),
    board: async (day) => parseBoard(await client.get('board', { day })),
    setBoard: (on) => client.put('board/me', { on }),
  };
}
