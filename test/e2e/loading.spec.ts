import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, addAndSync, adminReady, answerPopups, GAMES, pageReady, signInAtFakeEntra } from './support.ts';

const MEMBERS = '**/api/admin/portal/members';
const SIZES = [
	{ name: 'on a desktop', options: { viewport: { width: 1280, height: 800 } } },
	{ name: 'on a phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

async function signedInAdmin(page: Page): Promise<void> {
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
}

/** Holds the members list request until the returned function runs, then answers it with `answer`, or lets it through. */
async function holdMembers(page: Page, answer?: Parameters<Page['route']>[1]): Promise<() => void> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(MEMBERS, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		await held;
		return answer ? answer(route, route.request()) : route.continue();
	});
	return release;
}

async function overlay(page: Page) {
	return page.evaluate(() => {
		const grey = getComputedStyle(document.body, '::before');
		const ring = getComputedStyle(document.body, '::after');
		return {
			shown: grey.content !== 'none',
			coversViewport: grey.position === 'fixed' && grey.width === `${innerWidth}px` && grey.height === `${innerHeight}px`,
			spinning: ring.animationName === 'g4k-spin',
		};
	});
}

async function typeIntoSearchByHand(page: Page, text: string): Promise<void> {
	const box = await page.locator('#search').boundingBox();
	expect(box, 'the search field is laid out').not.toBeNull();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.keyboard.type(text);
}

for (const { name, options } of SIZES) {
	test(`${name}, the page is greyed out and unusable until the first members load finishes`, async ({ browser }) => {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		await signedInAdmin(page);
		const release = await holdMembers(page);

		try {
			await page.reload();
			await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
			expect(await overlay(page), 'a grey layer and a spinning ring cover the page').toEqual({ shown: true, coversViewport: true, spinning: true });
			await typeIntoSearchByHand(page, 'early@example.com');
			await expect(page.locator('#search'), 'a tap on the search while loading does nothing').toHaveValue('');
			await expect(page.locator('#search')).not.toBeFocused();
		} finally {
			release();
		}

		await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
		expect((await overlay(page)).shown, 'the grey layer is gone').toBe(false);
		await typeIntoSearchByHand(page, 'later@example.com');
		await expect(page.locator('#search'), 'the search takes input once the list is in').toHaveValue('later@example.com');
		await context.close();
	});

	test(`${name}, a failed first members load still lifts the overlay and shows the error`, async ({ browser }) => {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		await signedInAdmin(page);
		const release = await holdMembers(page, (route) =>
			route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'storage_down', message: 'The member list is unavailable.' }) }),
		);

		try {
			await page.reload();
			await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
		} finally {
			release();
		}

		await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('status')).toHaveText('The member list is unavailable.');
		await typeIntoSearchByHand(page, 'still@example.com');
		await expect(page.locator('#search'), 'the page is usable after the failure').toHaveValue('still@example.com');
		await context.close();
	});
}

const DRAWPAD_API = '**/api/admin/g/drawpad/**';

for (const { name, options } of SIZES) {
	test(`${name}, the Draw Pad admin stays greyed out until its first request settles, then lifts`, async ({ browser }) => {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		await signedInAdmin(page);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(DRAWPAD_API, async (route) => {
			await held;
			return route.continue();
		});

		try {
			await page.goto(`${ADMIN}/g/drawpad/`);
			await expect(page.getByRole('status').filter({ hasText: 'Loading recent uploads' })).toBeAttached();
			await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
			expect((await overlay(page)).shown, 'the grey layer covers the page while the request hangs').toBe(true);
		} finally {
			release();
		}

		await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
		expect((await overlay(page)).shown, 'the grey layer is gone').toBe(false);
		await context.close();
	});

	test(`${name}, a failed first Draw Pad request still lifts the overlay`, async ({ browser }) => {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		await signedInAdmin(page);
		await page.route(DRAWPAD_API, (route) =>
			route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'storage_down', message: 'Recent uploads are unavailable.' }) }),
		);

		await page.goto(`${ADMIN}/g/drawpad/`);

		await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('alert').filter({ hasText: /recent uploads/i })).toBeVisible();
		await context.close();
	});
}

const RUN = Date.now().toString(36);

/** Holds every request matching `url` until the returned function runs, then answers it with `answer`, or lets it through. */
async function hold(page: Page, url: string, answer?: Parameters<Page['route']>[1]): Promise<() => void> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(url, async (route) => {
		await held;
		return answer ? answer(route, route.request()) : route.continue();
	});
	return release;
}

const GAMES_PAGES = [
	{ game: 'Letter Tracing', path: '/g/letterjoin/', api: '**/api/g/letterjoin/session', loaded: (page: Page) => page.getByRole('heading', { name: 'Choose an activity' }) },
	{ game: 'Draw Pad', path: '/g/drawpad/', api: '**/api/g/drawpad/session', loaded: (page: Page) => page.getByRole('heading', { name: /^What do you want to do/ }) },
] as const;

for (const { game, path, api, loaded } of GAMES_PAGES) {
	test(`while the Function app wakes, home and ${game} show the overlay instead of a blank page, and lift it once they load or fail`, async ({ browser }) => {
		test.setTimeout(120_000);
		const adminContext = await browser.newContext();
		const admin = await adminContext.newPage();
		answerPopups(admin);
		const kidEmail = `wake-${path.split('/')[2]}-${RUN}@example.com`;
		await signedInAdmin(admin);
		await addAndSync(admin, kidEmail, game);

		const kidContext = await browser.newContext({ ignoreHTTPSErrors: true });
		const kid = await kidContext.newPage();
		await kid.goto(`${GAMES}/`);
		await signInAtFakeEntra(kid, kidEmail);
		await pageReady(kid);
		await kid.getByLabel('Your name in games').fill(`W${RUN}${path.length}`);
		await kid.getByRole('button', { name: "Let's play" }).click();
		await expect(kid.getByRole('list', { name: 'My games' }).getByRole('link')).toHaveCount(1);

		const releaseMe = await hold(kid, '**/api/portal/me');
		try {
			await kid.reload();
			await expect(kid.locator('body')).toHaveAttribute('aria-busy', 'true');
			expect(await overlay(kid), 'home is greyed with a spinning ring while GET me hangs').toEqual({ shown: true, coversViewport: true, spinning: true });
		} finally {
			releaseMe();
		}
		await pageReady(kid);
		await expect(kid.getByRole('list', { name: 'My games' }).getByRole('link', { name: new RegExp(game) })).toBeVisible();
		await kid.unroute('**/api/portal/me');

		const releaseSession = await hold(kid, api);
		try {
			await kid.goto(`${GAMES}${path}`);
			await expect(kid.locator('body')).toHaveAttribute('aria-busy', 'true');
			expect(await overlay(kid), `${game} is greyed with a spinning ring while GET session hangs`).toEqual({ shown: true, coversViewport: true, spinning: true });
		} finally {
			releaseSession();
		}
		await pageReady(kid);
		await expect(loaded(kid)).toBeVisible();
		expect((await overlay(kid)).shown, 'the grey layer is gone').toBe(false);
		await kid.unroute(api);

		await kid.route(api, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'storage_down', message: 'The game is unavailable.' }) }));
		await kid.goto(`${GAMES}${path}`);
		await expect(kid.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
		await pageReady(kid);

		await kidContext.close();
		await adminContext.close();
	});
}
