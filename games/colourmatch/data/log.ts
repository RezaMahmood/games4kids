import { GUID, isRecord, type Parsed } from './parse.ts';
import { isColourId, type ColourId } from './palette.ts';
import { isMode, type Mode, type Squares } from './turn.ts';
import { TUNING_ID } from './tuning.ts';

export type EndReason = 'mistakes' | 'clock' | 'left';
export const END_REASONS = ['mistakes', 'clock', 'left'] as const satisfies readonly EndReason[];
export type PointerType = 'touch' | 'mouse' | 'pen';
const POINTERS = ['touch', 'mouse', 'pen'] as const satisfies readonly PointerType[];
const ORIENTATIONS = ['portrait', 'landscape'] as const;

export type Device = {
	readonly pointer: PointerType;
	readonly width: number;
	readonly height: number;
	readonly dpr: number;
	readonly orientation: (typeof ORIENTATIONS)[number];
	readonly userAgent: string;
};

/** The tap on a square. `x` and `y` are where inside the square, 0 to 1 from its top left. */
export type Answer = { readonly tapped: number; readonly answerMs: number; readonly x: number; readonly y: number; readonly pointer: PointerType };

/** One word as the child saw it. `answer` is null when the round clock ran out while it was on screen. */
export type LoggedTurn = {
	readonly round: number;
	readonly turn: number;
	readonly word: ColourId;
	readonly ink: ColourId;
	readonly squares: Squares;
	readonly answer: Answer | null;
	/** Offset from the game's start. */
	readonly shownAtMs: number;
	/** What was left of the round clock when the turn ended. */
	readonly clockLeftMs: number;
};

export type GameLog = {
	readonly gameId: string;
	readonly mode: Mode;
	readonly tuningId: string;
	readonly startedAt: string;
	readonly endReason: EndReason;
	readonly device: Device;
	readonly hiddenMs: number;
	readonly turns: readonly LoggedTurn[];
};

/** A child cannot play more words than this in one game, so a log is bounded and fits the JSON cap with room to spare. */
export const MAX_TURNS = 2000;
export const MAX_USER_AGENT = 300;

/** The 15 slots of a packed turn, in order. The page packs them the same way (play/web/rules.js). */
export type PackedTurn = readonly [number, number, string, string, string, string, string, string, number | null, number, number | null, number | null, number | null, string | null, number];

export const packTurn = ({ round, turn, word, ink, squares, answer, shownAtMs, clockLeftMs }: LoggedTurn): PackedTurn => [
	round, turn, word, ink, squares[0], squares[1], squares[2], squares[3],
	answer?.tapped ?? null, shownAtMs, answer?.answerMs ?? null, answer?.x ?? null, answer?.y ?? null, answer?.pointer ?? null, clockLeftMs,
];

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isUnit = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1;
const isPointer = (value: unknown): value is PointerType => POINTERS.some((pointer) => pointer === value);

function parseTurn(raw: unknown, index: number): Parsed<LoggedTurn> {
	const at = `turns[${index}]`;
	if (!Array.isArray(raw) || raw.length !== 15) return { ok: false, problems: [`${at} must be a list of 15 values`] };
	const [round, turn, word, ink, s0, s1, s2, s3, tapped, shownAtMs, answerMs, x, y, pointer, clockLeftMs] = raw as unknown[];
	const problems: string[] = [];
	if (!isCount(round) || round < 1) problems.push(`${at} round must be a whole number from 1`);
	if (!isCount(turn)) problems.push(`${at} turn must be a whole number from 0`);
	const squares = [s0, s1, s2, s3];
	if (!isColourId(word) || !isColourId(ink) || !squares.every(isColourId)) problems.push(`${at} colours must be from the palette`);
	if (!isCount(shownAtMs)) problems.push(`${at} shownAtMs must be a whole number of ms`);
	if (!isCount(clockLeftMs)) problems.push(`${at} clockLeftMs must be a whole number of ms`);
	const timedOut = tapped === null;
	let answer: Answer | null = null;
	if (timedOut) {
		if (answerMs !== null || x !== null || y !== null || pointer !== null) problems.push(`${at} a word the clock ran out on has no answer`);
	} else if (!isCount(tapped) || tapped > 3 || !isCount(answerMs) || !isUnit(x) || !isUnit(y) || !isPointer(pointer)) {
		problems.push(`${at} answer must be a square 0 to 3, ms, a tap position 0 to 1 and a pointer type`);
	} else answer = { tapped, answerMs, x, y, pointer };
	if (problems.length > 0 || !isColourId(word) || !isColourId(ink) || !isCount(round) || !isCount(turn) || !isCount(shownAtMs) || !isCount(clockLeftMs)) return { ok: false, problems };
	const [a, b, c, d] = squares;
	if (!isColourId(a) || !isColourId(b) || !isColourId(c) || !isColourId(d)) return { ok: false, problems: [`${at} colours must be from the palette`] };
	return { ok: true, value: { round, turn, word, ink, squares: [a, b, c, d], answer, shownAtMs, clockLeftMs } };
}

