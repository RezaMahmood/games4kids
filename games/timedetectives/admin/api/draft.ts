import { isRecord, KINDS, parseRoundContent, type RoundContent } from '../../data/index.ts';
import { checkRound, type TypeSafeDeps, type Verdicts } from './check.ts';
import { AiFailure, chatJson, generateImage, type FoundryDeps } from './foundry.ts';

export const CHAT_DEPLOYMENT = 'gpt-5.4-mini';
export const IMAGE_DEPLOYMENT = 'gpt-image-1-mini';
/** The first answer, then one more after pointing out what was wrong with it. */
const ASKS = 2;

const SYSTEM = `You write one round of a history game for children in UK Year 5 and Year 6 (ages 9 to 11), studying KS2 history. Answer only with the requested JSON.
A round is a short story about one moment in the past. The child reads it, looks at a picture of it, then answers three questions: who is it, where is it, and when was it.
Write in plain British English. Keep every sentence under 20 words. Be historically accurate and use mainstream textbook facts; when unsure, choose a well-known example. Keep it child-safe, with no gore.
- title: a short name for the round, for the teacher, such as "Tutankhamun's tomb".
- full: 110 to 170 words. A small story that contains the who, where and when answers, each mentioned naturally once or twice. Never list them, and never give all three in the first sentence.
- brief: 50 to 80 words. Set the scene and the mood, but mention none of the three answers and nothing that gives them away directly.
- questions: exactly one with kind "who", one "where" and one "when".
  - answer: short, 1 to 5 words.
  - decoys: exactly 3 wrong answers of the same type as the answer, plausible but clearly wrong to someone who read the full story. No trick answers, and none that overlaps the answer.
  - Write dates the way KS2 does, such as "about 3000 BC" or "AD 793". Space the "when" decoys far enough apart that the answer is never in doubt.
  - hint: points back to the story without giving the answer, such as "Look for the river the story mentions."
- picturePrompt: a painterly illustration of the scene for an image model. No text or lettering in the image, no modern objects, no recognisable real faces.
- pictureAlt: one sentence describing the picture.`;

const QUESTION = {
	type: 'object',
	additionalProperties: false,
	required: ['kind', 'answer', 'decoys', 'hint'],
	properties: { kind: { type: 'string', enum: KINDS }, answer: { type: 'string' }, decoys: { type: 'array', items: { type: 'string' } }, hint: { type: 'string' } },
};

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['title', 'full', 'brief', 'pictureAlt', 'picturePrompt', 'questions'],
	properties: {
		title: { type: 'string' },
		full: { type: 'string' },
		brief: { type: 'string' },
		pictureAlt: { type: 'string' },
		picturePrompt: { type: 'string' },
		questions: { type: 'array', items: QUESTION },
	},
};

/** Every picture gets these rules, so one drawn from a hand-written round's alt text is as safe as one the AI described. */
const PICTURE_RULES = 'A painterly illustration for a children\'s history book. No text, letters or numbers anywhere in the image, no modern objects, no recognisable real faces.';

/** `notice` is what the admin should know before publishing: a check that failed or was unsure, or could not run. */
export type Written = { content: RoundContent; picturePrompt: string; notice?: string };

export const CHECK_DOWN = 'The automatic check could not run, so read this round carefully before publishing.';

/** The admin's words go in as quoted data, so they shape the round without becoming instructions. */
function ask(topic: { title: string; guidance: string }, focus: string): string {
	return [
		`Topic: ${JSON.stringify(topic.title)}`,
		topic.guidance && `Guidance from the teacher: ${JSON.stringify(topic.guidance)}`,
		focus ? `Write the round about: ${JSON.stringify(focus)}` : 'Choose a well-known moment from this topic.',
	].filter(Boolean).join('\n');
}

/**
 * Asks the chat model for a round, and once more with the problems when its answer does not parse or TypeSafe's check
 * fails it. A check never fails the round: what is still wrong on the last ask, or unsure, or could not be checked,
 * becomes a notice. `onCheckError` hears why a check could not run.
 */
export async function writeRound(
	deps: FoundryDeps,
	topic: { title: string; guidance: string },
	focus: string,
	typesafe?: TypeSafeDeps,
	onCheckError: (error: unknown) => void = () => {},
): Promise<Written> {
	const messages: unknown[] = [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: ask(topic, focus) },
	];
	for (let asked = 1; ; asked++) {
		const answer = await chatJson(deps, { model: CHAT_DEPLOYMENT, messages, name: 'round', schema: SCHEMA });
		const parsed = parseRoundContent(answer);
		const picturePrompt = isRecord(answer) && typeof answer['picturePrompt'] === 'string' ? answer['picturePrompt'].trim() : '';
		const problems = [...(parsed.ok ? [] : parsed.problems), ...(picturePrompt ? [] : ['picturePrompt must not be empty'])];
		if (parsed.ok && problems.length === 0) {
			const verdicts = typesafe ? await checked(typesafe, parsed.value, onCheckError) : CLEAN;
			if (verdicts && verdicts.fails.length > 0 && asked < ASKS) problems.push(...verdicts.fails);
			else return { content: parsed.value, picturePrompt, ...noticeFor(verdicts) };
		}
		if (asked === ASKS) throw new AiFailure(false, `The AI's round was not usable: ${problems.slice(0, 3).join('; ')}`);
		messages.push({ role: 'assistant', content: JSON.stringify(answer) }, { role: 'user', content: `That round has problems: ${problems.join('; ')}. Write it again, fixing them.` });
	}
}

const CLEAN: Verdicts = { fails: [], unsure: [] };

/** The verdicts, or null when the check could not run. */
async function checked(typesafe: TypeSafeDeps, content: RoundContent, onError: (error: unknown) => void): Promise<Verdicts | null> {
	try {
		return await checkRound(typesafe, content);
	} catch (error) {
		onError(error);
		return null;
	}
}

function noticeFor(verdicts: Verdicts | null): { notice?: string } {
	if (!verdicts) return { notice: CHECK_DOWN };
	const items = [...verdicts.fails, ...verdicts.unsure];
	return items.length > 0 ? { notice: `Check this round before publishing: ${items.join('; ')}.` } : {};
}

export function drawPicture(deps: FoundryDeps, scene: string): Promise<Uint8Array> {
	return generateImage(deps, { model: IMAGE_DEPLOYMENT, prompt: `${scene}\n${PICTURE_RULES}` });
}
