import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { startFakeFoundry } from '../../dev/fake-foundry.ts';
import { AiFailure, generateImage } from '../../games/timedetectives/admin/api/foundry.ts';

const foundry = await startFakeFoundry();
after(() => foundry.close());

test('a Foundry call that hangs is given up as a failure the queue tries again', async () => {
	const hold = foundry.holdNext();
	const started = Date.now();
	const drawing = generateImage({ endpoint: foundry.origin, token: async () => 'tok', timeoutMs: 100 }, { model: 'gpt-image-1-mini', prompt: 'a longship' });
	await assert.rejects(drawing, (error) => error instanceof AiFailure && error.retryable && /^TimeoutError/.test(error.message));
	assert.ok(Date.now() - started < 5_000);
	hold.release();
});
