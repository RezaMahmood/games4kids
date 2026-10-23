import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const SHOTS = process.env['G4K_SHOTS'];
const RUN = Date.now().toString(36);
const TOPIC = `Saxons ${RUN}`;
const TOPICS_API = /\/api\/g\/timedetectives\/topics$/;
const BOARD_API = /\/api\/g\/timedetectives\/board\?/;

test.describe.configure({ mode: 'serial' });

let admin: Page;
let kid: Page;
let problems: string[];

test.beforeAll(async ({ browser }, testInfo) => {
	testInfo.setTimeout(180_000);
	admin = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
	answerPopups(admin);
	admin.on('dialog', (dialog) => dialog.accept());
	await admin.goto(`${ADMIN}/`);
	await signInAtFakeEntra(admin, ADMIN_EMAIL);
	await adminReady(admin);
	kid = await namedChild(browser, admin, `saxon-${RUN}@example.com`, `Alfred${RUN}`, 'Time Detectives', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	problems = collectProblems([admin, kid]);

	await admin.goto(`${ADMIN}/g/timedetectives/`);
	await adminReady(admin);
	await admin.getByRole('button', { name: 'New topic' }).click();
	await admin.getByLabel('Title', { exact: true }).fill(TOPIC);
	await admin.getByRole('button', { name: 'Save topic' }).click();
	await expect(admin.locator('#topic-heading')).toHaveText(TOPIC);
	await admin.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(admin.locator('#rounds .badge.draft')).toBeVisible();
	await admin.getByRole('link', { name: 'The raid on Lindisfarne', exact: true }).click();
	await expect(admin.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
	await admin.getByRole('button', { name: 'Publish', exact: true }).click();
	await expect(admin.locator('#round-badge')).toHaveText('Published');
});

test.afterAll(async () => {
	expect(problems).toEqual([]);
	await kid.context().close();
	await admin.context().close();
});

const shot = (name: string, width: number) => (SHOTS ? kid.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: true }) : Promise.resolve());

async function home(width: number): Promise<void> {
	await kid.setViewportSize({ width, height: 844 });
	await kid.goto(`${GAMES}/g/timedetectives/`);
	await pageReady(kid);
}

async function toQuiz(): Promise<void> {
	await kid.getByRole('button', { name: 'Open the door to the past' }).click();
	await kid.getByRole('button', { name: new RegExp(TOPIC) }).click();
	await kid.getByRole('button', { name: /I know a bit about the subject/ }).click();
	await kid.getByRole('button', { name: "I've read it" }).click();
}

async function answerAll(): Promise<void> {
	for (const [label, answer] of [['Who is it?', 'Vikings'], ['Where is it?', 'Lindisfarne'], ['When was it?', 'AD 793']] as const) {
		await kid.locator('.question', { hasText: label }).getByRole('button', { name: answer, exact: true }).click();
	}
}

for (const width of [390, 820]) {
	test(`at ${width}px, a child whose mystery is taken down while they solve it is told kindly and offered another, not a retry`, async () => {
		await home(width);
		await toQuiz();
		await answerAll();
		await admin.getByRole('button', { name: 'Unpublish' }).click();
		await expect(admin.locator('#round-badge')).toHaveText('Draft');

		await kid.getByRole('button', { name: 'See my points' }).click();
		await expect(kid.getByRole('alert')).toHaveText('A grown-up changed this mystery while you were solving it, so it cannot be scored. Sorry! Try another one.');
		await expect(kid.getByRole('button', { name: 'See my points' })).toBeHidden();
		await shot('play-round-changed', width);
		await kid.getByRole('button', { name: 'Play another' }).click();
		await expect(kid.locator('#topics-panel')).toBeVisible();

		await admin.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(admin.locator('#round-badge')).toHaveText('Published');
	});
}

for (const width of [390, 820]) {
	test(`at ${width}px, a child whose mystery is reworded while they solve it is told kindly, not marked against words they never read`, async () => {
		await home(width);
		await toQuiz();
		await answerAll();
		await admin.locator('#r-brief').fill(`The bells were still ringing at ${width}.`);
		await Promise.all([admin.waitForResponse((res) => res.request().method() === 'PUT' && res.ok()), admin.getByRole('button', { name: 'Save', exact: true }).click()]);

		await kid.getByRole('button', { name: 'See my points' }).click();
		await expect(kid.getByRole('alert')).toHaveText('A grown-up changed this mystery while you were solving it, so it cannot be scored. Sorry! Try another one.');
		await expect(kid.getByRole('button', { name: 'Play another' })).toBeFocused();
		await shot('play-round-reworded', width);
	});
}

