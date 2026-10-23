import type { Blob, ReadTable, Row, StorageFor, Stored } from '@g4k/sdk';
import type manifest from '../manifest.ts';
import type { BoardEntry, Played } from './board.ts';
import { isRecord, KINDS, parseRoundContent, type Confidence, type QuestionKind, type RoundContent } from './content.ts';
import { pictureId, roundId, topicId, type PictureId, type RoundId, type TopicId } from './ids.ts';
import { parseChecks, type Checks, type Round, type RoundState, type Source, type Topic } from './round.ts';
import type { AnswerLog } from './score.ts';

type TimeDetectives = typeof manifest;

export type ImageRead = Blob | 'not-modified' | undefined;
export type StoredTopic = { topic: Topic; etag: string };
export type StoredRound = { round: Round; etag: string };
/** A stored round row that no longer parses. It keeps the raw keys, so the admin can still see it and delete it. */
export type BrokenRound = { broken: true; id: string; topicId: string; problems: readonly string[] };
export type RoundRows = { rounds: StoredRound[]; broken: BrokenRound[] };
/** Which questions the child got right, as marked when the attempt was first saved. */
export type Marks = Partial<Record<QuestionKind, boolean>>;
export type Attempt = Played & { id: string; topicId: TopicId; confidence: Confidence; answers: readonly AnswerLog[]; right: Marks };

const TOPIC = 'topic';
/** One partition: every round route carries only the round's id, and a point read needs the partition. */
const ROUND = 'round';
const BOARD = 'board';

/** Every picture of a round is stored under the round's id, so deleting the round finds the ones a failed removal left. */
const picturePath = (round: RoundId, picture: PictureId) => `${round}/${picture}`;

type TopicRow = { partitionKey: string; rowKey: string; title: string; guidance: string; order: number };
/** Table fields are scalars, so the content travels as JSON text. readRound parses every field on the way back. */
type RoundRow = {
	partitionKey: string;
	rowKey: string;
	topicId: string;
	state: RoundState['kind'];
	source: Source;
	focus?: string;
	reason?: string;
	notice?: string;
	checks?: string;
	content?: string;
	publishedAt?: string;
	picture?: string;
	picturePrompt?: string;
	updatedAt: string;
};
type AttemptRow = { partitionKey: string; rowKey: string; roundId: string; topicId: string; confidence: Confidence; points: number; completedAt: string; answers: string; right: string };
type BoardRow = { partitionKey: string; rowKey: string; name: string; timeZone: string; since: string };

const toTopic = ({ rowKey, title, guidance, order }: TopicRow): Topic => ({ id: rowKey as TopicId, title, guidance, order });
const topicRow = ({ id, title, guidance, order }: Topic): TopicRow => ({ partitionKey: TOPIC, rowKey: id, title, guidance, order });
const byOrder = (a: Topic, b: Topic) => a.order - b.order || a.title.localeCompare(b.title);

const STATES = ['drafting', 'failed', 'draft', 'published'] as const satisfies readonly RoundState['kind'][];
const SOURCES = ['ai', 'human'] as const satisfies readonly Source[];

function optionalText(row: Row, field: string, problems: string[]): string | undefined {
	const value = row[field];
	if (value === undefined || typeof value === 'string') return value;
	problems.push(`${field} must be text`);
	return undefined;
}

function storedContent(row: Row, problems: string[]): RoundContent | undefined {
	const raw = row['content'];
	if (raw === undefined) return undefined;
	let json: unknown = null;
	try {
		if (typeof raw === 'string') json = JSON.parse(raw);
	} catch {
		// Stays null, which parseRoundContent turns into a problem.
	}
	const parsed = parseRoundContent(json);
	if (parsed.ok) return parsed.value;
	problems.push(...parsed.problems.map((problem) => `content: ${problem}`));
	return undefined;
}

function storedChecks(row: Row, problems: string[]): { checks?: Checks } {
	const raw = row['checks'];
	if (raw === undefined) return {};
	let json: unknown = null;
	try {
		if (typeof raw === 'string') json = JSON.parse(raw);
	} catch {
		// Stays null, which parseChecks refuses.
	}
	const checks = parseChecks(json);
	if (!checks) problems.push('checks must be a list of findings or "not-run"');
	return checks ? { checks } : {};
}

