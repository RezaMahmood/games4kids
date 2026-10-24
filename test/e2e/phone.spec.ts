import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, GAMES, openBarMenu, pageReady, signInAtFakeEntra } from './support.ts';

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

/** Every control showing in the bar is whole in view, a full touch target, clear of the others, and the bar leaves the page in view. A closed menu's links do not show, so they are not asked to. */
async function expectBarControlsFit(bar: Locator, width: number): Promise<number> {
	const boxes = await bar.locator('a, button').evaluateAll((elements) => elements.map((element) => ({ name: element.textContent ?? '', ...element.getBoundingClientRect().toJSON() })).filter(({ width: w }) => w > 0));
	expect(boxes.length, 'brand, Members, Costs, Games and the account button').toBeGreaterThanOrEqual(5);
	for (const [i, a] of boxes.entries()) {
		expect(Math.min(a.width, a.height), `${a.name} is a touch target`).toBeGreaterThanOrEqual(44);
		expect(a.left, `${a.name} starts inside the screen`).toBeGreaterThanOrEqual(0);
		expect(a.right, `${a.name} ends inside the screen`).toBeLessThanOrEqual(width);
		for (const b of boxes.slice(i + 1)) {
			const apart = a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
			expect(apart, `${a.name} and ${b.name} do not overlap`).toBe(true);
		}
	}
	const height = (await bar.boundingBox())!.height;
	expect(height, 'the bar leaves the page in view').toBeLessThanOrEqual(160);
	return height;
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

	await test.step('the admin bar shows each of its controls in full, and the Games menu shows every game link within reach', async () => {
		await admin.evaluate(() => window.scrollTo(0, 0));
		const bar = admin.locator('admin-bar .g4k-bar');
		await expectBarControlsFit(bar, 390);
		const panel = await openBarMenu(admin, 'Games');
		const links = panel.getByRole('link');
		expect(await links.count(), 'the pause page and at least one game').toBeGreaterThan(1);
		for (const link of await links.all()) await expect(link).toBeInViewport({ ratio: 1 });
		await expectTouchSized(links);
		await expectNoSideways(admin);
		await admin.keyboard.press('Escape');
		await expect(panel).toBeHidden();
	});

	await test.step('the admin bar keeps its height when a machine draws the words wider', async () => {
		const bar = admin.locator('admin-bar .g4k-bar');
		await bar.evaluate((element) => ((element as HTMLElement).style.letterSpacing = '0.12em'));
		await expectBarControlsFit(bar, 390);
		await expectNoSideways(admin);
		await bar.evaluate((element) => ((element as HTMLElement).style.letterSpacing = ''));
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

	await test.step('on a game page, the child taps the big back button and lands on the games list', async () => {
		await player.getByRole('list', { name: 'My games' }).getByRole('link', { name: /Draw Pad/ }).click();
		await pageReady(player);
		const bar = player.locator('portal-bar .g4k-bar');
		const back = bar.getByRole('link', { name: 'Back to all games' });
		await expect(back).toHaveText('All games');
		await expect(bar).toContainText('Draw Pad');
		await expectTouchSized(back);
		await expectNoSideways(player);
		await back.tap();
		await expect(player).toHaveURL(`${GAMES}/`);
		await expect(player.getByRole('list', { name: 'My games' }).getByRole('link').first()).toBeVisible();
		await expect(player.locator('portal-bar .g4k-bar').getByRole('link', { name: 'Back to all games' })).toHaveCount(0);
	});

	await test.step('the Draw Pad landing on a small phone keeps each card’s text inside its card, and the cards do not overlap', async () => {
		await player.setViewportSize({ width: 375, height: 667 });
		await player.goto(`${GAMES}/g/drawpad/`);
		await pageReady(player);
		await expect(player.getByRole('heading', { name: /What do you want to do/ })).toBeVisible();
		await player.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
		const cards = player.locator('.home-grid > button');
		await expect(cards).toHaveCount(2);
		const boxes = await cards.evaluateAll((elements) =>
			elements.map((card) => {
				const { top, bottom } = card.getBoundingClientRect();
				const text = card.querySelector('.journey-text')!.getBoundingClientRect();
				return { top, bottom, textTop: text.top, textBottom: text.bottom };
			}),
		);
		for (const box of boxes) {
			expect(box.textTop, 'the card text starts inside its card').toBeGreaterThanOrEqual(box.top);
			expect(box.textBottom, 'the card text ends inside its card').toBeLessThanOrEqual(box.bottom);
		}
		expect(boxes[0]!.bottom, 'the first card ends before the second begins').toBeLessThanOrEqual(boxes[1]!.top);
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

for (const width of [320, 390, 430]) {
	test(`at ${width}px the admin bar's controls never overlap, each is a full touch target, and the Games menu fits`, async ({ browser }) => {
		const context = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
		const page = await context.newPage();
		await page.goto(`${ADMIN}/costs/`);
		await signInAtFakeEntra(page, ADMIN_EMAIL);
		await adminReady(page);
		const bar = page.locator('admin-bar .g4k-bar');
		for (const control of await bar.locator('a, button').filter({ visible: true }).all()) await expect(control).toBeInViewport({ ratio: 1 });
		const height = await expectBarControlsFit(bar, width);
		console.log(`admin bar at ${width}px is ${height}px tall`);
		const panel = await openBarMenu(page, 'Games');
		for (const link of await panel.getByRole('link').all()) await expect(link).toBeInViewport({ ratio: 1 });
		await expectTouchSized(panel.getByRole('link'));
		await page.keyboard.press('Escape');
		const account = await openBarMenu(page, 'Account');
		await expect(account.getByRole('button', { name: 'Sign out' })).toBeInViewport({ ratio: 1 });
		await expectTouchSized(account.getByRole('button', { name: 'Sign out' }));
		await page.keyboard.press('Escape');
		expect(await page.evaluate(() => document.documentElement.scrollWidth), 'nothing scrolls sideways').toBeLessThanOrEqual(width);
		if (process.env['G4K_SHOTS']) await page.screenshot({ path: `${process.env['G4K_SHOTS']}/admin-bar-${width}.png` });
		await context.close();
	});
}
