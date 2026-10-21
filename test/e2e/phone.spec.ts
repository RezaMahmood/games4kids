import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, GAMES, pageReady, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true };

async function expectNoSideways(page: Page): Promise<void> {
	const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
	expect(width, 'the page is laid out at phone width, not zoomed out').toBe(390);
	expect(scrollWidth, 'nothing scrolls sideways').toBeLessThanOrEqual(width);
}

async function expectFillsScreen(sheet: Locator): Promise<void> {
	const box = await sheet.boundingBox();
	expect(box, 'the sheet covers the phone screen').toEqual({ x: 0, y: 0, width: 390, height: 844 });
}

async function expectTouchSized(controls: Locator): Promise<void> {
	const sizes = await controls.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).filter(({ width }) => width > 0).map(({ width, height }) => Math.min(width, height)));
	expect(sizes.length).toBeGreaterThan(0);
	expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);
}

test('on a phone, every admin outcome shows in view and neither site scrolls sideways', async ({ browser }) => {
	const adminContext = await browser.newContext(PHONE);
	const admin = await adminContext.newPage();
	answerPopups(admin);
	const emails = Array.from({ length: 5 }, (_, i) => `phone-${i}-${RUN}@example.com`);
	const last = emails[emails.length - 1]!;

	await test.step('the admin adds members one after another in the add sheet and sees each save', async () => {
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await adminReady(admin);
		await admin.getByRole('button', { name: 'Add person' }).click();
		const add = admin.getByRole('dialog', { name: 'Add a person' });
		await expectFillsScreen(add);
		for (const email of emails) {
			await add.getByLabel('Email').fill(email);
			await add.getByLabel('Every game, including new ones').check();
			await add.getByRole('button', { name: 'Save person' }).click();
			await expect(add.getByRole('status')).toHaveText(`Saved ${email}. Sync now so their sign-in works.`);
			await expect(add.getByRole('status')).toBeInViewport({ ratio: 1 });
			if (email !== last) await add.getByRole('button', { name: 'Add another' }).click();
		}
		await add.getByRole('button', { name: 'Close' }).click();
		await expectNoSideways(admin);
	});

	await test.step('the last person is one search away, and their sheet shows each outcome on screen', async () => {
		await admin.getByRole('searchbox', { name: 'Search people' }).fill(last);
		await expect(admin.getByRole('list', { name: 'People' }).getByRole('button')).toHaveCount(1);
		await admin.getByRole('button', { name: new RegExp(last) }).click();
		const person = admin.getByRole('dialog', { name: last });
		await expectFillsScreen(person);
		await person.getByRole('button', { name: 'Save games' }).click();
		await expect(person.getByRole('status')).toHaveText(`Saved games for ${last}.`);
		await expect(person.getByRole('status')).toBeInViewport({ ratio: 1 });
		await person.getByRole('button', { name: 'Sync with Entra' }).click();
		await expect(person.getByRole('status')).toHaveText('Synced with Entra.');
		await expect(person.getByRole('status')).toBeInViewport({ ratio: 1 });
		await expect(person.getByRole('button', { name: 'Revoke access' })).toBeInViewport();
		await expectTouchSized(person.getByRole('button'));
		await person.getByRole('button', { name: 'Close' }).click();
	});

	await test.step('every control on the members page is at least the minimum touch size', async () => {
		await admin.getByRole('searchbox', { name: 'Search people' }).fill('');
		await expectTouchSized(admin.locator('main').getByRole('button'));
		await expectTouchSized(admin.locator('.chip'));
		await expectTouchSized(admin.getByRole('searchbox'));
	});

	const playerContext = await browser.newContext(PHONE);
	const player = await playerContext.newPage();

	await test.step('the games home on a phone shows its cards without sideways scroll', async () => {
		await player.goto(`${GAMES}/`);
		await signInAtFakeEntra(player, last);
		await pageReady(player);
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
