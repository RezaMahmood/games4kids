import { LEVELS, parseActivity } from './activity.js';

/**
 * @typedef {import('./activity.js').Activity} Activity
 * @typedef {import('./progress.js').Attempt} Attempt
 * @typedef {Activity & { etag: string }} ListedActivity
 * @typedef {{ userId: string, name: string }} Child
 * @typedef {{ id: string, userId: string, userName: string, activityId: string, activityTitle: string, bytes: number, createdAt: string,
 *   reviewed: boolean, reviewedBy?: string, reviewedAt?: string, note: string }} Submission
 * @typedef {{ userId?: string, activityId?: string, unreviewed?: boolean, after?: string, limit?: number }} SubmissionFilter
 * @typedef {{ dailyPracticeMinutes: number, hardModeDefault: boolean }} Settings
 * @typedef {{ days: string[], goalMinutes: number, children: { userId: string, name: string, seconds: number[], totalSeconds: number }[] }} PracticeReport
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

/** @returns {PracticeReport} */
function parsePracticeReport(raw) {
  const days = raw?.days;
  const good = Array.isArray(days) && days.every((d) => typeof d === 'string') && Number.isInteger(raw.goalMinutes)
    && Array.isArray(raw.children)
    && raw.children.every((c) => typeof c.userId === 'string' && typeof c.name === 'string' && Array.isArray(c.seconds) && c.seconds.length === days.length && c.seconds.every(Number.isFinite) && Number.isFinite(c.totalSeconds));
  if (!good) throw new ApiError(502, 'The server sent a practice report this app does not understand.');
  return raw;
}

/** @returns {ListedActivity} */
function parseListed(raw) {
  const parsed = parseActivity(raw);
  if (!parsed.ok) throw new ApiError(502, `The server sent an activity this app does not understand: ${parsed.problems.join('; ')}`);
  return { ...parsed.value, etag: typeof raw.etag === 'string' ? raw.etag : '' };
}

/**
 * This game's admin API over the shell's client, which signs every call and reads the one error shape.
 * @param {import('/shell/v1/index.js').ApiClient} client
 */
export function createApi(client) {
  const list = (data) => data.activities.map(parseListed);
  const id = encodeURIComponent;

  return {
    /** The players granted this game, by the name each chose. @returns {Promise<Child[]>} */
    children: async () => (await client.get('children')).children,
    /** Every activity, drafts included. @returns {Promise<ListedActivity[]>} */
    activities: async () => list(await client.get('activities')),
    createActivity: async (input) => parseListed(await client.post('activities', input)),
    updateActivity: async (activityId, input, etag) => parseListed(await client.put(`activities/${id(activityId)}`, { ...input, etag })),
    deleteActivity: (activityId) => client.delete(`activities/${id(activityId)}`),
    orderActivities: async (ids) => list(await client.put('activities/order', { ids })),
    /** One child's own attempts for the last 120 days, oldest first. @returns {Promise<Attempt[]>} */
    childProgress: async (userId) => parseAttempts(await client.get(`progress/${id(userId)}`)),
    /** @returns {Promise<Settings>} */
    settings: () => client.get('settings'),
    saveSettings: (settings) => client.put('settings', settings),
    /** @returns {Promise<PracticeReport>} the last seven days for every child, ending at `day` */
    practiceReport: async (day) => parsePracticeReport(await client.get('practice', { day })),
    /** @param {SubmissionFilter} filter @returns {Promise<{ submissions: Submission[], next: string | null }>} */
    submissions: (filter = {}) => client.get('submissions', Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => [k, String(v)]))),
    /** @returns {Promise<Blob>} */
    submissionImage: async (submissionId) => {
      const response = await client.request(`submissions/${id(submissionId)}/image`);
      if (!response.ok) throw new ApiError(response.status, 'That copy could not be loaded.');
      return response.blob();
    },
    /** @returns {Promise<Submission>} */
    reviewSubmission: (submissionId, review) => client.patch(`submissions/${id(submissionId)}`, review),
    /** Hides the copy from the review list. Its image stays with the player app. */
    discardSubmission: (submissionId) => client.delete(`submissions/${id(submissionId)}`),
  };
}
