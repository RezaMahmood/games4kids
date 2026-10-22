import type { Blob, ReadTable, StorageFor, Stored } from '@g4k/sdk';
import type manifest from '../manifest.ts';
import type { BoardEntry, Played } from './board.ts';
import { parseRoundContent, type Confidence, type RoundContent } from './content.ts';
import type { RoundId, TopicId } from './ids.ts';
import type { Round, RoundState, Source, Topic } from './round.ts';
import type { AnswerLog } from './score.ts';

type TimeDetectives = typeof manifest;

export type ImageRead = Blob | 'not-modified' | undefined;
export type StoredTopic = { topic: Topic; etag: string };
export type StoredRound = { round: Round; etag: string };
export type Attempt = Played & { id: string; topicId: TopicId; confidence: Confidence; answers: readonly AnswerLog[] };

const TOPIC = 'topic';
/** One partition: every round route carries only the round's id, and a point read needs the partition. */
const ROUND = 'round';
const BOARD = 'board';

type TopicRow = { partitionKey: string; rowKey: string; title: string; guidance: string; order: number };
/** Table fields are scalars, so the content travels as JSON text and comes back through parseRoundContent. */
type RoundRow = {
	partitionKey: string;
	rowKey: string;
	topicId: string;
	state: RoundState['kind'];
	source: Source;
	focus?: string;
	reason?: string;
	content?: string;
	publishedAt?: string;
	hasPicture: boolean;
	picturePrompt?: string;
	updatedAt: string;
};
type AttemptRow = { partitionKey: string; rowKey: string; roundId: string; topicId: string; confidence: Confidence; points: number; completedAt: string; answers: string };
type BoardRow = { partitionKey: string; rowKey: string; name: string; timeZone: string; since: string };

const toTopic = ({ rowKey, title, guidance, order }: TopicRow): Topic => ({ id: rowKey as TopicId, title, guidance, order });
const topicRow = ({ id, title, guidance, order }: Topic): TopicRow => ({ partitionKey: TOPIC, rowKey: id, title, guidance, order });
const byOrder = (a: Topic, b: Topic) => a.order - b.order || a.title.localeCompare(b.title);

function storedContent(row: RoundRow): RoundContent | undefined {
	if (row.content === undefined) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(row.content);
	} catch {
		raw = null;
	}
	const parsed = parseRoundContent(raw);
	if (!parsed.ok) throw new Error(`stored round ${row.rowKey} is invalid: ${parsed.problems.join('; ')}`);
	return parsed.value;
}

function toState(row: RoundRow): RoundState {
	const content = storedContent(row);
	const kept = content ? { content } : {};
	const missing = (field: string) => new Error(`stored round ${row.rowKey} is ${row.state} with no ${field}`);
	switch (row.state) {
		case 'drafting':
			return { kind: 'drafting', focus: row.focus ?? '', source: row.source, ...kept };
		case 'failed':
			return { kind: 'failed', focus: row.focus ?? '', source: row.source, reason: row.reason ?? '', ...kept };
		case 'draft':
			if (!content) throw missing('content');
			return { kind: 'draft', content, source: row.source };
		case 'published':
			if (!content || !row.publishedAt) throw missing('content or publish time');
			return { kind: 'published', content, source: row.source, publishedAt: row.publishedAt };
	}
}

function toRound(row: RoundRow): Round {
	const { rowKey, topicId, hasPicture, picturePrompt, updatedAt } = row;
	return { id: rowKey as RoundId, topicId: topicId as TopicId, state: toState(row), hasPicture, ...(picturePrompt !== undefined && { picturePrompt }), updatedAt };
}

function roundRow({ id, topicId, state, hasPicture, picturePrompt, updatedAt }: Round): RoundRow {
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
		...content,
		...(state.kind === 'published' && { publishedAt: state.publishedAt }),
		hasPicture,
		...(picturePrompt !== undefined && { picturePrompt }),
		updatedAt,
	};
}

