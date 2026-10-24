import type { ReadTable, StorageFor, Stored } from '@g4k/sdk';
import type manifest from '../manifest.ts';
import type { BoardEntry, DailyBest } from './board.ts';
import type { GameLog, LoggedTurn } from './log.ts';
import { invertedTime } from './parse.ts';
import type { Replayed, Summary, TurnMark } from './replay.ts';
import { DEFAULT_TUNING, DEFAULT_TUNING_ID, parseTuning, type Tuning } from './tuning.ts';

type ColourMatch = typeof manifest;

const TUNING = 'tuning';
const BOARD = 'board';
const dayPartition = (userId: string) => `day-${userId}`;

export type TuningVersion = { id: string; savedAt: string; tuning: Tuning };
/** What a child is told about a saved game: the server's numbers, never the page's. */
export type SavedGame = { gameId: string; score: number; roundsReached: number; correct: number; turns: number };
/** A game's summary row as the admin lists it. `key` finds its blob again. */
export type GameRecord = Summary & { key: string; gameId: string; userId: string; savedAt: string };
/** The blob: the whole log with the server's mark on every turn, written once. */
export type StoredGame = Omit<GameLog, 'turns'> & { userId: string; savedAt: string; turns: readonly (LoggedTurn & TurnMark)[] };

type TuningRow = { partitionKey: string; rowKey: string; tuning: string; savedAt: string };
type GameRow = { partitionKey: string; rowKey: string; gameId: string; savedAt: string } & Omit<Summary, 'medianCongruentMs' | 'medianIncongruentMs'> & { medianCongruentMs?: number; medianIncongruentMs?: number };
type BoardRow = { partitionKey: string; rowKey: string; name: string; timeZone: string; since: string };
type DailyBestRow = { partitionKey: string; rowKey: string; points: number; gameId: string; at: string };

/** Newest first, so the first row in the partition is the current tuning. */
const tuningKey = (savedAt: Date, id: string) => `${invertedTime(savedAt.getTime())}-${id}`;
/** Newest start first. The start time comes from the log, so a repeat of the same game makes the same key. */
export const gameKey = (log: GameLog) => `${invertedTime(Date.parse(log.startedAt))}-${log.gameId}`;
const blobPath = (userId: string, log: GameLog) => `${userId}/${log.startedAt.slice(0, 7)}/${log.gameId}.json`;

/** A row saved under bounds a later version tightened no longer reads, and is skipped rather than played. */
function readTuning(row: Stored<TuningRow>): TuningVersion | undefined {
	let json: unknown = null;
	try {
		json = JSON.parse(row.tuning);
	} catch {
		// Stays null, which parseTuning refuses.
	}
	const parsed = parseTuning(json);
	return parsed.ok ? { id: row.rowKey, savedAt: row.savedAt, tuning: parsed.value } : undefined;
}

async function tuningsOf(table: ReadTable): Promise<TuningVersion[]> {
	return (await table.inPartition<TuningRow>(TUNING)).flatMap((row) => readTuning(row) ?? []);
}

const toRecord = (row: Stored<GameRow>): GameRecord => {
	const { partitionKey, rowKey, etag: _etag, medianCongruentMs, medianIncongruentMs, ...rest } = row;
	return { ...rest, key: rowKey, userId: partitionKey, medianCongruentMs: medianCongruentMs ?? null, medianIncongruentMs: medianIncongruentMs ?? null };
};

const toSaved = ({ gameId, score, roundsReached, correct, turns }: GameRow): SavedGame => ({ gameId, score, roundsReached, correct, turns });

const toBoardEntry = ({ rowKey, name, timeZone, since }: BoardRow): BoardEntry => ({ userId: rowKey, name, timeZone, since });

export type PlayStore = {
	/** The newest saved tuning, or the defaults under `default` while no row exists. */
	currentTuning(): Promise<TuningVersion>;
	tuning(id: string): Promise<Tuning | undefined>;
	savedGame(userId: string, key: string): Promise<SavedGame | undefined>;
	/** Writes the blob, then the row, so a row always has its blob. A game already saved keeps what was saved first. */
	saveGame(userId: string, log: GameLog, replayed: Replayed, savedAt: Date): Promise<SavedGame>;
	/** Raises the child's best for the day when `points` beats it, and answers the best after. */
	recordDailyBest(userId: string, day: string, best: { points: number; gameId: string; at: string }): Promise<number>;
	dailyBests(userId: string, days: readonly string[]): Promise<DailyBest[]>;
	boardEntries(): Promise<BoardEntry[]>;
	/** A child already on the board keeps their first `since`, so a repeat changes nothing. */
	optIn(entry: BoardEntry): Promise<void>;
	optOut(userId: string): Promise<void>;
	/** The child's board entry with their current name and time zone, or undefined while they are not on the board. */
	refreshBoardEntry(userId: string, name: string, timeZone: string): Promise<BoardEntry | undefined>;
};

