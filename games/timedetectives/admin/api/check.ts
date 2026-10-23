import { judgeUse, type Meter } from '@g4k/sdk';
import type { Area } from './foundry.ts';
import { fieldText, isRecord, KINDS, QUESTION_KINDS, type FieldRef, type Finding, type QuestionKind, type RoundContent } from '../../data/index.ts';

/** A check at or above this chance of being bad is sent back to the writer. */
export const FAIL_AT = 0.7;
/** Between this and FAIL_AT the check is unsure, so the admin is told and the writer is not asked again. */
export const UNSURE_AT = 0.3;
/** The thresholds and question wording were measured on this version. Move it only after `npm run eval:jev` says the new one is no worse. */
export const MODEL = 'jev-1.14.0';
const TIMEOUT_MS = 60_000;
const DETAIL_MAX = 300;

export type TypeSafeDeps = {
	endpoint: string;
	apiKey: string;
	timeoutMs?: number;
	/** Hears every 2xx reply, billed whether or not its answers are usable: its tokens, or why it has none. */
	meter?: Meter<Area>;
};

/** The check could not give a verdict: the service was down, refused the key, or answered something unreadable. */
export class CheckFailure extends Error {}

export type Answer = { type: 'noul'; noul: number } | { type: 'choice'; probabilities: Record<string, number> };
/** One check: the field it reads, the question sent, how to read a "this is bad" probability out of its answer, and the problem in words that follow "seems to" or "might". */
export type Check = { id: string; field: FieldRef; question: object; bad: (answer: Answer) => number; problem: string };

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
		{ id: `${kind}_answer`, field: `${kind}-answer`, question: relation(claim(`${path}.answer`)), bad: (a) => 1 - supports(a), problem: 'be missing from the story' },
		...([0, 1, 2] as const).map((i): Check => ({
			id: `${kind}_decoy_${i + 1}`,
			field: `${kind}-decoy-${i}`,
			question: relation(claim(`${path}.decoys[${i}]`)),
			bad: supports,
			problem: 'be true in the story too, so it is not clearly wrong',
		})),
		{
			id: `${kind}_brief`,
			field: 'brief',
			question: { type: 'noul', instructions: `Does \`brief\` name or directly reveal \`${path}.answer\`, the answer to "${label}"?` },
			bad: gives,
			problem: `give away the answer to "${label}"`,
		},
		{
			id: `${kind}_hint`,
			field: `${kind}-hint`,
			question: { type: 'noul', instructions: `Does \`${path}.hint\` give away \`${path}.answer\`, the answer to "${label}"?`, criteria: HINT },
			bad: gives,
			problem: 'give the answer away',
		},
	];
}

export const checksFor = (content: RoundContent): Check[] => KINDS.flatMap((kind) => checksOfKind(kind, content));

/**
 * Reads each check's answer by its id, and gives a Finding for each check at or above UNSURE_AT, `sure` from FAIL_AT. A
 * missing or malformed answer is a failed check run, never a pass.
 */
export function judge(checks: Check[], answers: unknown): Finding[] {
	const findings: Finding[] = [];
	for (const check of checks) {
		const answer = isRecord(answers) ? parseAnswer(answers[check.id]) : undefined;
		if (!answer) throw new CheckFailure(`the reply had no usable answer for ${check.id}`);
		const bad = check.bad(answer);
		if (bad >= UNSURE_AT) findings.push({ field: check.field, problem: check.problem, sure: bad >= FAIL_AT });
	}
	return findings;
}

/** A finding in words the chat model can act on, naming the field as its JSON names it, and saying how sure the check was. */
export function forWriter({ field, problem, sure }: Finding, content: RoundContent): string {
	const claim = `${sure ? 'seems to' : 'might'} ${problem}`;
	if (field === 'full' || field === 'brief') return `the ${field} ${claim}`;
	const [kind, part] = field.split('-');
	return `the ${kind} ${part} "${fieldText(content, field)}" ${claim}`;
}

/** Asks Jev all the checks of a round in one request. */
export async function checkRound(deps: TypeSafeDeps, content: RoundContent): Promise<Finding[]> {
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
			body: JSON.stringify({ model: MODEL, state, questions }),
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
	await deps.meter?.(judgeUse('check', MODEL, reply));
	return judge(checks, isRecord(reply) ? reply['answers'] : undefined);
}