function storedState(row: Row, problems: string[]): RoundState | undefined {
	const kind = STATES.find((state) => state === row['state']);
	const source = SOURCES.find((one) => one === row['source']);
	const content = storedContent(row, problems);
	const focus = optionalText(row, 'focus', problems) ?? '';
	const kept = content ? { content } : {};
	if (!source) problems.push('source must be ai or human');
	if (!kind) {
		problems.push(`state ${JSON.stringify(row['state'])} is not one a round can be in`);
		return undefined;
	}
	if (!source) return undefined;
	switch (kind) {
		case 'drafting':
			return { kind, focus, source, ...kept, ...storedChecks(row, problems) };
		case 'failed':
			return { kind, focus, source, reason: optionalText(row, 'reason', problems) ?? '' };
		case 'draft': {
			const notice = optionalText(row, 'notice', problems);
			const checks = storedChecks(row, problems);
			if (content) return { kind, content, source, ...(notice && { notice }), ...checks };
			problems.push('a draft needs content');
			return undefined;
		}
		case 'published': {
			const publishedAt = optionalText(row, 'publishedAt', problems);
			if (content && publishedAt) return { kind, content, source, publishedAt };
			problems.push('a published round needs content and a publish time');
			return undefined;
		}
		default: {
			const unhandled: never = kind;
			return unhandled;
		}
	}
}

/** Every field of a stored row is checked here, so one row a later version cannot read is set aside instead of breaking every list. */
function readRound(row: Stored<Row>): StoredRound | BrokenRound {
	const problems: string[] = [];
	const id = roundId(row.rowKey);
	const topic = topicId(row['topicId']);
	const { updatedAt } = row;
	if (!id) problems.push('rowKey must be a round id');
	if (!topic) problems.push('topicId must be a topic id');
	if (typeof updatedAt !== 'string') problems.push('updatedAt must be text');
	const storedPicture = optionalText(row, 'picture', problems);
	const picture = pictureId(storedPicture);
	if (storedPicture !== undefined && !picture) problems.push('picture must be a picture id');
	const picturePrompt = optionalText(row, 'picturePrompt', problems);
	const state = storedState(row, problems);
	if (!id || !topic || typeof updatedAt !== 'string' || !state || problems.length > 0) {
		return { broken: true, id: row.rowKey, topicId: typeof row['topicId'] === 'string' ? row['topicId'] : '', problems };
	}
	return { round: { id, topicId: topic, state, ...(picture && { picture }), ...(picturePrompt !== undefined && { picturePrompt }), updatedAt }, etag: row.etag };
}

function roundRow({ id, topicId, state, picture, picturePrompt, updatedAt }: Round): RoundRow {
	const content = 'content' in state && state.content ? { content: JSON.stringify(state.content) } : {};
	const job = state.kind === 'drafting' || state.kind === 'failed' ? { focus: state.focus } : {};
	return {
		partitionKey: ROUND,
		rowKey: id,
		topicId,
		state: state.kind,
		source: state.source,
		...job,
		...(state.kind === 'failed' && { reason: state.reason }),
		...(state.kind === 'draft' && state.notice && { notice: state.notice }),
		...((state.kind === 'draft' || state.kind === 'drafting') && state.checks && { checks: JSON.stringify(state.checks) }),
		...content,
		...(state.kind === 'published' && { publishedAt: state.publishedAt }),
		...(picture && { picture }),
		...(picturePrompt !== undefined && { picturePrompt }),
		updatedAt,
	};
}

const toPlayed = ({ roundId, points, completedAt }: AttemptRow): Played => ({ roundId, points, completedAt });

function storedMarks({ rowKey, right }: AttemptRow): Marks {
	let raw: unknown = null;
	try {
		raw = JSON.parse(right);
	} catch {
		// Stays null and fails below.
	}
	const marks: Marks = {};
	for (const kind of KINDS) {
		const mark = isRecord(raw) ? raw[kind] : undefined;
		if (typeof mark !== 'boolean') throw new Error(`stored attempt ${rowKey} has no mark for ${kind}`);
		marks[kind] = mark;
	}
	return marks;
}

