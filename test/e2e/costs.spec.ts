import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const SHOTS = process.env['G4K_SHOTS'];
const SIZES = [
	{ name: 'at 820px', options: { viewport: { width: 820, height: 1000 } } },
	{ name: 'at 390px', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
] as const;

async function adminPage(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<Page> {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
	const page = await context.newPage();
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
	return page;
}

const shot = (page: Page, name: string) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

/** Has the fake AI draft one round, so the ledger holds this run's calls. */
async function spendSomething(page: Page): Promise<void> {
	await page.goto(`${ADMIN}/g/timedetectives/`);
	await adminReady(page);
	await page.getByRole('button', { name: 'New topic' }).click();
	await page.getByLabel('Title', { exact: true }).fill(`Costs ${Date.now().toString(36)}`);
	await page.getByRole('button', { name: 'Save topic' }).click();
	await page.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(page.locator('#rounds .badge.draft')).toBeVisible();
	await page.getByRole('link', { name: 'Review and publish' }).click();
	await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
}

/** Has a child write a line in hard mode, so the games app's ledger holds one handwriting read. */
async function readSomeHandwriting(browser: Browser): Promise<void> {
	const run = Date.now().toString(36);
	const title = `Costs ${run}`;
	const admin = await adminPage(browser, {});
	answerPopups(admin);
	const kid = await namedChild(browser, admin, `costs-${run}@example.com`, `Cal${run}`, 'Letter Tracing', { viewport: { width: 1024, height: 1366 }, hasTouch: true });
	await admin.goto(`${ADMIN}/g/letterjoin/`);
	await adminReady(admin);
	await admin.locator('#new-activity').click();
	await admin.locator('#f-type').selectOption('sentence');
	await admin.locator('#f-title').fill(title);
	await admin.locator('#f-status').selectOption('published');
	await admin.locator('#f-sentence').fill('Cats nap.');
	await admin.locator('#f-save').click();
	await expect(admin.getByRole('dialog')).toBeHidden();

	await kid.goto(`${GAMES}/g/letterjoin/`);
	await pageReady(kid);
	await kid.locator('.card-slot', { hasText: title }).locator('.hard-toggle').click();
	await kid.locator('.activity-card', { hasText: title }).click();
	await expect(kid.locator('#write-screen')).toBeVisible();
	const pad = (await kid.locator('#write-pad').boundingBox())!;
	await kid.mouse.move(pad.x + 60, pad.y + pad.height / 2);
	await kid.mouse.down();
	await kid.mouse.move(pad.x + 160, pad.y + pad.height / 2 - 30);
	await kid.mouse.move(pad.x + 260, pad.y + pad.height / 2);
	await kid.mouse.up();
	const read = kid.waitForResponse((response) => /\/activities\/[^/]+\/read$/.test(response.url()) && response.request().method() === 'POST');
	await kid.locator('#write-done').click();
	await kid.getByRole('dialog', { name: 'Finished writing?' }).getByRole('button', { name: "Yes, I've finished" }).click();
	expect((await read).status()).toBe(200);
	await kid.context().close();
	await admin.context().close();
}

test.beforeAll(async ({ browser }) => {
	test.setTimeout(120_000);
	await readSomeHandwriting(browser);
});

const london = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', ...options }).format(new Date());

for (const { name, options } of SIZES) {
	test(`${name}, the AI costs page shows what a drafted round and a child's handwriting read cost by day, month and year, and by app and area`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		const problems = collectProblems([page]);
		await spendSomething(page);

		await page.goto(`${ADMIN}/games/`);
		await adminReady(page);
		await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Costs' }).click();
		await adminReady(page);
		await expect(page.getByRole('heading', { name: 'AI costs in both apps', level: 1 })).toBeVisible();
		await expect(page.locator('.lead')).toContainText('the admin app and the games app');
		await expect(page.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#total')).toHaveText(/^est\. [$<][\d.]+ · \d+ AI calls?, /);
		await expect(page.getByText('Estimated from token and transaction counts at list prices; your Azure bill is the final word.')).toBeVisible();

		const apps = page.getByRole('list', { name: 'Cost by app' });
		await expect(apps.locator('li')).toHaveCount(2);
		await expect(apps.getByText('Admin app')).toBeVisible();
		await expect(apps.getByText('Games app')).toBeVisible();
		const areas = page.getByRole('list', { name: 'Cost by area' });
		await expect(areas.getByText('Story words')).toBeVisible();
		await expect(areas.getByText('Pictures')).toBeVisible();
		const reads = areas.locator('li', { hasText: 'Handwriting reading' });
		await expect(reads).toContainText('Letter Tracing · Games app');
		await expect(reads).toContainText(/est\. \$0\.00\d/);
		await expect(areas.locator('li', { hasText: 'Story words' })).toContainText('Time Detectives · Admin app');
		const games = page.getByRole('list', { name: 'Cost by game' });
		await expect(games.getByText('Time Detectives')).toBeVisible();
		await expect(games.getByText('Letter Tracing')).toBeVisible();

		const today = london({ day: 'numeric', month: 'short', year: 'numeric' });
		const days = page.locator('#periods > li');
		await expect(days).toHaveCount(1);
		await expect(page.locator('#quiet')).toHaveText(/^No AI spend on the other \d+ days in this range\.$/);
		await expect(days.first()).toContainText(today);
		await days.first().locator('summary').click();
		await expect(days.first().getByRole('list').getByText('Story words')).toBeVisible();
		await shot(page, `costs-day-${options.viewport.width}`);

		await page.getByRole('button', { name: 'Month' }).click();
		await expect(page.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('#periods-title')).toHaveText('By month');
		await expect(page.locator('#periods > li')).toHaveCount(1);
		await expect(page.locator('#quiet')).toHaveText(/^No AI spend on the other \d+ months in this range\.$/);
		await expect(page.locator('#periods > li').first()).toContainText(london({ month: 'long', year: 'numeric' }));
		await shot(page, `costs-month-${options.viewport.width}`);

		await page.getByRole('button', { name: 'Year' }).click();
		await expect(page.locator('#periods-title')).toHaveText('By year');
		await expect(page.locator('#periods > li').first()).toContainText(london({ year: 'numeric' }));
		await page.locator('#periods > li').first().locator('summary').click();
		await expect(page.locator('#periods > li').first().getByRole('list').getByText('Story words')).toBeVisible();
		expect(problems).toEqual([]);
		await page.context().close();
	});
}

test('with no spend yet the page says so instead of showing empty tables', async ({ browser }) => {
	const page = await adminPage(browser, SIZES[0].options);
	const zero = { microUsd: 0, calls: 0, text: 'est. $0.00' };
	await page.route('**/api/admin/portal/costs?*', (route) =>
		route.fulfill({ json: { by: 'day', from: '2026-10-01', to: '2026-10-23', total: zero, games: [], areas: [], periods: [{ period: '2026-10-23', total: zero, games: [], areas: [] }], priceVersions: [] } }),
	);
	await page.goto(`${ADMIN}/costs/`);
	await adminReady(page);
	await expect(page.getByText('No AI spend yet in this range.')).toBeVisible();
	await expect(page.locator('#total')).toHaveText('est. $0.00 · 0 AI calls, 1 Oct 2026 to 23 Oct 2026');
	await expect(page.locator('#breakdown')).toBeHidden();
	await expect(page.locator('#periods > li')).toHaveCount(0);
	await shot(page, 'costs-empty-820');
	await page.context().close();
});
