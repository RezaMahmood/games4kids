import { expect, test } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const KID_EMAIL = `kid-${RUN}@example.com`;
const KID_NAME = `Ada${RUN}`;

test('a child draws and saves until time_up on the games site, after an admin made the picture with an AI job on the admin site', async ({ browser }) => {
	test.setTimeout(240_000);
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const kidContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const admin = await adminContext.newPage();
	const kid = await kidContext.newPage();
	answerPopups(admin);
	const problems = collectProblems([admin, kid]);

	await test.step('the admin gives a child Draw Pad and links their account', async () => {
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await adminReady(admin);
		await expect(admin.getByRole('heading', { name: 'Members' })).toBeVisible();
		const add = admin.getByRole('region', { name: 'Add a member' });
		await add.getByLabel('Email').fill(KID_EMAIL);
		await add.getByLabel('Draw Pad').check();
		await add.getByRole('button', { name: 'Save member' }).click();
		await expect(admin.getByRole('status')).toHaveText(`Saved ${KID_EMAIL}.`);
		await admin.getByRole('button', { name: `Sync ${KID_EMAIL} with Entra` }).click();
		await expect(admin.getByRole('status')).toHaveText('Synced with Entra.');
	});

	await test.step('the child signs in and chooses a name', async () => {
		await kid.goto(`${GAMES}/`);
		await signInAtFakeEntra(kid, KID_EMAIL);
		await kid.getByLabel('Your name in games').fill(KID_NAME);
		await kid.getByRole('button', { name: "Let's play" }).click();
		await expect(kid.getByRole('list', { name: 'My games' }).getByRole('link', { name: /Draw Pad/ })).toBeVisible();
	});

	let title = '';
	await test.step('the admin describes a picture, the AI job finishes, and the admin adds one of its pictures to the library', async () => {
		await admin.goto(`${ADMIN}/g/drawpad/`);
		await adminReady(admin);
		await admin.getByLabel('What should the picture show?').fill('A fox asleep under an autumn tree');
		await admin.getByRole('button', { name: 'Make 3 pictures' }).click();
		const processing = admin.getByRole('region', { name: 'Processing' });
		await expect(processing.getByText('Ready to pick a picture')).toBeVisible({ timeout: 60_000 });
		await processing.getByRole('button', { name: 'Review' }).click();
		await admin.getByRole('button', { name: 'Picture 1' }).click();
		title = (await admin.getByLabel('Picture name').inputValue()).trim();
		expect(title).not.toBe('');
		const add = admin.getByRole('button', { name: 'Add to picture library' });
		await expect(add).toBeEnabled({ timeout: 60_000 });
		await add.click();
		await expect(admin.getByRole('status').filter({ hasText: 'to the picture library' })).toHaveText(`Added “${title}” to the picture library.`);
	});

	await test.step('the admin gives the child one minute a day', async () => {
		await admin.getByRole('button', { name: 'Limits' }).click();
		const row = admin.getByRole('row', { name: new RegExp(KID_NAME) });
		await row.getByLabel(`Daily limit in minutes for ${KID_NAME}`).fill('1');
		await row.getByRole('button', { name: 'Save' }).click();
		await expect(row.getByLabel(`Daily limit in minutes for ${KID_NAME}`)).toHaveValue('1');
		await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
	});

	await test.step('the child opens Draw Pad, picks the picture and draws on it, and the drawing is saved', async () => {
		await kid.clock.install();
		await kid.goto(`${GAMES}/g/drawpad/`);
		await expect(kid.getByRole('heading', { name: `What do you want to do, ${KID_NAME}?` })).toBeVisible();
		await kid.getByRole('button', { name: /Paint by numbers/ }).click();
		await kid.getByRole('button', { name: title }).click();
		await expect(kid.getByText(/areas painted/)).toBeVisible();
		await kid.getByRole('button', { name: 'Draw freely' }).click();
		const saved = kid.waitForResponse((response) => /\/drawings\/[^/]+\/image$/.test(response.url()) && response.request().method() === 'POST');
		const canvas = kid.getByRole('img', { name: `Your drawing on ${title}` });
		const box = await canvas.boundingBox();
		if (!box) throw new Error('the pen layer has no box');
		await kid.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
		await kid.mouse.down();
		await kid.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 8 });
		await kid.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, { steps: 8 });
		await kid.mouse.up();
		await kid.clock.runFor(5_000);
		expect((await saved).status()).toBe(204);
		await kid.getByRole('button', { name: 'History' }).click();
		await expect(kid.getByText('In progress').first()).toBeVisible();
	});

	await test.step('a minute of play is counted and the day ends with time_up', async () => {
		await expect(kid.getByRole('timer')).toContainText('min left');
		const used = kid.waitForResponse((response) => response.url().endsWith('/usage/heartbeat') && response.request().method() === 'POST' && response.status() === 200 && (response.request().postDataJSON() as { seconds: number }).seconds > 0);
		for (let beat = 0; beat < 7; beat++) {
			await kid.mouse.move(100 + beat * 10, 300);
			await kid.clock.runFor(20_000);
		}
		await used;
		await expect(kid.getByRole('dialog', { name: 'That’s all for today!' })).toBeVisible();
		await kid.getByRole('button', { name: 'OK' }).click();
		await expect(kid.getByRole('heading', { name: `That’s all for today, ${KID_NAME}` })).toBeVisible();
		await expect(kid.getByRole('button', { name: /Paint by numbers/ })).toBeDisabled();
	});

	await test.step('the admin sees the child\'s drawing in the gallery', async () => {
		await admin.goto(`${ADMIN}/g/drawpad/`);
		await adminReady(admin);
		await admin.getByRole('button', { name: 'Gallery' }).click();
		await expect(admin.getByRole('button', { name: `Enlarge ${KID_NAME}: ${title}` })).toBeVisible();
		const thumbnail = admin.locator('.gallery-thumb img').first();
		await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
	});

	expect(problems).toEqual([]);
	await adminContext.close();
	await kidContext.close();
});
