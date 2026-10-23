import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startFakeFoundry } from '../../dev/fake-foundry.ts';
import { parseChatUsage, parseImageUsage } from '@g4k/sdk';
import { AiFailure, generateImage } from '../../games/timedetectives/admin/api/foundry.ts';

const foundry = await startFakeFoundry();
after(() => foundry.close());

test('a Foundry call that hangs is given up as a failure the queue tries again', async () => {
	const hold = foundry.holdNext();
	const started = Date.now();
	const drawing = generateImage({ endpoint: foundry.origin, token: async () => 'tok', timeoutMs: 100 }, { area: 'picture', model: 'gpt-image-1-mini', prompt: 'a longship' });
	await assert.rejects(drawing, (error) => error instanceof AiFailure && error.retryable && /^TimeoutError/.test(error.message));
	assert.ok(Date.now() - started < 5_000);
	hold.release();
});

test('usage is read as Foundry documents it, and a reply without it bills nothing', () => {
	const chat = { usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 100 } } };
	assert.deepEqual(parseChatUsage(chat), { input: 800, cachedInput: 200, output: 500 }, 'reasoning tokens are already in completion_tokens');
	assert.deepEqual(parseChatUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), { input: 10, cachedInput: 0, output: 5 });
	const image = { usage: { input_tokens: 350, input_tokens_details: { text_tokens: 50, image_tokens: 300 }, output_tokens: 1000 } };
	assert.deepEqual(parseImageUsage(image), { textInput: 50, imageInput: 300, output: 1000 });
	assert.deepEqual(parseImageUsage({ usage: { input_tokens: 60, output_tokens: 1000 } }), { textInput: 60, imageInput: 0, output: 1000 }, 'input with no split bills as text');
	for (const reply of [null, {}, { usage: {} }, { usage: { prompt_tokens: -1, completion_tokens: 5 } }, { usage: { prompt_tokens: 1.5, completion_tokens: 5 } }]) {
		assert.equal(parseChatUsage(reply), undefined);
		assert.equal(parseImageUsage(reply), undefined);
	}
});
