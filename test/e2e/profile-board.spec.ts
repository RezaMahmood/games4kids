import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const SWITCH = 'Show my scores on the Letter Tracing board';
const SIZES = [
	{ name: 'on a desktop', options: { viewport: { width: 1280, height: 800 } } },
	{ name: 'on a phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

async function signedInAdmin(page: Page): Promise<void> {
	answerPopups(page);
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
}

/** Letter Tracing's own switch for the Friends board, on its board screen. */
async function boardScreenSwitch(kid: Page) {
	await kid.goto(`${GAMES}/g/letterjoin/`);
	await pageReady(kid);
	await kid.locator('#board-open').click();
	return kid.getByRole('switch', { name: 'Show my scores on the board' });
}

for (const { name, options } of SIZES) {
	test(`${name}, a child turns the Friends board on and off from the profile page and Letter Tracing agrees`, async ({ browser }) => {
		test.setTimeout(180_000);
		const tag = `${RUN}${name.length}`;
		const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
		const admin = await adminContext.newPage();
		await signedInAdmin(admin);
		const kid = await namedChild(browser, admin, `board-${tag}@example.com`, `Ada${tag}`, 'Letter Tracing', options);
		const drawer = await namedChild(browser, admin, `drawer-${tag}@example.com`, `Dee${tag}`, 'Draw Pad', options);
		const problems = collectProblems([kid, drawer]);

		await kid.goto(`${GAMES}/profile/`);
		await pageReady(kid);
		const toggle = kid.getByRole('switch', { name: SWITCH });

		await test.step('the switch starts off, and only Letter Tracing has one', async () => {
			await expect(toggle).toBeEnabled();
			await expect(toggle).not.toBeChecked();
			await expect(kid.getByRole('switch')).toHaveCount(1);
		});

		await test.step('turning it on shows on the board screen in Letter Tracing', async () => {
			await toggle.click();
			await expect(toggle).toBeChecked();
			await expect(toggle).toBeEnabled();
			await expect(kid.getByText('Saving…')).toHaveCount(0);
			await expect(await boardScreenSwitch(kid)).toHaveAttribute('aria-checked', 'true');
		});

		await test.step('the profile page shows it on after a reload, and turning it off shows in Letter Tracing too', async () => {
			await kid.goto(`${GAMES}/profile/`);
			await pageReady(kid);
			await expect(toggle).toBeChecked();
			await toggle.click();
			await expect(toggle).not.toBeChecked();
			await expect(toggle).toBeEnabled();
			await expect(await boardScreenSwitch(kid)).toHaveAttribute('aria-checked', 'false');
		});

		await test.step('a child without Letter Tracing sees no scoreboard switch', async () => {
			await drawer.goto(`${GAMES}/profile/`);
			await pageReady(drawer);
			await expect(drawer.getByLabel('Your name in games')).toHaveValue(`Dee${tag}`);
			await expect(drawer.getByRole('switch')).toHaveCount(0);
			await expect(drawer.getByRole('heading', { name: 'Scoreboards' })).toBeHidden();
		});

		expect(problems).toEqual([]);
		await adminContext.close();
		await kid.context().close();
		await drawer.context().close();
	});
}

async function publishedSentence(admin: Page, title: string): Promise<void> {
	await admin.goto(`${ADMIN}/g/letterjoin/#settings`);
	await adminReady(admin);
	await admin.getByRole('link', { name: /^Activities/ }).click();
	await admin.locator('#new-activity').click();
	await admin.locator('#f-type').selectOption('sentence');
	await admin.locator('#f-title').fill(title);
	await admin.locator('#f-status').selectOption('published');
	await admin.locator('#f-sentence').fill('Zebras jump.');
	await admin.locator('#f-save').click();
	await expect(admin.getByRole('dialog')).toBeHidden();
}

/** Scores `title` for the child without drawing it, with the token the game page itself just used. */
async function scoreWithoutDrawing(kid: Page, title: string): Promise<void> {
	const [listing] = await Promise.all([
		kid.waitForResponse((response) => response.url().endsWith('/api/g/letterjoin/activities') && response.request().method() === 'GET'),
		kid.goto(`${GAMES}/g/letterjoin/`),
	]);
	const { activities } = (await listing.json()) as { activities: { id: string; title: string }[] };
	const activity = activities.find((candidate) => candidate.title === title);
	const authorization = (await listing.request().allHeaders())['authorization'];
	if (!activity || !authorization) throw new Error('the game page did not list the activity with a token');
	const saved = await kid.request.put(`${listing.url()}/${activity.id}/result`, { headers: { authorization }, data: { attemptId: randomUUID(), score: 80, timeMs: 5000 } });
	expect(saved.status()).toBe(200);
}

test('a rename on the profile page shows on another child\'s Friends board without the child opening their own', async ({ browser }) => {
	test.setTimeout(240_000);
	const tag = `${RUN}r`;
	const desktop = { viewport: { width: 1280, height: 800 } };
	const title = `Zebras ${tag}`;
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const admin = await adminContext.newPage();
	await signedInAdmin(admin);
	const ada = await namedChild(browser, admin, `ren-${tag}@example.com`, `Ada${tag}`, 'Letter Tracing', desktop);
	const bea = await namedChild(browser, admin, `fri-${tag}@example.com`, `Bea${tag}`, 'Letter Tracing', desktop);
	const problems = collectProblems([ada, bea]);
	await publishedSentence(admin, title);

	for (const kid of [ada, bea]) {
		await kid.goto(`${GAMES}/profile/`);
		await pageReady(kid);
		await kid.getByRole('switch', { name: SWITCH }).click();
		await expect(kid.getByRole('switch', { name: SWITCH })).toBeChecked();
		await expect(kid.getByRole('switch', { name: SWITCH })).toBeEnabled();
	}
	await scoreWithoutDrawing(ada, title);

	const seenOnBeasBoard = async (name: string) => {
		await bea.goto(`${GAMES}/g/letterjoin/`);
		await pageReady(bea);
		await bea.locator('#board-open').click();
		await expect(bea.getByRole('rowheader', { name })).toBeVisible();
	};
	await seenOnBeasBoard(`Ada${tag}`);

	await ada.goto(`${GAMES}/profile/`);
	await pageReady(ada);
	await ada.getByLabel('Your name in games').fill(`Cleo${tag}`);
	const refreshed = ada.waitForResponse((response) => response.url().endsWith('/api/g/letterjoin/board/me') && response.request().method() === 'GET');
	await ada.getByRole('button', { name: 'Save' }).click();
	await expect(ada.getByRole('status')).toHaveText(`Saved. Your name in games is Cleo${tag}.`);
	await refreshed;

	await seenOnBeasBoard(`Cleo${tag}`);
	await expect(bea.getByRole('rowheader', { name: `Ada${tag}` })).toHaveCount(0);

	expect(problems).toEqual([]);
	await adminContext.close();
	await ada.context().close();
	await bea.context().close();
});

test('a slow or failing game holds up only its own switch, never the name', async ({ browser }) => {
	test.setTimeout(180_000);
	const tag = `${RUN}f`;
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const admin = await adminContext.newPage();
	await signedInAdmin(admin);
	const kid = await namedChild(browser, admin, `slow-${tag}@example.com`, `Ada${tag}`, 'Letter Tracing', { viewport: { width: 1280, height: 800 } });
	const toggle = kid.getByRole('switch', { name: SWITCH });
	const note = kid.locator('.boards .help');

	await test.step('a game that cannot be reached leaves its switch off and the rest of the page usable', async () => {
		await kid.route('**/api/g/letterjoin/board/me', (route) => route.abort());
		await kid.goto(`${GAMES}/profile/`);
		await pageReady(kid);
		await expect(note).toHaveText('We could not load this. Try again.');
		await expect(toggle).toBeDisabled();
		await expect(kid.getByLabel('Your name in games')).toBeEnabled();
		await expect(kid.getByRole('button', { name: 'Save' })).toBeEnabled();
		await kid.unroute('**/api/g/letterjoin/board/me');
	});

	await test.step('a reply that cannot be read ends in the same error, never in Loading…', async () => {
		await kid.route('**/api/g/letterjoin/board/me', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			return route.fulfill({ response: await route.fetch(), json: {} });
		});
		await kid.goto(`${GAMES}/profile/`);
		await pageReady(kid);
		await expect(note).toHaveText('We could not load this. Try again.');
		await expect(toggle).toBeDisabled();
		await kid.unroute('**/api/g/letterjoin/board/me');
	});

	await test.step('while the game answers nothing, the page is ready, the switch says Loading…, and a rename saves', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await kid.route('**/api/g/letterjoin/board/me', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			await held;
			return route.continue();
		});
		await kid.goto(`${GAMES}/profile/`);
		await pageReady(kid);
		await expect(toggle).toBeDisabled();
		await expect(note).toHaveText('Loading…');
		await kid.getByLabel('Your name in games').fill(`Cleo${tag}`);
		await kid.getByRole('button', { name: 'Save' }).click();
		await expect(kid.getByRole('status')).toHaveText(`Saved. Your name in games is Cleo${tag}.`);
		release();
		await expect(toggle).toBeEnabled();
		await expect(note).toHaveText('');
		await kid.unroute('**/api/g/letterjoin/board/me');
	});

	await test.step('while a change is saving, the switch says Saving… and waits', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await kid.route('**/api/g/letterjoin/board/me', async (route) => {
			if (route.request().method() !== 'PUT') return route.fallback();
			await held;
			return route.continue();
		});
		await toggle.click();
		await expect(toggle).toBeDisabled();
		await expect(note).toHaveText('Saving…');
		release();
		await expect(toggle).toBeEnabled();
		await expect(toggle).toBeChecked();
		await kid.unroute('**/api/g/letterjoin/board/me');
	});

	await test.step('a save that fails puts the switch back and says so beside it', async () => {
		await kid.route('**/api/g/letterjoin/board/me', (route) => (route.request().method() === 'PUT' ? route.abort() : route.fallback()));
		await toggle.click();
		await expect(note).toHaveText('We could not save this. Try again.');
		await expect(toggle).toBeChecked();
		await expect(toggle).toBeEnabled();
		await kid.unroute('**/api/g/letterjoin/board/me');
	});

	await adminContext.close();
	await kid.context().close();
});
