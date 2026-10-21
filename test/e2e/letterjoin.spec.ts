import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const KID_EMAIL = `kid-${RUN}@example.com`;
const KID_NAME = `Mia${RUN}`;
const TITLE = `Zebras ${RUN}`;
const RENAMED = `Zebras leap ${RUN}`;

type Point = { x: number; y: number };

/** Vertical hatching across every inked cell of the outline, close enough to score, in page coordinates. */
async function outlineStrokes(page: Page): Promise<Point[][]> {
	return page.evaluate(() => {
		const tracing = (window as unknown as { __tracing: { mask(): { width: number; height: number; data: ArrayLike<number> }; gridScale: number; layout(): { width: number } } }).__tracing;
		const mask = tracing.mask();
		const rect = document.getElementById('sheet')!.getBoundingClientRect();
		const scale = rect.width / tracing.layout().width;
		const toPage = (gx: number, gy: number) => ({ x: rect.left + (gx / tracing.gridScale) * scale, y: rect.top + (gy / tracing.gridScale) * scale });
		const strokes: { x: number; y: number }[][] = [];
		for (let x = 0; x < mask.width; x += 3) {
			let y = 0;
			while (y < mask.height) {
				if (!mask.data[y * mask.width + x]) {
					y++;
					continue;
				}
				const top = y;
				while (y < mask.height && mask.data[y * mask.width + x]) y++;
				strokes.push([toPage(x, top), toPage(x, y - 1)]);
			}
		}
		return strokes;
	});
}

async function handwriting(page: Page): Promise<Point[][]> {
	return page.evaluate(() => {
		const tracing = (window as unknown as { __tracing: { layout(): { width: number; padX: number; xHeight: number; lines: { baseline: number }[] } } }).__tracing;
		const layout = tracing.layout();
		const rect = document.getElementById('sheet')!.getBoundingClientRect();
		const scale = rect.width / layout.width;
		const baseline = layout.lines[0]!.baseline;
		return Array.from({ length: 4 }, (_, word) =>
			Array.from({ length: 13 }, (_, i) => ({
				x: rect.left + (layout.padX + word * layout.xHeight * 4 + i * layout.xHeight * 0.25) * scale,
				y: rect.top + (baseline - (i % 2 ? layout.xHeight : 0)) * scale,
			})),
		);
	});
}

async function draw(page: Page, strokes: readonly Point[][]): Promise<void> {
	for (const stroke of strokes) {
		const [first, ...rest] = stroke;
		if (!first) continue;
		await page.mouse.move(first.x, first.y);
		await page.mouse.down();
		for (const point of rest) await page.mouse.move(point.x, point.y);
		await page.mouse.up();
	}
}