const toBoardEntry = ({ rowKey, name, timeZone, since }: BoardRow): BoardEntry => ({ userId: rowKey, name, timeZone, since });

async function topicsOf(table: ReadTable): Promise<StoredTopic[]> {
	return (await table.inPartition<TopicRow>(TOPIC)).map((row) => ({ topic: toTopic(row), etag: row.etag })).sort((a, b) => byOrder(a.topic, b.topic));
}

async function roundsOf(table: ReadTable): Promise<RoundRows> {
	const rows: RoundRows = { rounds: [], broken: [] };
	for (const read of (await table.inPartition(ROUND)).map(readRound)) {
		if ('broken' in read) rows.broken.push(read);
		else rows.rounds.push(read);
	}
	return rows;
}

async function roundIn(table: ReadTable, id: RoundId): Promise<StoredRound | BrokenRound | undefined> {
	const row = await table.get(ROUND, id);
	return row && readRound(row);
}

export type PlayStore = {
	topics(): Promise<Topic[]>;
	/** The rounds, and the rows that no longer parse, which the caller logs and skips. */
	rounds(): Promise<{ rounds: Round[]; broken: BrokenRound[] }>;
	round(id: RoundId): Promise<Round | BrokenRound | undefined>;
	picture(round: RoundId, picture: PictureId, ifNoneMatch: string | undefined): Promise<ImageRead>;
	played(userId: string): Promise<Played[]>;
	/** Saves a finished round once per attemptId. A repeat changes nothing and answers with what was saved first. */
	saveAttempt(userId: string, attempt: Attempt): Promise<Played & { right: Marks }>;
	savedAttempt(userId: string, id: string): Promise<(Played & { right: Marks }) | undefined>;
	boardEntries(): Promise<BoardEntry[]>;
	/** A child already on the board keeps their first `since`, so a repeat changes nothing. */
	optIn(entry: BoardEntry): Promise<void>;
	optOut(userId: string): Promise<void>;
	/** The child's board entry with their current name and time zone, or undefined while they are not on the board. */
	refreshBoardEntry(userId: string, name: string, timeZone: string): Promise<BoardEntry | undefined>;
};

export function playStore(storage: StorageFor<TimeDetectives, 'play'>): PlayStore {
	const { topics, rounds, attempts, board } = storage.tables;

	return {
		topics: async () => (await topicsOf(topics)).map(({ topic }) => topic),
		async rounds() {
			const rows = await roundsOf(rounds);
			return { rounds: rows.rounds.map(({ round }) => round), broken: rows.broken };
		},
		async round(id) {
			const read = await roundIn(rounds, id);
			return read && 'broken' in read ? read : read?.round;
		},
		picture: (round, picture, ifNoneMatch) => storage.blobs.pictures.get(picturePath(round, picture), ifNoneMatch),
		played: async (userId) => (await attempts.inPartition<AttemptRow>(userId)).map(toPlayed),
		async saveAttempt(userId, attempt) {
			const { id, roundId, topicId, confidence, points, completedAt, answers, right } = attempt;
			const row: AttemptRow = { partitionKey: userId, rowKey: id, roundId, topicId, confidence, points, completedAt, answers: JSON.stringify(answers), right: JSON.stringify(right) };
			if (await attempts.insertIfAbsent(row)) return { ...toPlayed(row), right };
			const first = await attempts.get<AttemptRow>(userId, id);
			if (!first) throw new Error(`attempt ${id} was there and then gone`);
			return { ...toPlayed(first), right: storedMarks(first) };
		},
		async savedAttempt(userId, id) {
			const row = await attempts.get<AttemptRow>(userId, id);
			return row && { ...toPlayed(row), right: storedMarks(row) };
		},
		boardEntries: async () => (await board.inPartition<BoardRow>(BOARD)).map(toBoardEntry),
		async optIn({ userId, name, timeZone, since }) {
			await board.insertIfAbsent({ partitionKey: BOARD, rowKey: userId, name, timeZone, since } satisfies BoardRow);
		},
		optOut: (userId) => board.remove(BOARD, userId),
		async refreshBoardEntry(userId, name, timeZone) {
			const row = await board.get<BoardRow>(BOARD, userId);
			if (!row) return undefined;
			if (row.name === name && row.timeZone === timeZone) return toBoardEntry(row);
			const next: BoardRow = { partitionKey: BOARD, rowKey: userId, name, timeZone, since: row.since };
			// A lost race means the child just opted out or changed again, so this call keeps what it read and the next one catches up.
			return (await board.replaceIfMatch(next, row.etag)) ? toBoardEntry(next) : toBoardEntry(row);
		},
	};
}