function parseDevice(raw: unknown): Parsed<Device> {
	if (!isRecord(raw)) return { ok: false, problems: ['device must be an object'] };
	const { pointer, width, height, dpr, orientation, userAgent } = raw;
	const problems: string[] = [];
	if (!isPointer(pointer)) problems.push('device.pointer must be touch, mouse or pen');
	if (!isCount(width) || !isCount(height)) problems.push('device.width and height must be whole numbers');
	if (typeof dpr !== 'number' || !(dpr > 0 && dpr <= 10)) problems.push('device.dpr must be a number from 0 to 10');
	if (!ORIENTATIONS.some((o) => o === orientation)) problems.push('device.orientation must be portrait or landscape');
	if (typeof userAgent !== 'string' || userAgent.length > MAX_USER_AGENT) problems.push(`device.userAgent must be text up to ${MAX_USER_AGENT} characters`);
	if (problems.length > 0 || !isPointer(pointer) || !isCount(width) || !isCount(height) || typeof dpr !== 'number' || typeof userAgent !== 'string') return { ok: false, problems };
	const found = ORIENTATIONS.find((o) => o === orientation);
	if (!found) return { ok: false, problems };
	return { ok: true, value: { pointer, width, height, dpr, orientation: found, userAgent } };
}

/** The log as the page sends it, with each turn packed as a list. The game id comes from the route. */
export function parseGameLog(gameId: string | undefined, raw: unknown, now: Date): Parsed<GameLog> {
	const problems: string[] = [];
	if (gameId === undefined || !GUID.test(gameId)) problems.push('gameId must be a GUID');
	if (!isRecord(raw)) return { ok: false, problems: [...problems, 'the log must be an object'] };
	const { mode, tuningId, startedAt, endReason, device, hiddenMs, turns } = raw;
	if (!isMode(mode)) problems.push('mode must be normal or hard');
	if (typeof tuningId !== 'string' || !TUNING_ID.test(tuningId)) problems.push('tuningId must name a tuning');
	const started = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
	if (Number.isNaN(started) || Math.abs(started - now.getTime()) > 24 * 60 * 60 * 1000) problems.push('startedAt must be an ISO time within a day of now');
	if (!END_REASONS.some((reason) => reason === endReason)) problems.push('endReason must be mistakes, clock or left');
	if (!isCount(hiddenMs)) problems.push('hiddenMs must be a whole number of ms');
	const parsedDevice = parseDevice(device);
	if (!parsedDevice.ok) problems.push(...parsedDevice.problems);
	if (!Array.isArray(turns) || turns.length === 0 || turns.length > MAX_TURNS) problems.push(`turns must be a list of 1 to ${MAX_TURNS} turns`);
	const parsedTurns: LoggedTurn[] = [];
	if (Array.isArray(turns)) {
		for (const [index, turn] of turns.slice(0, MAX_TURNS).entries()) {
			const parsed = parseTurn(turn, index);
			if (parsed.ok) parsedTurns.push(parsed.value);
			else problems.push(...parsed.problems);
		}
	}
	const reason = END_REASONS.find((candidate) => candidate === endReason);
	if (problems.length > 0 || gameId === undefined || !isMode(mode) || typeof tuningId !== 'string' || typeof startedAt !== 'string' || !reason || !parsedDevice.ok || !isCount(hiddenMs)) return { ok: false, problems };
	return { ok: true, value: { gameId, mode, tuningId, startedAt: new Date(started).toISOString(), endReason: reason, device: parsedDevice.value, hiddenMs, turns: parsedTurns } };
}
