import { CONFIDENCE, CONFIDENCES, isRecord, offeredChoices, QUESTION_KINDS, text, type Confidence, type Parsed, type QuestionKind, type RoundContent } from './content.ts';
import type { RoundId, TopicId } from './ids.ts';

export type Topic = { id: TopicId; title: string; guidance: string; order: number };

export type Source = 'ai' | 'human';

/**
 * Where a round is in its life. The AI job lives here too, so there is no jobs table: `drafting` is queued for the
 * worker, and once it has content the words are written and only the picture is left to draw. The AI failing to
 * write the words leaves a `failed` round with nothing in it. The AI failing to draw a picture never loses the words
 * or the picture already there: the round is a `draft` again, with a `notice` that says why no new picture came.
 */
export type RoundState =
	| { kind: 'drafting'; focus: string; source: Source; content?: RoundContent }
	| { kind: 'failed'; focus: string; source: Source; reason: string }
	| { kind: 'draft'; content: RoundContent; source: Source; notice?: string }
	| { kind: 'published'; content: RoundContent; source: Source; publishedAt: string };
/** A round whose words are written and that the AI is not working on: it can be edited, published or given a picture. */
export type Settled = Extract<RoundState, { kind: 'draft' | 'published' }>;

export type Round = {
	id: RoundId;
	topicId: TopicId;
	state: RoundState;
	hasPicture: boolean;
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
export type RoundView = { id: RoundId; confidence: Confidence; paragraph: string; pictureAlt: string; questions: QuestionView[] };

/** What a child gets for one round. It carries the answers, so the page can mark each tap at once. */
export function roundView(round: Published, confidence: Confidence): RoundView {
	const { content } = round.state;
	return {
		id: round.id,
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