for (const width of [390, 820]) {
	test(`at ${width}px, focus follows the child through every screen, onto the next open choice after a wrong one, and onto the hint they asked for`, async () => {
		await home(width);
		const focused = () => kid.evaluate(() => {
			const active = document.activeElement;
			return { id: active?.id ?? '', className: active?.className ?? '', text: active?.textContent?.trim() ?? '', question: active?.closest('.question')?.querySelector('h3')?.textContent ?? '' };
		});
		await kid.getByRole('button', { name: 'Open the door to the past' }).click();
		await expect(kid.locator('#topics-heading')).toBeFocused();
		await kid.getByRole('button', { name: new RegExp(TOPIC) }).click();
		await expect(kid.locator('#sure-heading')).toBeFocused();
		await kid.getByRole('button', { name: /I know a bit about the subject/ }).click();
		await expect(kid.locator('#read-heading')).toBeFocused();
		await kid.getByRole('button', { name: "I've read it" }).click();
		await expect(kid.locator('#quiz-heading')).toBeFocused();

		const who = kid.locator('.question', { hasText: 'Who is it?' });
		await who.getByRole('button', { name: 'Romans' }).click();
		const next = await focused();
		expect([next.question, next.className.includes('choice'), next.text === 'Romans'], 'focus is on another choice in the same question').toEqual(['Who is it?', true, false]);
		await expect(kid.locator(':focus')).toBeEnabled();
		await who.getByRole('button', { name: 'Vikings' }).click();
		await expect(who.locator('.feedback')).toBeFocused();

		const where = kid.locator('.question', { hasText: 'Where is it?' });
		await where.getByRole('button', { name: /Show a hint/ }).click();
		await expect(where.locator('.hint-text')).toBeFocused();
		await shot('play-focus-hint', width);
		await where.getByRole('button', { name: 'Lindisfarne' }).click();
		await kid.locator('.question', { hasText: 'When was it?' }).getByRole('button', { name: 'AD 793' }).click();
		await expect(kid.getByRole('button', { name: 'See my points' })).toBeFocused();
		await kid.getByRole('button', { name: 'See my points' }).click();
		await expect(kid.locator('#result-heading')).toBeFocused();
		await shot('play-focus-result', width);
	});
}

for (const width of [390, 820]) {
	test(`at ${width}px, topics that fail to load say so in the topics panel and load again on Try again`, async () => {
		let failures = 1;
		await kid.route(TOPICS_API, (route) => (failures-- > 0 ? route.fulfill({ status: 503, json: { error: 'storage_down', message: 'The mysteries are locked away for a moment.' } }) : route.fallback()));
		await home(width);
		await kid.getByRole('button', { name: 'Open the door to the past' }).click();
		await expect(kid.locator('#topics-status')).toHaveText('The mysteries are locked away for a moment. Press Try again.');
		await expect(kid.getByText('There are no mysteries yet')).toHaveCount(0);
		await shot('play-topics-failed', width);
		await kid.getByRole('button', { name: 'Try again' }).click();
		await expect(kid.getByRole('button', { name: new RegExp(TOPIC) })).toBeVisible();
		await expect(kid.locator('#topics-status')).toBeHidden();
		await kid.unroute(TOPICS_API);
	});
}

for (const width of [390, 820]) {
	test(`at ${width}px, the board switch shows what was saved and stays usable when the board then fails to load`, async () => {
		await home(width);
		await toQuiz();
		await answerAll();
		await kid.getByRole('button', { name: 'See my points' }).click();
		const toggle = kid.getByRole('switch', { name: 'Show my scores on the board' });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');

		await kid.route(BOARD_API, (route) => route.fulfill({ status: 503, json: { error: 'storage_down', message: 'The board is resting.' } }));
		await toggle.click();
		await expect(kid.locator('#board-status')).toHaveText('The board is resting.');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(toggle).toBeEnabled();
		await shot('play-board-failed', width);
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(toggle).toBeEnabled();
		await kid.unroute(BOARD_API);
	});
}
