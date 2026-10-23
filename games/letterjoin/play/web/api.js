import { LEVELS, parseActivity } from './activity.js';

/**
 * @typedef {import('./activity.js').Activity} Activity
 * @typedef {{ score: number, timeMs: number, hard: boolean, completedAt: string }} Result hard when it was written in hard mode
 * @typedef {import('./progress.js').Attempt} Attempt
 * @typedef {Activity & { result: Result | null }} ListedActivity
 * @typedef {{ words: { text: string, confidence: number, box: { x: number, y: number, w: number, h: number } }[] }} RecognitionResult
 * @typedef {{ minutes: number, usedSeconds: number }} PracticeToday the admin's daily minutes and the time used that local day
 * @typedef {{ dailyPracticeMinutes: number, hardModeDefault: boolean }} Settings
 * @typedef {{ name: string, me: boolean, points: number[], total: number }} BoardLine one child's points on each of the board's days
 * @typedef {{ optedIn: false } | { optedIn: true, days: string[], levels: { level: import('./activity.js').Level, children: BoardLine[] }[] }} Board
 */

export class ApiError extends Error {
  /** @param {number} status @param {string} message @param {string[]} problems */
  constructor(status, message, problems = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problems = problems;
  }
}

function parseResult(raw) {
  if (raw === null || raw === undefined) return null;
  const ok = Number.isFinite(raw.score) && Number.isInteger(raw.timeMs) && typeof raw.completedAt === 'string';
  if (!ok) throw new ApiError(502, 'The server sent a result this app does not understand.');
  return { score: raw.score, timeMs: raw.timeMs, hard: raw.hard === true, completedAt: raw.completedAt };
}

function parseAttempt(raw) {
  const ok = typeof raw?.id === 'string' && typeof raw.activityId === 'string' && LEVELS.includes(raw.level)
    && Number.isInteger(raw.chars) && raw.chars >= 0 && Number.isFinite(raw.score) && raw.score >= 0 && raw.score <= 100
    && Number.isInteger(raw.timeMs) && raw.timeMs >= 0 && typeof raw.completedAt === 'string' && !Number.isNaN(Date.parse(raw.completedAt));
  if (!ok) throw new ApiError(502, 'The server sent an attempt this app does not understand.');
  const { id, activityId, level, chars, score, timeMs, completedAt } = raw;
  return { id, activityId, level, chars, score, timeMs, completedAt };
}

/** @returns {Attempt[]} */
function parseAttempts(data) {
  if (!Array.isArray(data?.attempts)) throw new ApiError(502, 'The server sent progress this app does not understand.');
  return data.attempts.map(parseAttempt);
}

/** @returns {Board} */
function parseBoard(raw) {
  if (raw?.optedIn === false) return { optedIn: false };
  const line = (c) => typeof c?.name === 'string' && typeof c.me === 'boolean' && Array.isArray(c.points) && c.points.every(Number.isFinite) && Number.isFinite(c.total);
  const ok = raw?.optedIn === true && Array.isArray(raw.days) && Array.isArray(raw.levels)
    && raw.levels.every((l) => LEVELS.includes(l?.level) && Array.isArray(l.children) && l.children.every(line));
  if (!ok) throw new ApiError(502, 'The server sent a board this app does not understand.');
  return { optedIn: true, days: raw.days, levels: raw.levels.map(({ level, children }) => ({ level, children: children.map(({ name, me, points, total }) => ({ name, me, points, total })) })) };
}

/** @returns {RecognitionResult} */
function parseRecognition(raw) {
  const box = (b) => ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(b?.[k]));
  const ok = Array.isArray(raw?.words) && raw.words.every((w) => typeof w?.text === 'string' && Number.isFinite(w.confidence) && box(w.box));
  if (!ok) throw new ApiError(502, 'The server sent a reading this app does not understand.');
  return { words: raw.words.map(({ text, confidence, box: { x, y, w, h } }) => ({ text, confidence, box: { x, y, w, h } })) };
}

/** @returns {ListedActivity} */
function parseListed(raw) {
  const parsed = parseActivity(raw);
  if (!parsed.ok) throw new ApiError(502, `The server sent an activity this app does not understand: ${parsed.problems.join('; ')}`);
  return { ...parsed.value, result: parseResult(raw.result) };
}

/**
 * This game's player API over the shell's client, which signs every call and reads the one error shape.
 * @param {import('/shell/v1/index.js').ApiClient} client
 */
export function createApi(client) {
  const id = encodeURIComponent;
  return {
    /** @returns {Promise<ListedActivity[]>} published activities, each with the caller's latest result */
    activities: async () => (await client.get('activities')).activities.map(parseListed),
    /** @param {{ attemptId: string, score: number, timeMs: number, hard?: boolean }} result @returns {Promise<Result>} */
    saveResult: async (activityId, result) => parseResult(await client.put(`activities/${id(activityId)}/result`, result)),
    /** The caller's own attempts for the last 120 days, oldest first. @returns {Promise<Attempt[]>} */
    progress: async () => parseAttempts(await client.get('progress')),
    /** The friends board for the seven days ending on the device's day, or that the child has not switched it on. @returns {Promise<Board>} */
    board: async (day) => parseBoard(await client.get('board', { day })),
    /** Switches the child on or off the board. Off removes them at once. @returns {Promise<{ optedIn: boolean }>} */
    setBoard: (on) => client.put('board/me', { on }),
    /** @returns {Promise<Settings>} */
    settings: () => client.get('settings'),
    /** @returns {Promise<PracticeToday>} */
    practice: (day) => client.get('practice', { day }),
    /** @returns {Promise<PracticeToday>} */
    addPractice: (day, seconds, { keepalive = false } = {}) => client.post('practice', { day, seconds }, keepalive ? { keepalive: true } : undefined),
    /** Sends the child's unaided copy as a PNG. It is saved for an admin to review and never scored. @param {string} activityId @param {Blob} png */
    submitCopy: (activityId, png) => client.sendPng(`activities/${id(activityId)}/submission`, png),
    /** Reads the handwriting in a PNG of one line of an activity. Nothing is kept. Boxes are in the pixels of that image. @param {string} activityId @param {Blob} png @returns {Promise<RecognitionResult>} */
    readHandwriting: async (activityId, png) => parseRecognition(await client.sendPng(`activities/${id(activityId)}/read`, png)),
  };
}