export function playStore(storage: StorageFor<ColourMatch, 'play'>): PlayStore {
	const { tuning, games, board } = storage.tables;
	const blobs = storage.blobs.games;

	return {
		async currentTuning() {
			return (await tuningsOf(tuning))[0] ?? { id: DEFAULT_TUNING_ID, savedAt: '', tuning: DEFAULT_TUNING };
		},
		async tuning(id) {
			if (id === DEFAULT_TUNING_ID) return DEFAULT_TUNING;
			const row = await tuning.get<TuningRow>(TUNING, id);
			return row && readTuning(row)?.tuning;
		},
		async savedGame(userId, key) {
			const row = await games.get<GameRow>(userId, key);
			return row && toSaved(row);
		},
		async saveGame(userId, log, { marks, summary }, savedAt) {
			const stored: StoredGame = { ...log, userId, savedAt: savedAt.toISOString(), turns: log.turns.map((turn, i) => ({ ...turn, ...(marks[i] ?? { correct: false, points: 0, congruent: turn.word === turn.ink }) })) };
			await blobs.put(blobPath(userId, log), new TextEncoder().encode(JSON.stringify(stored)), 'application/json');
			const { medianCongruentMs, medianIncongruentMs, ...rest } = summary;
			const row: GameRow = {
				partitionKey: userId,
				rowKey: gameKey(log),
				gameId: log.gameId,
				savedAt: stored.savedAt,
				...rest,
				...(medianCongruentMs !== null && { medianCongruentMs }),
				...(medianIncongruentMs !== null && { medianIncongruentMs }),
			};
			if (await games.insertIfAbsent(row)) return toSaved(row);
			const first = await games.get<GameRow>(userId, row.rowKey);
			if (!first) throw new Error(`game ${log.gameId} was there and then gone`);
			return toSaved(first);
		},
		async recordDailyBest(userId, day, best) {
			const partition = dayPartition(userId);
			for (let attempt = 0; attempt < 3; attempt++) {
				const row = await board.get<DailyBestRow>(partition, day);
				if (!row) {
					if (await board.insertIfAbsent({ partitionKey: partition, rowKey: day, ...best } satisfies DailyBestRow)) return best.points;
					continue;
				}
				if (row.points >= best.points) return row.points;
				if (await board.replaceIfMatch({ partitionKey: partition, rowKey: day, ...best } satisfies DailyBestRow, row.etag)) return best.points;
			}
			throw new Error(`the daily best for ${day} kept changing`);
		},
		async dailyBests(userId, days) {
			const rows = await Promise.all(days.map((day) => board.get<DailyBestRow>(dayPartition(userId), day)));
			return rows.flatMap((row) => (row ? [{ day: row.rowKey, points: row.points, at: row.at }] : []));
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
	/** Newest first. */
	tunings(): Promise<TuningVersion[]>;
	/** A new row every time. Nothing overwrites a tuning a game may have been played under. */
	saveTuning(tuning: Tuning, savedAt: Date, id: string): Promise<TuningVersion>;
	gamesOf(userId: string): Promise<GameRecord[]>;
	allGames(): Promise<GameRecord[]>;
	game(record: GameRecord): Promise<StoredGame | undefined>;
};

export function adminStore(storage: StorageFor<ColourMatch, 'admin'>): AdminStore {
	const { tuning, games } = storage.tables;
	const blobs = storage.blobs.games;

	return {
		tunings: () => tuningsOf(tuning),
		async saveTuning(next, savedAt, id) {
			const row: TuningRow = { partitionKey: TUNING, rowKey: tuningKey(savedAt, id), tuning: JSON.stringify(next), savedAt: savedAt.toISOString() };
			await tuning.put(row);
			return { id: row.rowKey, savedAt: row.savedAt, tuning: next };
		},
		gamesOf: async (userId) => (await games.inPartition<GameRow>(userId)).map(toRecord),
		allGames: async () => (await games.list<GameRow>()).map(toRecord),
		async game(record) {
			const blob = await blobs.get(`${record.userId}/${record.startedAt.slice(0, 7)}/${record.gameId}.json`);
			if (!blob || blob === 'not-modified') return undefined;
			return JSON.parse(new TextDecoder().decode(blob.bytes)) as StoredGame;
		},
	};
}
