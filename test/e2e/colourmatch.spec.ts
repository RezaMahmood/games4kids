import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const SHOTS = process.env['G4K_SHOTS'];
const RUN = Date.now().toString(36);
const KID = `Iris${RUN}`;

test.describe.configure({ mode: 'serial' });

let admin: Page;
let kid: Page;
let problems: string[];
/** Games the child finished, as [mode, words played], oldest first, so the admin's table can be checked against them. */
const played: [string, number][] = [];

test.beforeAll(async ({ browser }, testInfo) => {
	testInfo.setTimeout(180_000);
	admin = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
	answerPopups(admin);
	await admin.goto(`${ADMIN}/`);
	await signInAtFakeEntra(admin, ADMIN_EMAIL);
	await adminReady(admin);
	kid = await namedChild(browser, admin, `iris-${RUN}@example.com`, KID, 'Colour Match', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	problems = collectProblems([admin, kid]);
});

test.afterAll(async () => {
	expect(problems).toEqual([]);
	await kid.context().close();
	await admin.context().close();
});

const shot = (page: Page, name: string) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());
const screen = () => kid.locator('#game-screen');
const word = () => kid.locator('#word');

/** Waits for a word to be on screen and says which colour the child must tap for `mode`. */
async function nextWord(mode: 'normal' | 'hard'): Promise<string> {
	await expect(screen()).toHaveAttribute('data-phase', 'showing');
	const right = await word().getAttribute(mode === 'normal' ? 'data-word' : 'data-ink');
	expect(right, 'the word carries its colour and ink').toBeTruthy();
	return right ?? '';
}

async function tapSquare(colour: string): Promise<void> {
	await kid.locator(`.square[data-colour="${colour}"]`).click();
	await expect(screen(), 'the tap is answered at once').toHaveAttribute('data-phase', /feedback|roundIntro|over/);
}

async function tapWrong(right: string): Promise<void> {
	await kid.locator(`.square:not([data-colour="${right}"])`).first().click();
}

async function home(width: number): Promise<void> {
	await kid.setViewportSize({ width, height: width > 600 ? 1180 : 844 });
	await kid.goto(`${GAMES}/g/colourmatch/`);
	await pageReady(kid);
}

for (const width of [390, 820]) {
	test(`at ${width}px, a child plays normal mode through round 1 by the word, sees the clock and the round intro, and three mistakes end the game with a saved score`, async () => {
		await home(width);
		await expect(kid.getByRole('button', { name: /^Hard/ })).toContainText('written in');
		await kid.getByRole('button', { name: /^Normal/ }).click();
		await expect(kid.locator('#round-intro-heading')).toHaveText('Round 1');
		await expect(kid.locator('#round-intro-detail')).toHaveText('5 words, 20 seconds');

		let right = await nextWord('normal');
		expect(await word().getAttribute('data-ink'), 'the opening word matches its ink').toBe(right);
		await expect(kid.locator('#hud-clock')).toHaveText(/^(19|20)$/);
		await expect(kid.locator('.square')).toHaveCount(4);
		expect(new Set(await kid.locator('.square').evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset['colour']))).size, 'four different colours').toBe(4);
		await shot(kid, `game-${width}`);
		for (let i = 0; i < 5; i++) {
			if (i > 0) right = await nextWord('normal');
			await tapSquare(right);
		}
		await expect(kid.locator('#hud-score')).not.toHaveText('0');
		const score = Number(await kid.locator('#hud-score').textContent());
		expect(score).toBeGreaterThan(300);
		await expect(kid.locator('#round-intro-heading')).toHaveText('Round 2');
		await expect(kid.locator('#round-intro-detail')).toHaveText('6 words, 22 seconds');
		await expect(kid.locator('#hud-round')).toHaveText('2');

		for (let i = 0; i < 3; i++) {
			right = await nextWord('normal');
			await tapWrong(right);
			if (i < 2) await expect(kid.locator('#hud-mistakes')).toHaveAttribute('aria-label', `${i + 1} of 3 mistakes in a row`);
		}
		await expect(kid.getByRole('heading', { name: /points$/ })).toBeVisible();
		await expect(kid.locator('#over-why')).toHaveText('3 mistakes in a row.');
		await expect(kid.locator('#over-rounds')).toHaveText('You reached round 2 and got 5 words right.');
		await expect(kid.locator('#over-best')).toHaveText(/^Your best today is \d+\.$/);
		await expect(kid.locator('#over-score')).toHaveText(String(score));
		await shot(kid, `over-${width}`);
		played.push(['normal', 8]);
	});
}