const toStoredRound = (row: Stored<RoundRow>): StoredRound => ({ round: toRound(row), etag: row.etag });

const toPlayed = ({ roundId, points, completedAt }: AttemptRow): Played => ({ roundId, points, completedAt });

const toBoardEntry = ({ rowKey, name, timeZone, since }: BoardRow): BoardEntry => ({ userId: rowKey, name, timeZone, since });

async function topicsOf(table: ReadTable): Promise<StoredTopic[]> {
	return (await table.inPartition<TopicRow>(TOPIC)).map((row) => ({ topic: toTopic(row), etag: row.etag })).sort((a, b) => byOrder(a.topic, b.topic));
}

async function roundsOf(table: ReadTable): Promise<StoredRound[]> {
	return (await table.inPartition<RoundRow>(ROUND)).map(toStoredRound);
}

async function roundIn(table: ReadTable, id: RoundId): Promise<StoredRound | undefined> {
	const row = await table.get<RoundRow>(ROUND, id);
	return row && toStoredRound(row);
}

export type PlayStore = {
	topics(): Promise<Topic[]>;
	rounds(): Promise<Round[]>;
	round(id: RoundId): Promise<Round | undefined>;
	picture(id: RoundId, ifNoneMatch: string | undefined): Promise<ImageRead>;
	played(userId: string): Promise<Played[]>;
	/** Saves a finished round once per attemptId. A repeat changes nothing and answers with what was saved first. */
	saveAttempt(userId: string, attempt: Attempt): Promise<Played>;
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
		rounds: async () => (await roundsOf(rounds)).map(({ round }) => round),
		round: async (id) => (await roundIn(rounds, id))?.round,
		picture: (id, ifNoneMatch) => storage.blobs.pictures.get(id, ifNoneMatch),
		played: async (userId) => (await attempts.inPartition<AttemptRow>(userId)).map(toPlayed),
		async saveAttempt(userId, attempt) {
			const { id, roundId, topicId, confidence, points, completedAt, answers } = attempt;
			const row: AttemptRow = { partitionKey: userId, rowKey: id, roundId, topicId, confidence, points, completedAt, answers: JSON.stringify(answers) };
			if (await attempts.insertIfAbsent(row)) return toPlayed(row);
			const first = await attempts.get<AttemptRow>(userId, id);
			if (!first) throw new Error(`attempt ${id} was there and then gone`);
			return toPlayed(first);
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
	rounds(): Promise<StoredRound[]>;
	round(id: RoundId): Promise<StoredRound | undefined>;
	createRound(round: Round): Promise<StoredRound>;
	/** Undefined when the round changed or went since `etag` was read. */
	replaceRound(round: Round, etag: string): Promise<StoredRound | undefined>;
	/** The row and its picture. */
	deleteRound(id: RoundId): Promise<void>;
	picture(id: RoundId, ifNoneMatch: string | undefined): Promise<ImageRead>;
	putPicture(id: RoundId, bytes: Uint8Array, contentType: string): Promise<void>;
};

export function adminStore(storage: StorageFor<TimeDetectives, 'admin'>): AdminStore {
	const { topics, rounds } = storage.tables;
	const pictures = storage.blobs.pictures;

	async function saved<T>(read: Promise<T | undefined>, what: string): Promise<T> {
		const found = await read;
		if (!found) throw new Error(`${what} was saved and then gone`);
		return found;
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
			return saved(roundIn(rounds, next.id), `round ${next.id}`);
		},
		async replaceRound(next, etag) {
			return (await rounds.replaceIfMatch(roundRow(next), etag)) ? saved(roundIn(rounds, next.id), `round ${next.id}`) : undefined;
		},
		async deleteRound(id) {
			await rounds.remove(ROUND, id);
			await pictures.remove(id);
		},
		picture: (id, ifNoneMatch) => pictures.get(id, ifNoneMatch),
		putPicture: (id, bytes, contentType) => pictures.put(id, bytes, contentType),
	};
}
