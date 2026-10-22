export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** One entry per question a round asks, in the order the child sees them. A new kind is one more entry here. */
export const QUESTION_KINDS = {
	who: { label: 'Who is it?' },
	where: { label: 'Where is it?' },
	when: { label: 'When was it?' },
} as const;
export type QuestionKind = keyof typeof QUESTION_KINDS;
export const KINDS = Object.keys(QUESTION_KINDS) as QuestionKind[];

/** How sure the child says they are decides which paragraph they read, how many answers they choose from, and the bonus. */
export const CONFIDENCE = {
	lots: { label: 'Yes, I know a lot about this subject', paragraph: 'brief', choices: 4, bonus: 1.5 },
	bit: { label: 'I know a bit about the subject', paragraph: 'full', choices: 4, bonus: 1.2 },
	easy: { label: 'No, please go easy on me', paragraph: 'full', choices: 3, bonus: 1 },
} as const;
export type Confidence = keyof typeof CONFIDENCE;
export const CONFIDENCES = Object.keys(CONFIDENCE) as Confidence[];

export type Question = { kind: QuestionKind; answer: string; decoys: readonly [string, string, string]; hint: string };

export type RoundContent = {
	/** Only admins see it, for example "Tutankhamun's tomb". */
	title: string;
	/** A short story with every answer woven in, never listed. */
	full: string;
	/** Sets the scene and gives none of the answers away. */
	brief: string;
	pictureAlt: string;
	/** One per kind, in the order of QUESTION_KINDS. */
	questions: readonly Question[];
};

export const LIMITS = { title: 80, full: 1600, brief: 900, pictureAlt: 250, answer: 60, hint: 200 };

/** Any control character but a line break. */
const CONTROL = /[^\P{Cc}\n]/u;

export type Json = Record<string, unknown>;
export const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function text(raw: unknown, field: string, { max, required = true, lines = false }: { max: number; required?: boolean; lines?: boolean }, problems: string[]): string {
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

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function parseQuestion(raw: Json, kind: QuestionKind, problems: string[]): Question {
	const answer = text(raw['answer'], `${kind} answer`, { max: LIMITS.answer }, problems);
	const given = raw['decoys'];
	if (!Array.isArray(given) || given.length !== 3) problems.push(`${kind} decoys must be a list of 3`);
	const [a = '', b = '', c = ''] = (Array.isArray(given) ? given : []).map((decoy, i) => text(decoy, `${kind} decoy ${i + 1}`, { max: LIMITS.answer }, problems));
	const decoys = [a, b, c] as const;
	const choices = [answer, ...decoys].filter((choice) => choice !== '');
	if (choices.some((choice, i) => choices.findIndex((other) => same(other, choice)) !== i)) problems.push(`${kind} answer and decoys must all be different`);
	const hint = text(raw['hint'], `${kind} hint`, { max: LIMITS.hint }, problems);
	return { kind, answer, decoys, hint };
}

/** Never throws: an admin's edit, a stored row and the model's reply all come through here. */
export function parseRoundContent(raw: unknown): Parsed<RoundContent> {
	if (!isRecord(raw)) return { ok: false, problems: ['content must be an object'] };
	const problems: string[] = [];
	const title = text(raw['title'], 'title', { max: LIMITS.title }, problems);
	const full = text(raw['full'], 'full', { max: LIMITS.full, lines: true }, problems);
	const brief = text(raw['brief'], 'brief', { max: LIMITS.brief, lines: true }, problems);
	const pictureAlt = text(raw['pictureAlt'], 'pictureAlt', { max: LIMITS.pictureAlt }, problems);
	const given = Array.isArray(raw['questions']) ? raw['questions'].filter(isRecord) : [];
	if (!Array.isArray(raw['questions']) || given.length !== raw['questions'].length) problems.push('questions must be a list of objects');
	const unknown = given.map((q) => q['kind']).filter((kind) => !KINDS.includes(kind as QuestionKind));
	if (unknown.length) problems.push(`questions has unknown kinds: ${unknown.map((kind) => JSON.stringify(kind)).join(', ')}`);
	const questions = KINDS.flatMap((kind) => {
		const [only, ...more] = given.filter((q) => q['kind'] === kind);
		if (!only || more.length > 0) {
			problems.push(`questions must have exactly one ${kind} question`);
			return [];
		}
		return [parseQuestion(only, kind, problems)];
	});
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { title, full, brief, pictureAlt, questions } };
}

/** The answers a child picks from: the answer and as many decoys as their confidence allows. The page shuffles them. */
export const offeredChoices = (question: Question, confidence: Confidence): string[] => [question.answer, ...question.decoys.slice(0, CONFIDENCE[confidence].choices - 1)];
