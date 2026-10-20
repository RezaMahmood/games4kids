export type Status = 'draft' | 'published';
export type Mode = 'trace' | 'traceThenCopy';
export type Level = 'starter' | 'explorer' | 'champion';
export type LetterStyle = 'print' | 'precursive' | 'joined';
export type Paper = 'baseline' | 'threeLine' | 'fourLine' | 'highlighted';
export type LineSize = 'small' | 'medium' | 'large';
export type ActivityType = 'letters' | 'words' | 'sentence' | 'paragraph';

export type Body =
	| { type: 'letters'; sequence: string[]; repeat: number }
	| { type: 'words'; category: string; words: string[] }
	| { type: 'sentence'; text: string }
	| { type: 'paragraph'; text: string };

export type Look = { letterStyle: LetterStyle; allowedStyles: LetterStyle[]; paper: Paper; lineSize: LineSize };

export type ActivityInput = Body & Look & { title: string; description: string; status: Status; timeLimitSec: number | null; mode: Mode; level: Level };

export type Activity = ActivityInput & { id: string; order: number; updatedAt: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

export const LIMITS = {
	title: 80,
	description: 200,
	category: 40,
	sequence: 26,
	tokenLength: 3,
	repeat: 20,
	tokens: 60,
	words: 30,
	wordLength: 30,
	sentence: 200,
	paragraph: 2000,
	minTimeSec: 5,
	maxTimeSec: 3600,
};
export const STATUSES: readonly Status[] = ['draft', 'published'];
export const MODES: readonly Mode[] = ['trace', 'traceThenCopy'];
export const LETTER_STYLES: readonly LetterStyle[] = ['print', 'precursive', 'joined'];
export const PAPERS: readonly Paper[] = ['baseline', 'threeLine', 'fourLine', 'highlighted'];
export const LINE_SIZES: readonly LineSize[] = ['small', 'medium', 'large'];
export const LEVELS: readonly Level[] = ['starter', 'explorer', 'champion'];
export const DEFAULT_LEVEL: Level = 'explorer';
export const DEFAULT_LOOK: Look = { letterStyle: 'print', allowedStyles: [...LETTER_STYLES], paper: 'fourLine', lineSize: 'medium' };

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const TOKEN = new RegExp(`^[\\p{L}\\p{N}]{1,${LIMITS.tokenLength}}$`, 'u');
const WORD = new RegExp(`^[\\p{L}\\p{N}'’-]{1,${LIMITS.wordLength}}$`, 'u');

type Json = Record<string, unknown>;

function text(raw: unknown, field: string, { max, required = true, lines = false }: { max: number; required?: boolean; lines?: boolean }, problems: string[]): string {
	if (raw === undefined && !required) return '';
	if (typeof raw !== 'string') {
		problems.push(`${field} must be text`);
		return '';
	}
	const value = raw.replace(/\r\n?/g, '\n').trim();
	if (required && value === '') problems.push(`${field} must not be empty`);
	else if (value.length > max) problems.push(`${field} must be at most ${max} characters`);
	else if (CONTROL.test(value) || (!lines && value.includes('\n'))) problems.push(`${field} must be ${lines ? 'plain text' : 'a single line of plain text'}`);
	return value;
}

function list(raw: unknown, field: string, { max, pattern, describe }: { max: number; pattern: RegExp; describe: string }, problems: string[]): string[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		problems.push(`${field} must be a non-empty list`);
		return [];
	}
	if (raw.length > max) problems.push(`${field} must have at most ${max} entries`);
	const bad = raw.filter((value) => typeof value !== 'string' || !pattern.test(value));
	if (bad.length) problems.push(`${field} entries must be ${describe} (bad: ${bad.slice(0, 3).map((value) => JSON.stringify(value)).join(', ')})`);
	return raw as string[];
}

function oneOf<T extends string>(raw: unknown, field: keyof Look & string, values: readonly T[], fallback: T, problems: string[]): T {
	if (raw === undefined) return fallback;
	if (!values.includes(raw as T)) problems.push(`${field} must be one of ${values.join(', ')}`);
	return raw as T;
}

function parseLook(raw: Json, problems: string[]): Look {
	const letterStyle = oneOf(raw['letterStyle'], 'letterStyle', LETTER_STYLES, DEFAULT_LOOK.letterStyle, problems);
	let allowedStyles = DEFAULT_LOOK.allowedStyles;
	if (raw['allowedStyles'] !== undefined) {
		const given = raw['allowedStyles'];
		if (!Array.isArray(given) || given.length === 0 || given.some((style) => !LETTER_STYLES.includes(style as LetterStyle))) {
			problems.push(`allowedStyles must be a non-empty list of ${LETTER_STYLES.join(', ')}`);
		} else {
			allowedStyles = LETTER_STYLES.filter((style) => given.includes(style));
		}
	}
	if (LETTER_STYLES.includes(letterStyle) && !allowedStyles.includes(letterStyle)) problems.push(`allowedStyles must include the default letterStyle (${letterStyle})`);
	return {
		letterStyle,
		allowedStyles: [...allowedStyles],
		paper: oneOf(raw['paper'], 'paper', PAPERS, DEFAULT_LOOK.paper, problems),
		lineSize: oneOf(raw['lineSize'], 'lineSize', LINE_SIZES, DEFAULT_LOOK.lineSize, problems),
	};
}