test('in hard mode the ink is the answer, and the game is scored half again', async () => {
	await home(820);
	await kid.getByRole('button', { name: /^Hard/ }).click();
	let right = await nextWord('hard');
	await tapSquare(right);
	await expect(kid.locator('#hud-score')).toHaveText(/^1[0-9]{2}$/);
	for (let i = 0; i < 3; i++) {
		right = await nextWord('hard');
		await tapWrong(right);
	}
	await expect(kid.locator('#over-why')).toHaveText('Hard mode. 3 mistakes in a row.');
	await expect(kid.locator('#over-best')).toHaveText(/^Your best today is \d+\.$/);
	played.push(['hard', 4]);
});

test('the child can switch the board on from the game over screen and sees their best today on it', async () => {
	await kid.getByRole('switch', { name: 'Show my scores on the board' }).click();
	await expect(kid.getByRole('switch', { name: 'Show my scores on the board' })).toHaveAttribute('aria-checked', 'true');
	const row = kid.locator('#board-rows tr.me');
	await expect(row).toContainText(`${KID} (you)`);
	const best = (await kid.locator('#over-best').textContent())?.match(/\d+/)?.[0];
	await expect(row.locator('td').first()).toHaveText(best ?? 'none');
});

for (const { width, options } of [
	{ width: 390, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
	{ width: 820, options: { viewport: { width: 820, height: 1180 } } },
]) {
	test(`at ${width}px, the admin finds the child's games in Metrics, newest first, and opens one game's turns`, async ({ browser }) => {
		const page = await (await browser.newContext({ ignoreHTTPSErrors: true, ...options })).newPage();
		await page.goto(`${ADMIN}/`);
		await signInAtFakeEntra(page, ADMIN_EMAIL);
		await adminReady(page);
		await page.goto(`${ADMIN}/g/colourmatch/#metrics`);
		await adminReady(page);
		await page.locator('#child').selectOption({ label: KID });
		const rows = page.locator('#game-rows tr');
		await expect(rows).toHaveCount(played.length);
		await expect(rows.first().locator('td').nth(1)).toHaveText(played.at(-1)?.[0] ?? '');
		await expect(rows.first().locator('td').nth(4)).toHaveText(String(played.at(-1)?.[1]));
		await expect(rows.last().locator('td').nth(10)).toHaveText('mistakes');
		await shot(page, `admin-metrics-${width}`);
		await rows.first().getByRole('button', { name: /^Turns/ }).click();
		await expect(page.locator('#turns-heading')).toContainText(`${KID}, ${played.at(-1)?.[0]} mode`);
		await expect(page.locator('#turn-rows tr')).toHaveCount(played.at(-1)?.[1] ?? 0);
		await expect(page.locator('#turn-rows tr').first().locator('td').nth(4)).toHaveText('Yes');
		await expect(page.locator('#turn-rows tr').last().locator('td').nth(4)).toHaveText('No');
		await shot(page, `admin-turns-${width}`);
		await page.context().close();
	});
}

test('the admin downloads every summary as a CSV with a row per game', async () => {
	await admin.goto(`${ADMIN}/g/colourmatch/#metrics`);
	await adminReady(admin);
	const download = admin.waitForEvent('download');
	await admin.getByRole('button', { name: 'Download every summary as CSV' }).click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(/^colourmatch-games-\d{4}-\d{2}-\d{2}\.csv$/);
	const text = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8');
	const lines = text.trimEnd().split('\r\n');
	expect(lines[0]).toMatch(/^userId,name,gameId,savedAt,/);
	expect(lines.filter((line) => line.includes(`,${KID},`))).toHaveLength(played.length);
});

test('the admin saves a new settings version with a live preview, a bad value is refused in the form, and the child plays under the new version', async () => {
	await admin.goto(`${ADMIN}/g/colourmatch/#settings`);
	await adminReady(admin);
	await expect(admin.locator('#preview-rows tr')).toHaveCount(12);
	await expect(admin.locator('#preview-rows tr').first().locator('td').nth(3)).toHaveText('20.0 s');
	await admin.getByLabel(/^Seconds per word in round 1/).fill('5');
	await expect(admin.locator('#preview-rows tr').first().locator('td').nth(3)).toHaveText('25.0 s');
	await admin.getByLabel(/^Most words in a round/).fill('2');
	await expect(admin.locator('#tuning-problems')).toContainText('firstTurns must be at most maxTurns');
	await admin.getByRole('button', { name: 'Save as a new version' }).click();
	await expect(admin.locator('#versions li')).toHaveCount(0);
	await admin.getByLabel(/^Most words in a round/).fill('10');
	await expect(admin.locator('#tuning-problems')).toBeHidden();
	await admin.getByRole('button', { name: 'Save as a new version' }).click();
	await expect(admin.getByRole('status')).toContainText('Saved.');
	await expect(admin.locator('#versions li')).toHaveCount(1);
	await expect(admin.locator('#versions li').first()).toContainText('firstSecondsPerTurn 5');
	await shot(admin, 'admin-settings');

	await home(390);
	await kid.getByRole('button', { name: /^Normal/ }).click();
	await expect(kid.locator('#round-intro-detail')).toHaveText('5 words, 25 seconds');
});
