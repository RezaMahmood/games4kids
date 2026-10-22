import { CONFIDENCE, CONFIDENCES, isRecord, KINDS, offeredChoices, type Confidence, type Parsed, type QuestionKind, type RoundContent } from './content.ts';
import { isGuid } from './ids.ts';

export const POINTS = { firstTry: 10, secondTry: 5, hint: 3 };
const MAX_TRIES = 2;

/** One question as the child answered it: what they tapped, in order, and whether they opened the hint. */
export type AnswerLog = { kind: QuestionKind; tries: readonly string[]; hint: boolean };
export type AttemptInput = { attemptId: string; confidence: Confidence; answers: readonly AnswerLog[] };
export type Marked = { points: number; right: Record<QuestionKind, boolean> };

/** The page marks each try with the same rule for instant feedback; the server's mark is the one that counts. */
export function questionPoints({ tries, hint }: { tries: readonly string[]; hint: boolean }, answer: string): number {
	const base = tries[0] === answer ? POINTS.firstTry : tries[1] === answer ? POINTS.secondTry : 0;
	return Math.max(0, base - (hint ? POINTS.hint : 0));
}

export function parseAttemptInput(attemptId: unknown, body: unknown): Parsed<AttemptInput> {
	const fields = isRecord(body) ? body : {};
	const problems: string[] = [];
	if (!isGuid(attemptId)) problems.push('attemptId must be a GUID, made once per finished round');
	const confidence = fields['confidence'];
	if (!CONFIDENCES.includes(confidence as Confidence)) problems.push(`confidence must be one of ${CONFIDENCES.join(', ')}`);
	const raw = fields['answers'];
	const answers: AnswerLog[] = [];
	if (!Array.isArray(raw)) problems.push('answers must be a list');
	for (const entry of Array.isArray(raw) ? raw : []) {
		const kind = isRecord(entry) ? entry['kind'] : undefined;
		const tries = isRecord(entry) ? entry['tries'] : undefined;
		const hint = isRecord(entry) ? entry['hint'] : undefined;
		if (!KINDS.includes(kind as QuestionKind)) problems.push(`each answer needs a kind from ${KINDS.join(', ')}`);
		else if (answers.some((answer) => answer.kind === kind)) problems.push(`${kind} is answered twice`);
		else if (!Array.isArray(tries) || tries.length < 1 || tries.length > MAX_TRIES || !tries.every((t) => typeof t === 'string')) problems.push(`${kind} tries must be 1 or ${MAX_TRIES} choices`);
		else if (typeof hint !== 'boolean') problems.push(`${kind} hint must be true or false`);
		else answers.push({ kind: kind as QuestionKind, tries: tries as string[], hint });
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { attemptId: (attemptId as string).toLowerCase(), confidence: confidence as Confidence, answers } };
}

/**
 * Marks a whole round from the child's log. Every question needs an answer, every try must be a choice the child was
 * offered at their confidence, a right first try ends the question, and a wrong one needs a second try.
 */
export function scoreAttempt(content: RoundContent, input: AttemptInput): Parsed<Marked> {
	const problems: string[] = [];
	const right = {} as Record<QuestionKind, boolean>;
	let sum = 0;
	for (const question of content.questions) {
		const log = input.answers.find((answer) => answer.kind === question.kind);
		if (!log) {
			problems.push(`${question.kind} has no answer`);
			continue;
		}
		const offered = offeredChoices(question, input.confidence);
		const [first, second] = log.tries;
		if (!log.tries.every((choice) => offered.includes(choice))) problems.push(`${question.kind} tries must be choices the round offered`);
		else if (first === second) problems.push(`${question.kind} tries the same choice twice`);
		else if (first === question.answer && second !== undefined) problems.push(`${question.kind} was right first time, so it has no second try`);
		else if (first !== question.answer && second === undefined) problems.push(`${question.kind} was wrong first time, so it needs a second try`);
		right[question.kind] = log.tries.includes(question.answer);
		sum += questionPoints(log, question.answer);
	}
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, value: { points: Math.round(sum * CONFIDENCE[input.confidence].bonus), right } };
}