type TypeSpec<B extends Body> = { parse(raw: Json, problems: string[]): B; trace(body: B): string };

const TYPES: { [T in ActivityType]: TypeSpec<Extract<Body, { type: T }>> } = {
	letters: {
		parse(raw, problems) {
			const sequence = list(raw['sequence'], 'sequence', { max: LIMITS.sequence, pattern: TOKEN, describe: `1 to ${LIMITS.tokenLength} letters or digits` }, problems);
			const repeat = raw['repeat'];
			if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > LIMITS.repeat) problems.push(`repeat must be a whole number from 1 to ${LIMITS.repeat}`);
			else if (sequence.length * repeat > LIMITS.tokens) problems.push(`sequence times repeat must be at most ${LIMITS.tokens} letters`);
			return { type: 'letters', sequence, repeat: typeof repeat === 'number' ? repeat : 0 };
		},
		trace: (body) => Array.from({ length: body.repeat }, () => body.sequence).flat().join(' '),
	},
	words: {
		parse(raw, problems) {
			const category = text(raw['category'], 'category', { max: LIMITS.category }, problems);
			const words = list(raw['words'], 'words', { max: LIMITS.words, pattern: WORD, describe: 'single words of letters, digits, hyphens or apostrophes' }, problems);
			return { type: 'words', category, words };
		},
		trace: (body) => body.words.join(' '),
	},
	sentence: {
		parse: (raw, problems) => ({ type: 'sentence', text: text(raw['text'], 'text', { max: LIMITS.sentence }, problems) }),
		trace: (body) => body.text,
	},
	paragraph: {
		parse: (raw, problems) => ({ type: 'paragraph', text: text(raw['text'], 'text', { max: LIMITS.paragraph, lines: true }, problems) }),
		trace: (body) => body.text,
	},
};

export const ACTIVITY_TYPES = Object.keys(TYPES) as ActivityType[];

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function toTraceText(activity: Body): string {
	const spec = TYPES[activity.type] as TypeSpec<Body>;
	return spec.trace(activity);
}

export function parseActivityInput(raw: unknown): Parsed<ActivityInput> {
	if (!isRecord(raw)) return { ok: false, problems: ['activity must be an object'] };
	const type = raw['type'];
	if (typeof type !== 'string' || !Object.hasOwn(TYPES, type)) return { ok: false, problems: [`type must be one of ${ACTIVITY_TYPES.join(', ')}`] };
	const problems: string[] = [];
	const title = text(raw['title'], 'title', { max: LIMITS.title }, problems);
	const description = text(raw['description'], 'description', { max: LIMITS.description, required: false }, problems);
	const status = raw['status'];
	if (!STATUSES.includes(status as Status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
	const timeLimitSec = raw['timeLimitSec'] ?? null;
	if (timeLimitSec !== null && !(typeof timeLimitSec === 'number' && Number.isInteger(timeLimitSec) && timeLimitSec >= LIMITS.minTimeSec && timeLimitSec <= LIMITS.maxTimeSec)) {
		problems.push(`timeLimitSec must be null for no timer, or a whole number of seconds from ${LIMITS.minTimeSec} to ${LIMITS.maxTimeSec}`);
	}
	const mode = oneModeOrLevel(raw['mode'] ?? 'trace', 'mode', MODES, problems);
	const level = oneModeOrLevel(raw['level'] ?? DEFAULT_LEVEL, 'level', LEVELS, problems);
	const look = parseLook(raw, problems);
	const body = (TYPES[type as ActivityType] as TypeSpec<Body>).parse(raw, problems);
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { ...body, title, description, status: status as Status, timeLimitSec: timeLimitSec as number | null, mode, level, ...look } };
}

function oneModeOrLevel<T extends string>(raw: unknown, field: string, values: readonly T[], problems: string[]): T {
	if (!values.includes(raw as T)) problems.push(`${field} must be one of ${values.join(', ')}`);
	return raw as T;
}

export function parseActivity(raw: unknown): Parsed<Activity> {
	const input = parseActivityInput(raw);
	const problems = input.ok ? [] : [...input.problems];
	const fields = isRecord(raw) ? raw : {};
	const { id, order, updatedAt } = fields;
	if (typeof id !== 'string' || id === '') problems.push('id must be a non-empty string');
	if (typeof order !== 'number' || !Number.isInteger(order)) problems.push('order must be a whole number');
	if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) problems.push('updatedAt must be a timestamp');
	if (!input.ok || problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { ...input.value, id: id as string, order: order as number, updatedAt: updatedAt as string } };
}

export function compareActivities(a: Activity, b: Activity): number {
	return a.order - b.order || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}
