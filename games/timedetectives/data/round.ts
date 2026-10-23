import { CONFIDENCE, CONFIDENCES, isRecord, KINDS, offeredChoices, QUESTION_KINDS, text, type Confidence, type Parsed, type QuestionKind, type RoundContent } from './content.ts';
import type { PictureId, RoundId, TopicId } from './ids.ts';

export type Topic = { id: TopicId; title: string; guidance: string; order: number };

export type Source = 'ai' | 'human';

/** A form field the admin can fix, named as the admin page names its inputs. */
export type FieldRef = 'full' | 'brief' | `${QuestionKind}-answer` | `${QuestionKind}-hint` | `${QuestionKind}-decoy-${0 | 1 | 2}`;
export const FIELD_REFS: readonly FieldRef[] = [
	'full',
	'brief',
	...KINDS.flatMap((kind) => [`${kind}-answer`, `${kind}-hint`, `${kind}-decoy-0`, `${kind}-decoy-1`, `${kind}-decoy-2`] as const),
];
export const fieldRef = (raw: unknown): FieldRef | undefined => FIELD_REFS.find((field) => field === raw);

export function fieldText(content: RoundContent, field: FieldRef): string {
	if (field === 'full' || field === 'brief') return content[field];
	const [kind, part, index] = field.split('-') as [QuestionKind, 'answer' | 'hint' | 'decoy', string?];
	const question = content.questions.find((one) => one.kind === kind);
	if (!question) return '';
	return part === 'decoy' ? (question.decoys[Number(index)] ?? '') : question[part];
}

/**
 * What the automatic check thinks might spoil the quiz in one field. `problem` follows "seems to" when `sure`, and
 * "might" when not, as in "give the answer away".
 */
export type Finding = { field: FieldRef; problem: string; sure: boolean };
/** The check's findings, or `not-run` when it could not give a verdict. A round never checked has none. */
export type Checks = readonly Finding[] | 'not-run';

export function parseChecks(raw: unknown): Checks | undefined {
	if (raw === 'not-run') return raw;
	if (!Array.isArray(raw)) return undefined;
	const findings: Finding[] = [];
	for (const item of raw) {
		const field = isRecord(item) ? fieldRef(item['field']) : undefined;
		if (!field || typeof item['problem'] !== 'string' || typeof item['sure'] !== 'boolean') return undefined;
		findings.push({ field, problem: item['problem'], sure: item['sure'] });
	}
	return findings;
}

/** The findings that still apply after an edit: one whose field the admin changed is theirs to judge now. */
export function keptChecks(checks: Checks | undefined, before: RoundContent, after: RoundContent): Checks | undefined {
	if (checks === undefined || checks === 'not-run') return checks;
	const kept = checks.filter(({ field }) => fieldText(before, field) === fieldText(after, field));
	return kept.length > 0 ? kept : undefined;
}

/**
 * Where a round is in its life. The AI job lives here too, so there is no jobs table: `drafting` is queued for the
 * worker, and once it has content the words are written and only the picture is left to draw. The AI failing to
 * write the words leaves a `failed` round with nothing in it. The AI failing to draw a picture never loses the words
 * or the picture already there: the round is a `draft` again, with a `notice` that says why no new picture came, kept
 * until the admin acts. `checks` is the automatic check's view of the words. It stays through edits and redraws, and
 * publishing ends it. `revising` is queued like `drafting`: the AI rewrites the words to fix `findings`, the checks the
 * draft had, and the round goes back to a draft either way, with the old words and findings when the AI could not.
 */
export type RoundState =
	| { kind: 'drafting'; focus: string; source: Source; content?: RoundContent; checks?: Checks }
	| { kind: 'revising'; content: RoundContent; findings: readonly Finding[]; source: Source }
	| { kind: 'failed'; focus: string; source: Source; reason: string }
	| { kind: 'draft'; content: RoundContent; source: Source; notice?: string; checks?: Checks }
	| { kind: 'published'; content: RoundContent; source: Source; publishedAt: string };
/** A round the worker has queued, which counts toward the cap and is stale once its messages are over. */
export type AtWork = Extract<RoundState, { kind: 'drafting' | 'revising' }>;
export const atWork = (state: RoundState): state is AtWork => state.kind === 'drafting' || state.kind === 'revising';
/** A round whose words are written and that the AI is not working on: it can be edited, published or given a picture. */
export type Settled = Extract<RoundState, { kind: 'draft' | 'published' }>;

export type Round = {
	id: RoundId;
	topicId: TopicId;
	state: RoundState;
	/** The picture the round shows. Only a save that checks the row's etag points the row at a new one. */
	picture?: PictureId;
	/** What the AI asked the image model for. A round written by hand has none, and its picture prompt comes from the alt text. */
	picturePrompt?: string;
	updatedAt: string;
};

export type Published = Round & { state: Extract<RoundState, { kind: 'published' }> };
export const isPublished = (round: Round): round is Published => round.state.kind === 'published';

export const TOPIC_LIMITS = { title: 60, guidance: 600, focus: 120 };

export function parseTopicInput(raw: unknown): Parsed<{ title: string; guidance: string }> {
	const fields = isRecord(raw) ? raw : {};
	const problems: string[] = [];
	const title = text(fields['title'], 'title', { max: TOPIC_LIMITS.title }, problems);
	const guidance = text(fields['guidance'], 'guidance', { max: TOPIC_LIMITS.guidance, required: false, lines: true }, problems);
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { title, guidance } };
}

export function parseFocus(raw: unknown): Parsed<string> {
	const problems: string[] = [];
	const focus = text(isRecord(raw) ? raw['focus'] : undefined, 'focus', { max: TOPIC_LIMITS.focus, required: false }, problems);
	return problems.length > 0 ? { ok: false, problems } : { ok: true, value: focus };
}

export const parseConfidence = (raw: unknown): Confidence | undefined => CONFIDENCES.find((confidence) => confidence === raw);

export type QuestionView = { kind: QuestionKind; label: string; choices: string[]; answer: string; hint: string };
/** `version` comes back with the attempt, so a round that changed while the child played it is never marked against new words. */
export type RoundView = { id: RoundId; version: string; confidence: Confidence; paragraph: string; pictureAlt: string; questions: QuestionView[] };

/** What a child gets for one round. It carries the answers, so the page can mark each tap at once. */
export function roundView(round: Published, confidence: Confidence): RoundView {
	const { content } = round.state;
	return {
		id: round.id,
		version: round.updatedAt,
		confidence,
		paragraph: content[CONFIDENCE[confidence].paragraph],
		pictureAlt: content.pictureAlt,
		questions: content.questions.map((question) => ({
			kind: question.kind,
			label: QUESTION_KINDS[question.kind].label,
			choices: offeredChoices(question, confidence),
			answer: question.answer,
			hint: question.hint,
		})),
	};
}
