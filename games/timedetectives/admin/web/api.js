/**
 * @typedef {{ id: string, title: string, guidance: string, order: number, etag: string, rounds: number, published: number }} Topic
 * @typedef {{ kind: string, answer: string, decoys: string[], hint: string }} Question
 * @typedef {{ title: string, full: string, brief: string, pictureAlt: string, questions: Question[] }} Content
 * @typedef {{ kind: 'drafting', focus: string, source: string, content?: Content }
 *   | { kind: 'failed', focus: string, source: string, reason: string, content?: Content }
 *   | { kind: 'draft', content: Content, source: string }
 *   | { kind: 'published', content: Content, source: string, publishedAt: string }} RoundState
 * @typedef {{ id: string, topicId: string, state: RoundState, hasPicture: boolean, updatedAt: string, etag: string }} Round
 */

const STATES = ['drafting', 'failed', 'draft', 'published'];

/** @returns {Round} */
function parseRound(raw) {
  if (typeof raw?.id !== 'string' || !STATES.includes(raw.state?.kind) || typeof raw.hasPicture !== 'boolean') throw new Error('The server sent a round this page does not understand.');
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
    /** @returns {Promise<Round[]>} newest change first */
    rounds: async (topicId) => (await client.get(`topics/${id(topicId)}/rounds`)).rounds.map(parseRound),
    draft: async (topicId, focus) => parseRound(await client.post(`topics/${id(topicId)}/rounds/draft`, { focus })),
    write: async (topicId, content) => parseRound(await client.post(`topics/${id(topicId)}/rounds`, { content })),
    round: async (roundId) => parseRound(await client.get(`rounds/${id(roundId)}`)),
    edit: async (roundId, content, etag) => parseRound(await client.put(`rounds/${id(roundId)}`, { content, etag })),
    publish: async (roundId) => parseRound(await client.post(`rounds/${id(roundId)}/publish`, {})),
    unpublish: async (roundId) => parseRound(await client.post(`rounds/${id(roundId)}/unpublish`, {})),
    redraw: async (roundId) => parseRound(await client.post(`rounds/${id(roundId)}/redraw`, {})),
    retry: async (roundId) => parseRound(await client.post(`rounds/${id(roundId)}/retry`, {})),
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