test('a child traces what an admin wrote and finds it in their progress, and the admin edits it, reviews the copy and reads the practice report', async ({ browser }) => {
	test.setTimeout(240_000);
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const kidContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 } });
	const admin = await adminContext.newPage();
	const kid = await kidContext.newPage();
	answerPopups(admin);
	const problems = collectProblems([admin, kid]);

	await test.step('the admin gives a child Letter Tracing and links their account', async () => {
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await adminReady(admin);
		await expect(admin.getByRole('heading', { name: 'Members' })).toBeVisible();
		const add = admin.getByRole('region', { name: 'Add a member' });
		await add.getByLabel('Email').fill(KID_EMAIL);
		await add.getByLabel('Letter Tracing').check();
		await add.getByRole('button', { name: 'Save member' }).click();
		await expect(admin.getByRole('status')).toHaveText(`Saved ${KID_EMAIL}.`);
		await admin.getByRole('button', { name: `Sync ${KID_EMAIL} with Entra` }).click();
		await expect(admin.getByRole('status')).toHaveText('Synced with Entra.');
	});

	await test.step('the child signs in and chooses a name', async () => {
		await kid.goto(`${GAMES}/`);
		await signInAtFakeEntra(kid, KID_EMAIL);
		await kid.getByLabel('Your name in games').fill(KID_NAME);
		await kid.getByRole('button', { name: "Let's play" }).click();
		await expect(kid.getByRole('list', { name: 'My games' }).getByRole('link', { name: /Letter Tracing/ })).toBeVisible();
	});

	await test.step('the admin sets a daily practice goal and writes a sentence to trace, then copy', async () => {
		await admin.goto(`${ADMIN}/g/letterjoin/#settings`);
		await adminReady(admin);
		await expect(admin.locator('#s-summary')).not.toBeEmpty();
		await admin.locator('#s-minutes').fill('15');
		await admin.locator('#s-save').click();
		await expect(admin.locator('#status')).toContainText('Saved.');
		await admin.getByRole('link', { name: /^Activities/ }).click();
		await admin.locator('#new-activity').click();
		await admin.locator('#f-type').selectOption('sentence');
		await admin.locator('#f-title').fill(TITLE);
		await admin.locator('#f-status').selectOption('published');
		await admin.locator('#f-mode').selectOption('traceThenCopy');
		await admin.locator('#f-sentence').fill('Zebras jump.');
		await admin.locator('#f-save').click();
		await expect(admin.locator('#activities .card .title', { hasText: TITLE })).toBeVisible();
	});

	await test.step('the admin edits the title, and the card keeps its place', async () => {
		const card = admin.locator('#activities .card', { hasText: TITLE });
		await card.getByRole('button', { name: 'Edit' }).click();
		await expect(admin.locator('#f-preview')).toBeVisible();
		await admin.locator('#f-title').fill(RENAMED);
		await admin.locator('#f-save').click();
		await expect(admin.locator('#activities .card .title', { hasText: RENAMED })).toBeVisible();
		await expect(admin.locator('#activities .card .title', { hasText: TITLE, hasNotText: 'leap' })).toHaveCount(0);
	});

	await test.step('the child traces it and the result is saved', async () => {
		await kid.goto(`${GAMES}/g/letterjoin/?debug=1`);
		await kid.locator('.activity-card', { hasText: RENAMED }).click();
		await kid.waitForFunction(() => Boolean((window as unknown as { __tracing?: { layout(): unknown } }).__tracing?.layout()) && !document.getElementById('trace-screen')!.hidden);
		await draw(kid, await outlineStrokes(kid));
		await kid.locator('#finish').click();
		await kid.waitForFunction(() => (window as unknown as { __tracing: { state(): { phase: string } } }).__tracing.state().phase === 'scored');
		await expect(kid.locator('#save-message')).toHaveText('Result saved.');
		expect(Number(await kid.locator('#score').innerText())).toBeGreaterThan(40);
	});

	await test.step('the child writes a copy unaided and it is sent', async () => {
		await kid.locator('#start-copy').click();
		await kid.waitForFunction(() => (window as unknown as { __tracing: { state(): { phase: string } } }).__tracing.state().phase === 'copying');
		await draw(kid, await handwriting(kid));
		const sent = kid.waitForResponse((response) => response.url().endsWith('/submission') && response.request().method() === 'POST');
		await kid.locator('#copy-done').click();
		expect((await sent).status()).toBe(201);
	});

	await test.step('the result is in the child\'s progress', async () => {
		await kid.locator('#back-to-list').click();
		await expect(kid.locator('.activity-card[data-done]', { hasText: RENAMED })).toBeVisible();
		await kid.locator('#progress-open').click();
		const today = kid.locator('.pg-day', { has: kid.getByRole('heading', { name: 'Today' }) });
		await expect(today).toContainText('1 activity');
		await kid.goto('about:blank');
	});

	await test.step('the admin reviews the copy under the child\'s name', async () => {
		await admin.goto(`${ADMIN}/g/letterjoin/#review`);
		await admin.reload();
		const copy = admin.locator('#submissions .review', { hasText: KID_NAME });
		await expect(copy).toContainText(RENAMED);
		await expect.poll(() => copy.locator('img.thumb').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
		await copy.getByLabel('Note').fill('Neat joins.');
		await copy.getByLabel('Reviewed').check();
		await expect(admin.locator('#status')).toContainText(`Saved the review of ${KID_NAME}`);
		await expect(copy).toContainText('Reviewed ');
		await admin.reload();
		await expect(admin.locator('#submissions .review', { hasText: KID_NAME }).getByLabel('Reviewed')).toBeChecked();
	});

	await test.step('the admin sees the child\'s practice and progress', async () => {
		await admin.goto(`${ADMIN}/g/letterjoin/#practice`);
		await adminReady(admin);
		const row = admin.locator('#practice-body tr', { has: admin.getByRole('rowheader', { name: KID_NAME }) });
		await expect(row).toBeVisible();
		await expect(row.locator('td').nth(6)).not.toHaveText('–');
		await admin.getByRole('link', { name: 'Progress' }).click();
		await admin.locator('#p-child').selectOption({ label: KID_NAME });
		await admin.getByRole('button', { name: 'Show' }).click();
		await expect(admin.locator('#progress-status')).toHaveText(`Progress of ${KID_NAME}`);
		await expect(admin.locator('#progress-days .day')).toHaveCount(1);
	});

	expect(problems).toEqual([]);
	await adminContext.close();
	await kidContext.close();
});
