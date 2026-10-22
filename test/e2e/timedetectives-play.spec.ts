import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const SHOTS = process.env['G4K_SHOTS'];
const RUN = Date.now().toString(36);
const TOPIC = `Saxons ${RUN}`;

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
	await admin.getByRole('link', { name: TOPIC }).click();
	await admin.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(admin.locator('#rounds .badge.draft')).toBeVisible();
	await admin.getByRole('link', { name: 'The raid on Lindisfarne' }).click();
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
