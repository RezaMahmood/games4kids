import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);

function healthCalls(page: Page): string[] {
	const seen: string[] = [];
	page.on('request', (request) => {
		const match = /\/api\/g\/([^/]+)\/health$/.exec(new URL(request.url()).pathname);
		if (match?.[1]) seen.push(match[1]);
	});
	return seen;
}

test('the home page wakes every game while the portal is still waking, and a game page wakes no other game', async ({ browser }) => {
	test.setTimeout(120_000);
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const admin = await adminContext.newPage();
	answerPopups(admin);
	await admin.goto(`${ADMIN}/`);
	await signInAtFakeEntra(admin, ADMIN_EMAIL);
	await adminReady(admin);
	const kid = await namedChild(browser, admin, `wake-${RUN}@example.com`, `Wren${RUN}`, 'Draw Pad', {});
	const catalog = (await (await kid.request.get(`${GAMES}/catalog.json`)).json()) as { id: string }[];
	expect(catalog.length, 'the dev catalog has games to wake').toBeGreaterThan(1);

	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await kid.route('**/api/portal/me', async (route) => {
		await held;
		await route.continue();
	});
	const woken = healthCalls(kid);
	await kid.reload();
	await expect.poll(() => [...new Set(woken)].sort(), { message: 'every game is called before the portal answers' }).toEqual(catalog.map((game) => game.id).sort());
	await expect(kid.locator('body')).toHaveAttribute('aria-busy', 'true');
	release();
	await pageReady(kid);
	await kid.unroute('**/api/portal/me');

	woken.length = 0;
	await kid.getByRole('link', { name: /Draw Pad/ }).click();
	await expect(kid.getByRole('link', { name: 'All games' })).toBeVisible();
	await pageReady(kid);
	expect(woken, 'a game page calls no health route').toEqual([]);
	await adminContext.close();
	await kid.context().close();
});
