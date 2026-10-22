/**
 * @typedef {{ id: string, title: string, guidance: string, order: number, etag: string, rounds: number, published: number }} Topic
 * @typedef {{ kind: string, answer: string, decoys: string[], hint: string }} Question
 * @typedef {{ title: string, full: string, brief: string, pictureAlt: string, questions: Question[] }} Content
 * @typedef {{ kind: 'drafting', focus: string, source: string, content?: Content }
 *   | { kind: 'failed', focus: string, source: string, reason: string, content?: Content }
 *   | { kind: 'draft', content: Content, source: string }
 *   | { kind: 'published', content: Content, source: string, publishedAt: string }} RoundState
 * @typedef {{ id: string, topicId: string, state: RoundState, hasPicture: boolean, updatedAt: string, etag: string, broken?: undefined }} Round
 * @typedef {{ id: string, topicId: string, broken: string[] }} Broken A stored round the server can no longer read; it can only be deleted.
 */

const STATES = ['drafting', 'failed', 'draft', 'published'];

/** @returns {Round | Broken} */
function parseRound(raw) {
  const broken = Array.isArray(raw?.broken) && raw.broken.every((problem) => typeof problem === 'string');
  if (typeof raw?.id !== 'string' || (!broken && (!STATES.includes(raw.state?.kind) || typeof raw.hasPicture !== 'boolean'))) throw new Error('The server sent a round this page does not understand.');
  return raw;
}

/**
 * This game's admin API over the shell's client, which signs every call and reads the one error shape.
 * @param {import('/shell/v1/index.js').ApiClient} client
 */
export function createApi(client) {
  const id = encodeURIComponent;
  return {
    /** @returns {Promise<Topic[]>} */
    topics: async () => (await client.get('topics')).topics,
    createTopic: (topic) => client.post('topics', topic),
    updateTopic: (topicId, topic) => client.put(`topics/${id(topicId)}`, topic),
    deleteTopic: (topicId) => client.delete(`topics/${id(topicId)}`),
    /** @returns {Promise<(Round | Broken)[]>} damaged rows first, then newest change first */
    rounds: async (topicId) => (await client.get(`topics/${id(topicId)}/rounds`)).rounds.map(parseRound),
    draft: async (topicId, focus) => parseRound(await client.post(`topics/${id(topicId)}/rounds/draft`, { focus })),
    write: async (topicId, content) => parseRound(await client.post(`topics/${id(topicId)}/rounds`, { content })),
    round: async (roundId) => parseRound(await client.get(`rounds/${id(roundId)}`)),
    edit: async (roundId, content, etag) => parseRound(await client.put(`rounds/${id(roundId)}`, { content, etag })),
    /** Publishes the round only while it is still as the page loaded it, at `etag`. */
    publish: async (roundId, etag) => parseRound(await client.post(`rounds/${id(roundId)}/publish`, { etag })),
    unpublish: async (roundId) => parseRound(await client.post(`rounds/${id(roundId)}/unpublish`, {})),
    redraw: async (roundId) => parseRound(await client.post(`rounds/${id(roundId)}/redraw`, {})),
    /** Asks the AI again, about `focus`, or about whatever it chooses when that is empty. */
    retry: async (roundId, focus) => parseRound(await client.post(`rounds/${id(roundId)}/retry`, { focus })),
    /** @param {File} file a PNG or a JPEG */
    upload: async (roundId, file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = `rounds/${id(roundId)}/picture`;
      return parseRound(await (file.type === 'image/png' ? client.sendPng(`${path}/png`, bytes) : client.sendJpeg(`${path}/jpeg`, bytes)));
    },
    picture: (roundId) => client.objectUrl(`rounds/${id(roundId)}/picture`),
    remove: (roundId) => client.delete(`rounds/${id(roundId)}`),
  };
}
