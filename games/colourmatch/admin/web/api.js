import { parseTuning } from './rules.js';

/**
 * @typedef {{ id: string, savedAt: string, tuning: Record<string, number> }} Version
 * @typedef {{ userId: string, name: string }} Child
 * @typedef {{ key: string, gameId: string, savedAt: string, startedAt: string, mode: string, tuningId: string, endReason: string, score: number, roundsReached: number,
 *   turns: number, correct: number, accuracy: number, longestStreak: number, medianCongruentMs: number | null, medianIncongruentMs: number | null,
 *   timeouts: number, hiddenMs: number, pointer: string, viewport: string }} Game
 * @typedef {{ round: number, turn: number, word: string, ink: string, squares: string[], answer: { tapped: number, answerMs: number } | null, clockLeftMs: number, correct: boolean, points: number }} Turn
 */

const strange = (what) => new Error(`The server sent ${what} this page does not understand.`);

/** @returns {Version} */
function parseVersion(raw) {
  const tuning = parseTuning(raw?.tuning);
  if (typeof raw?.id !== 'string' || typeof raw.savedAt !== 'string' || !tuning.ok) throw strange('a settings version');
  return { id: raw.id, savedAt: raw.savedAt, tuning: tuning.value };
}

/**
 * This game's admin API over the shell's client, which signs every call and reads the one error shape.
 * @param {import('/shell/v1/index.js').ApiClient} client
 */
export function createApi(client) {
  const id = encodeURIComponent;
  return {
    /** @returns {Promise<{ current: Version, versions: Version[] }>} newest first */
    tunings: async () => {
      const raw = await client.get('tuning');
      if (!Array.isArray(raw?.versions)) throw strange('the settings');
      return { current: parseVersion(raw.current), versions: raw.versions.map(parseVersion) };
    },
    saveTuning: async (tuning) => parseVersion(await client.post('tuning', tuning)),
    /** @returns {Promise<Child[]>} */
    children: async () => {
      const raw = await client.get('children');
      if (!Array.isArray(raw?.children)) throw strange('the children');
      return raw.children;
    },
    /** @returns {Promise<Game[]>} newest first */
    games: async (userId) => {
      const raw = await client.get(`children/${id(userId)}/games`);
      if (!Array.isArray(raw?.games)) throw strange('the games');
      return raw.games;
    },
    /** @returns {Promise<{ turns: Turn[] }>} */
    game: async (userId, key) => {
      const raw = await client.get(`children/${id(userId)}/games/${id(key)}`);
      if (!Array.isArray(raw?.turns)) throw strange('a game');
      return raw;
    },
    /** The CSV as a Blob, fetched with the token, since a plain link could not carry it. */
    csv: async () => {
      const response = await client.request('summaries.csv');
      if (!response.ok) throw new Error('The CSV could not be made.');
      return response.blob();
    },
  };
}
