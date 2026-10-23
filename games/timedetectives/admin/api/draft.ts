import { isRecord, KINDS, parseRoundContent, type Angle, type Checks, type Finding, type Parsed, type RoundContent } from '../../data/index.ts';
import { checkRound, forWriter, type TypeSafeDeps } from './check.ts';
import { AiFailure, chatJson, generateImage, type Area, type FoundryDeps } from './foundry.ts';

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

/**
 * `checks` is what the automatic check found still wrong or was unsure of, or that it could not run. None when it was
 * off or found nothing. A redraft has no `picturePrompt`, since its picture stays.
 */
export type Written = { content: RoundContent; picturePrompt?: string; checks?: Checks };

/** What the topic already holds: the titles of rounds with words, and the focus of each round the AI is still writing. */
export type Covered = { titles: readonly string[]; drafting: readonly string[] };

/**
 * What the chat model is asked for: a new round about a focus, or a redraft that fixes what the check found in a round.
 * A new round with no focus is told what the topic covers and given an angle, so it chooses a different moment each
 * time. A redraft keeps the picture, so it is asked for neither a picture prompt nor alt text, and keeps the alt text it had.
 */
export type Ask =
	| { kind: 'new'; topic: { title: string; guidance: string }; focus: string; covered: Covered; angle?: Angle }
	| { kind: 'redraft'; content: RoundContent; findings: readonly Finding[] };

const { pictureAlt: _alt, picturePrompt: _prompt, ...WORDS } = SCHEMA.properties;
const REDRAFT_SCHEMA = { ...SCHEMA, required: SCHEMA.required.filter((key) => key !== 'pictureAlt' && key !== 'picturePrompt'), properties: WORDS };

type Reading = { parsed: Parsed<RoundContent>; picturePrompt?: string; problems: string[] };
type Request = { area: Area; name: string; schema: object; first: string; read: (answer: unknown) => Reading };

/** How each ask is billed, put and read back. The admin's words, and the round's, go in as quoted data, so they shape the round without becoming instructions. */
function requestFor(ask: Ask): Request {
	if (ask.kind === 'redraft') {
		const { pictureAlt, ...words } = ask.content;
		return {
			area: 'redraft',
			name: 'redraft',
			schema: REDRAFT_SCHEMA,
			first: [
				`Here is a round, as JSON: ${JSON.stringify(words)}`,
				'An automatic check read it and found these problems:',
				...ask.findings.map((finding) => `- ${forWriter(finding, ask.content)}`),
				'Rewrite the round to fix exactly these problems. Keep everything else as it is, including the story\'s facts and the answers, unless a problem is about an answer.',
				`The picture stays as it is, so keep the story true to it: ${JSON.stringify(pictureAlt)}`,
			].join('\n'),
			read: (answer) => ({ parsed: parseRoundContent(isRecord(answer) ? { ...answer, pictureAlt } : answer), problems: [] }),
		};
	}
	return {
		area: 'words',
		name: 'round',
		schema: SCHEMA,
		first: [
			`Topic: ${JSON.stringify(ask.topic.title)}`,
			ask.topic.guidance && `Guidance from the teacher: ${JSON.stringify(ask.topic.guidance)}`,
			...(ask.focus ? [`Write the round about: ${JSON.stringify(ask.focus)}`] : chooseFresh(ask.covered, ask.angle)),
		].filter(Boolean).join('\n'),
		read: (answer) => {
			const picturePrompt = isRecord(answer) && typeof answer['picturePrompt'] === 'string' ? answer['picturePrompt'].trim() : '';
			return { parsed: parseRoundContent(answer), picturePrompt, problems: picturePrompt ? [] : ['picturePrompt must not be empty'] };
		},
	};
}

function chooseFresh({ titles, drafting }: Covered, angle: Angle | undefined): string[] {
	const different = titles.length > 0 || drafting.length > 0;
	return [
		titles.length > 0 && `The topic already has rounds with these titles: ${JSON.stringify(titles)}`,
		drafting.length > 0 && `Other rounds are being written now about: ${JSON.stringify(drafting)}`,
		angle && `Take this angle: ${JSON.stringify(angle)}`,
		different ? 'Choose a well-known moment from this topic that is clearly different from those rounds: a different moment, person or place.' : 'Choose a well-known moment from this topic.',
	].filter((line) => typeof line === 'string');
}

/**
 * Asks the chat model for a round, and once more with the problems when its answer does not parse or TypeSafe's check
 * fails it. A check never fails the round: what is still wrong on the last ask, or unsure, or could not be checked,
 * becomes the round's checks. `onCheckError` hears why a check could not run.
 */
export async function writeRound(deps: FoundryDeps, ask: Ask, typesafe?: TypeSafeDeps, onCheckError: (error: unknown) => void = () => {}): Promise<Written> {
	const { first, read, ...request } = requestFor(ask);
	const messages: unknown[] = [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: first },
	];
	for (let asked = 1; ; asked++) {
		const answer = await chatJson(deps, { ...request, model: CHAT_DEPLOYMENT, messages });
		const { parsed, picturePrompt, ...reading } = read(answer);
		const problems = [...(parsed.ok ? [] : parsed.problems), ...reading.problems];
		if (parsed.ok && problems.length === 0) {
			const checks = typesafe ? await checked(typesafe, parsed.value, onCheckError) : [];
			const fails = checks === 'not-run' ? [] : checks.filter(({ sure }) => sure);
			if (fails.length > 0 && asked < ASKS) problems.push(...fails.map((finding) => forWriter(finding, parsed.value)));
			else return { content: parsed.value, ...(picturePrompt && { picturePrompt }), ...((checks === 'not-run' || checks.length > 0) && { checks }) };
		}
		if (asked === ASKS) throw new AiFailure(false, `The AI's round was not usable: ${problems.slice(0, 3).join('; ')}`);
		messages.push({ role: 'assistant', content: JSON.stringify(answer) }, { role: 'user', content: `That round has problems: ${problems.join('; ')}. Write it again, fixing them.` });
	}
}

async function checked(typesafe: TypeSafeDeps, content: RoundContent, onError: (error: unknown) => void): Promise<Finding[] | 'not-run'> {
	try {
		return await checkRound(typesafe, content);
	} catch (error) {
		onError(error);
		return 'not-run';
	}
}

export function drawPicture(deps: FoundryDeps, scene: string): Promise<Uint8Array> {
	return generateImage(deps, { area: 'picture', model: IMAGE_DEPLOYMENT, prompt: `${scene}\n${PICTURE_RULES}` });
}