export type AdminStore = {
	topics(): Promise<StoredTopic[]>;
	topic(id: TopicId): Promise<StoredTopic | undefined>;
	createTopic(topic: Topic): Promise<StoredTopic>;
	/** Undefined when the topic changed or went since `etag` was read. */
	replaceTopic(topic: Topic, etag: string): Promise<StoredTopic | undefined>;
	deleteTopic(id: TopicId): Promise<void>;
	rounds(): Promise<RoundRows>;
	round(id: RoundId): Promise<StoredRound | BrokenRound | undefined>;
	createRound(round: Round): Promise<StoredRound>;
	/** Undefined when the round changed or went since `etag` was read. */
	replaceRound(round: Round, etag: string): Promise<StoredRound | undefined>;
	/**
	 * Saves `next` showing a new picture, only while the round still has `etag`. The bytes go under a new name first, so a
	 * save that loses leaves the picture the row names alone. The picture that lost is removed after: the new one when the
	 * save lost, else the one `next` showed before.
	 */
	replaceWithPicture(next: Round, etag: string, picture: { id: PictureId; bytes: Uint8Array; contentType: string }): Promise<StoredRound | undefined>;
	/** The row and every picture it had. */
	deleteRound(id: RoundId): Promise<void>;
	picture(round: RoundId, picture: PictureId, ifNoneMatch: string | undefined): Promise<ImageRead>;
};

export function adminStore(storage: StorageFor<TimeDetectives, 'admin'>): AdminStore {
	const { topics, rounds } = storage.tables;
	const pictures = storage.blobs.pictures;

	async function saved<T>(read: Promise<T | undefined>, what: string): Promise<T> {
		const found = await read;
		if (!found) throw new Error(`${what} was saved and then gone`);
		return found;
	}

	async function savedRound(id: RoundId): Promise<StoredRound> {
		const read = await saved(roundIn(rounds, id), `round ${id}`);
		if ('broken' in read) throw new Error(`round ${id} was saved and reads back broken: ${read.problems.join('; ')}`);
		return read;
	}

	async function replaceRound(next: Round, etag: string): Promise<StoredRound | undefined> {
		return (await rounds.replaceIfMatch(roundRow(next), etag)) ? savedRound(next.id) : undefined;
	}

	async function topic(id: TopicId): Promise<StoredTopic | undefined> {
		const row = await topics.get<TopicRow>(TOPIC, id);
		return row && { topic: toTopic(row), etag: row.etag };
	}

	return {
		topics: () => topicsOf(topics),
		topic,
		async createTopic(next) {
			await topics.put(topicRow(next));
			return saved(topic(next.id), `topic ${next.id}`);
		},
		async replaceTopic(next, etag) {
			return (await topics.replaceIfMatch(topicRow(next), etag)) ? saved(topic(next.id), `topic ${next.id}`) : undefined;
		},
		deleteTopic: (id) => topics.remove(TOPIC, id),
		rounds: () => roundsOf(rounds),
		round: (id) => roundIn(rounds, id),
		async createRound(next) {
			await rounds.put(roundRow(next));
			return savedRound(next.id);
		},
		replaceRound,
		async replaceWithPicture(next, etag, { id, bytes, contentType }) {
			await pictures.put(picturePath(next.id, id), bytes, contentType);
			const saved = await replaceRound({ ...next, picture: id }, etag);
			const lost = saved ? next.picture : id;
			if (lost) await pictures.remove(picturePath(next.id, lost));
			return saved;
		},
		async deleteRound(id) {
			await rounds.remove(ROUND, id);
			for (const path of await pictures.list(`${id}/`)) await pictures.remove(path);
		},
		picture: (round, picture, ifNoneMatch) => pictures.get(picturePath(round, picture), ifNoneMatch),
	};
}
