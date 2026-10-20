import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, answerPopups, GAMES, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true };

async function expectNoSideways(page: Page): Promise<void> {
	const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
	expect(width, 'the page is laid out at phone width, not zoomed out').toBe(390);
	expect(scrollWidth, 'nothing scrolls sideways').toBeLessThanOrEqual(width);
}

test('on a phone, every admin outcome shows in view and neither site scrolls sideways', async ({ browser }) => {
	const adminContext = await browser.newContext(PHONE);
	const admin = await adminContext.newPage();
	answerPopups(admin);
	const emails = Array.from({ length: 5 }, (_, i) => `phone-${i}-${RUN}@example.com`);
	const last = emails[emails.length - 1]!;

	await test.step('the admin adds members on a phone and sees each save', async () => {
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		const add = admin.getByRole('region', { name: 'Add a member' });
		for (const email of emails) {
			await add.getByLabel('Email').fill(email);
			await add.getByLabel('Every game, including new ones').check();
			await add.getByRole('button', { name: 'Save member' }).click();
			await expect(admin.getByRole('status')).toHaveText(`Saved ${email}.`);
		}
		await expectNoSideways(admin);
	});

	await test.step('saving games on a row near the bottom shows the outcome on screen', async () => {
		const row = admin.getByRole('row', { name: new RegExp(last) });
		await row.getByRole('button', { name: 'Save games' }).click();
		await expect(admin.getByRole('status')).toHaveText(`Saved games for ${last}.`);
		await expect(admin.getByRole('status')).toBeInViewport({ ratio: 1 });
		await expect(row.getByRole('button', { name: 'Sync' })).toBeInViewport();
	});

	await test.step('a sync from the bottom of the page shows its outcome on screen', async () => {
		await admin.getByRole('row', { name: new RegExp(last) }).getByRole('button', { name: 'Sync' }).click();
		await expect(admin.getByRole('status')).toHaveText('Synced with Entra.');
		await expect(admin.getByRole('status')).toBeInViewport({ ratio: 1 });
	});

	await test.step('every row button is at least the minimum touch size', async () => {
		const sizes = await admin.locator('#people button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect()).map(({ width, height }) => Math.min(width, height)));
		expect(sizes.length).toBeGreaterThan(0);
		expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);
	});

	const playerContext = await browser.newContext(PHONE);
	const player = await playerContext.newPage();

	await test.step('the games home on a phone shows its cards without sideways scroll', async () => {
		await player.goto(`${GAMES}/`);
		await signInAtFakeEntra(player, last);
		await player.getByLabel('Your name in games').fill(`P${RUN}`);
		await expectNoSideways(player);
		await player.getByRole('button', { name: "Let's play" }).click();
		await expect(player.getByRole('list', { name: 'My games' }).getByRole('link').first()).toBeVisible();
		await expectNoSideways(player);
	});

	const strangerContext = await browser.newContext(PHONE);
	const stranger = await strangerContext.newPage();

	await test.step('the not-invited screen on a phone fits the width', async () => {
		await stranger.goto(`${GAMES}/`);
		await signInAtFakeEntra(stranger, `stranger-${RUN}@example.com`);
		await expect(stranger.getByRole('heading', { name: 'Ask your grown-up to invite you' })).toBeVisible();
		await expectNoSideways(stranger);
	});

	await adminContext.close();
	await playerContext.close();
	await strangerContext.close();
});
