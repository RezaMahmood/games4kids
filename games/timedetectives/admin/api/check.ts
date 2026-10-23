import { isRecord, KINDS, QUESTION_KINDS, type QuestionKind, type RoundContent } from '../../data/index.ts';

/** A check at or above this chance of being bad is sent back to the writer. */
export const FAIL_AT = 0.7;
/** Between this and FAIL_AT the check is unsure, so the admin is told and the writer is not asked again. */
export const UNSURE_AT = 0.3;
const TIMEOUT_MS = 60_000;
const DETAIL_MAX = 300;

export type TypeSafeDeps = { endpoint: string; apiKey: string; timeoutMs?: number };

/** The check could not give a verdict: the service was down, refused the key, or answered something unreadable. */
export class CheckFailure extends Error {}

export type Answer = { type: 'noul'; noul: number } | { type: 'choice'; probabilities: Record<string, number> };
/** One check: the question sent, how to read a "this is bad" probability out of its answer, and the words for the problem. */
export type Check = { id: string; question: object; bad: (answer: Answer) => number; problem: string };
export type Verdicts = { fails: string[]; unsure: string[] };

const RELATION = { supports: 'the story says it is true', contradicts: 'the story says it is false', says_nothing: 'the story does not mention it' };
/** Without these, Jev reads a hint that points at the story ("the story names the island") as giving the answer away. */
const HINT = {
	true: 'The hint contains the answer itself, or words that pin it down on their own, so a child could answer from the hint without the story.',
	false: 'The hint only says where in the story to look or what kind of thing to look for, such as "the story names the island", and the child must still read the story to find the answer.',
};
const probability =(value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1;

function parseAnswer(raw: unknown): Answer | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw['type'] === 'noul') return probability(raw['noul']) ? { type: 'noul', noul: raw['noul'] } : undefined;
	const probabilities = raw['probabilities'];
	if (raw['type'] !== 'choice' || !isRecord(probabilities) || !Object.values(probabilities).every(probability)) return undefined;
	return { type: 'choice', probabilities: probabilities as Record<string, number> };
}

const supports = (answer: Answer): number => {
	if (answer.type !== 'choice') throw new CheckFailure('a choice question was answered with a number');
	return answer.probabilities['supports'] ?? 0;
};
const gives = (answer: Answer): number => {
	if (answer.type !== 'noul') throw new CheckFailure('a yes or no question was answered with a choice');
	return answer.noul;
};

const relation = (about: string) => ({
	type: 'choice',
	instructions: `How does \`full\` relate to the claim that ${about}?`,
	criteria: RELATION,
});

function checksOfKind(kind: QuestionKind, content: RoundContent): Check[] {
	const question = content.questions.find((one) => one.kind === kind);
	if (!question) return [];
	const { label } = QUESTION_KINDS[kind];
	const path = `questions.${kind}`;
	const claim = (at: string) => `the answer to "${label}" is \`${at}\``;
	return [
		{ id: `${kind}_answer`, question: relation(claim(`${path}.answer`)), bad: (a) => 1 - supports(a), problem: `the story never says the ${kind} answer "${question.answer}"` },
		...question.decoys.map((decoy, i): Check => ({
			id: `${kind}_decoy_${i + 1}`,
			question: relation(claim(`${path}.decoys[${i}]`)),
			bad: supports,
			problem: `the story supports the ${kind} decoy "${decoy}", so it is not clearly wrong`,
		})),
		{
			id: `${kind}_brief`,
			question: { type: 'noul', instructions: `Does \`brief\` name or directly reveal \`${path}.answer\`, the answer to "${label}"?` },
			bad: gives,
			problem: `the brief gives away the ${kind} answer "${question.answer}"`,
		},
		{
			id: `${kind}_hint`,
			question: { type: 'noul', instructions: `Does \`${path}.hint\` give away \`${path}.answer\`, the answer to "${label}"?`, criteria: HINT },
			bad: gives,
			problem: `the ${kind} hint gives away the answer "${question.answer}"`,
		},
	];
}

export const checksFor = (content: RoundContent): Check[] => KINDS.flatMap((kind) => checksOfKind(kind, content));

/** Reads each check's answer by its id. A missing or malformed answer is a failed check run, never a pass. */
export function judge(checks: Check[], answers: unknown): Verdicts {
	const verdicts: Verdicts = { fails: [], unsure: [] };
	for (const check of checks) {
		const answer = isRecord(answers) ? parseAnswer(answers[check.id]) : undefined;
		if (!answer) throw new CheckFailure(`the reply had no usable answer for ${check.id}`);
		const bad = check.bad(answer);
		if (bad >= FAIL_AT) verdicts.fails.push(check.problem);
		else if (bad >= UNSURE_AT) verdicts.unsure.push(check.problem);
	}
	return verdicts;
}

/** Asks Jev all the checks of a round in one request. */
export async function checkRound(deps: TypeSafeDeps, content: RoundContent): Promise<Verdicts> {
	const checks = checksFor(content);
	const state = {
		full: content.full,
		brief: content.brief,
		questions: Object.fromEntries(content.questions.map(({ kind, answer, decoys, hint }) => [kind, { answer, decoys, hint }])),
	};
	const questions = Object.fromEntries(checks.map(({ id, question }) => [id, question]));
	let text: string;
	let status: number;
	try {
		const res = await fetch(new URL('v1/systemone', deps.endpoint), {
			method: 'POST',
			headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'jev-latest', state, questions }),
			signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
		});
		status = res.status;
		text = await res.text();
	} catch (error) {
		throw new CheckFailure(`${(error as Error).name}: ${(error as Error).message}`);
	}
	if (status < 200 || status >= 300) throw new CheckFailure(`${status}: ${text}`.slice(0, DETAIL_MAX));
	let reply: unknown;
	try {
		reply = JSON.parse(text);
	} catch {
		throw new CheckFailure('the reply was not JSON');
	}
	return judge(checks, isRecord(reply) ? reply['answers'] : undefined);
}
