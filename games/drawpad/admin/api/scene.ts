import type { RedrawQuality } from '../../data/types.ts';
import { chatJson, failure, postFoundry, type FoundryDeps } from './foundry.ts';
import { pngOf, REDRAW_CODES, REDRAWS } from './redraw.ts';
import { CHAT_DEPLOYMENT, cleanTitles } from './titles.ts';

const CODES = { failed: 'scene_failed', refused: 'scene_refused' } as const;
const PROMPT_COUNT = 3;
/** The first answer, then one more after pointing out a banned word. */
const ASKS = 2;

/** Image models draw fake numbers and colour keys into the picture when the prompt mentions them. */
const BANNED = /paint[- ]?by[- ]?numbers?|\bnumber(s|ed)?\b|\bdigits?\b|legend|colou?r key|swatch|colou?ring page|template|worksheet/i;

const SYSTEM = `You turn a short description typed by a parent or teacher into prompts for an image model. Each finished picture is printed for a child aged 6 to 10 who paints every flat colour area by hand. Answer only with the requested JSON.
Write 3 prompts that each take the description a clearly different way: a different scene, viewpoint or composition. Each prompt makes the image model draw:
- what the description asks for, made friendly and charming for children; fill in a sensible scene when the description is vague, and make anything unsuitable for children suitable
- one clear main subject filling most of the square picture, plus a simple background of a few big areas (sky, ground, water, wall)
- flat illustration with every area one solid colour: no outlines, no gradients, no shading, no texture, no patterns
- about 25 to 50 colour areas in total, each at least as big as a child's thumbprint on an A4 sheet
- important small features made big and simple: eyes as large solid dots or ovals, windows as plain blocks, faces with few parts
- about 8 clearly different colours
A prompt must never mention painting by numbers, numbers, digits, labels, legends, colour keys, swatches, colouring pages, templates or worksheets, because the image model then draws those into the picture. Each prompt also asks for no text and no borders. Write each prompt in plain sentences, 80 to 150 words.
Also suggest 3 titles for the picture, best first, each 2 to 5 words in Title Case, family friendly.`;

const SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['prompts', 'titles'],
	properties: { prompts: { type: 'array', items: { type: 'string' } }, titles: { type: 'array', items: { type: 'string' } } },
};

function cleanPrompts(value: unknown): string[] {
	const prompts = (value as { prompts?: unknown } | null)?.prompts;
	const kept = Array.isArray(prompts) ? prompts.map((prompt) => (typeof prompt === 'string' ? prompt.trim() : '')) : [];
	if (kept.length !== PROMPT_COUNT || kept.some((prompt) => !prompt)) throw failure(CODES.failed, `the reply did not have ${PROMPT_COUNT} prompts`);
	return kept;
}

const bannedWordIn = (prompts: string[]) => prompts.map((prompt) => BANNED.exec(prompt)?.[0]).find((hit) => hit !== undefined);

/** Asks a Foundry chat model to rewrite a description into three different image prompts, plus title ideas. */
export async function writePrompts(deps: FoundryDeps, description: string): Promise<{ prompts: string[]; titles: string[] }> {
	const messages: unknown[] = [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: `The description: "${description}"` },
	];
	for (let ask = 1; ; ask++) {
		const answer = await chatJson(deps, { model: CHAT_DEPLOYMENT, messages, name: 'scene', schema: SCHEMA }, CODES);
		const prompts = cleanPrompts(answer);
		const hit = bannedWordIn(prompts);
		if (hit === undefined) return { prompts, titles: cleanTitles(answer) };
		if (ask === ASKS) throw failure(CODES.failed, `the prompts still said "${hit}"`);
		messages.push(
			{ role: 'assistant', content: JSON.stringify(answer) },
			{ role: 'user', content: `Your last prompts said "${hit}". Write them again without that.` },
		);
	}
}

/** Draws one prompt with a Foundry image model, returning PNG bytes. */
export async function drawScene(deps: FoundryDeps, prompt: string, quality: RedrawQuality): Promise<Uint8Array> {
	const { deployment, quality: level } = REDRAWS[quality];
	const body = JSON.stringify({ model: deployment, prompt, size: '1024x1024', quality: level, n: 1 });
	return pngOf(await postFoundry(deps, 'images/generations', { body, headers: { 'content-type': 'application/json' } }, REDRAW_CODES));
}
