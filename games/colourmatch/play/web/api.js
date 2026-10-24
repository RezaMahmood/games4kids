import { parseTuning } from './rules.js';

/**
 * @typedef {{ tuningId: string, tuning: Record<string, number> }} Start
 * @typedef {{ gameId: string, score: number, roundsReached: number, correct: number, turns: number, bestToday: number }} Saved
 * @typedef {{ name: string, me: boolean, points: number[], total: number }} BoardLine
 * @typedef {{ optedIn: false } | { optedIn: true, days: string[], children: BoardLine[] }} Board
 */

/** Browsers refuse a keepalive request whose body would take their in-flight keepalive bytes past 64 KB. */
export const KEEPALIVE_MAX_BYTES = 60_000;

const strange = (what) => new Error(`The server sent ${what} this game does not understand.`);
const isText = (value) => typeof value === 'string';

/** @returns {Start} */
function parseStart(raw) {
  const tuning = parseTuning(raw?.tuning);
  if (!isText(raw?.tuningId) || !tuning.ok) throw strange('settings');
  return { tuningId: raw.tuningId, tuning: tuning.value };
}

/** @returns {Saved} */
function parseSaved(raw) {
  if (!isText(raw?.gameId) || !['score', 'roundsReached', 'correct', 'turns', 'bestToday'].every((key) => Number.isFinite(raw[key]))) throw strange('a score');
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
    /** The settings a new game plays under, and their id for the log. */
    start: async () => parseStart(await client.get('start')),
    /** Saves a finished game once per gameId, as keepalive when it fits, so the save outlives a page the child is leaving. */
    save: async (gameId, log) => {
      const fits = new TextEncoder().encode(JSON.stringify(log)).byteLength < KEEPALIVE_MAX_BYTES;
      return parseSaved(await client.put(`games/${id(gameId)}`, log, fits ? { keepalive: true } : undefined));
    },
    board: async (day) => parseBoard(await client.get('board', { day })),
    setBoard: (on) => client.put('board/me', { on }),
  };
}
