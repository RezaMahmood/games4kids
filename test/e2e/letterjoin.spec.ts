import { expect, test, type Page } from '@playwright/test';
import { addAndSync, ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, pageReady, signInAtFakeEntra } from './support.ts';

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

/** A writing hand rests on the bottom third of the screen, so taps all over it must never end the attempt. */
async function restPalm(page: Page): Promise<void> {
	const { width, height } = page.viewportSize()!;
	for (let y = Math.round((height * 2) / 3); y < height; y += 40) {
		for (let x = 20; x < width; x += 60) await page.touchscreen.tap(x, y);
	}
}

const phase = (page: Page) => page.evaluate(() => (window as unknown as { __tracing: { state(): { phase: string } } }).__tracing.state().phase);

test('a child traces what an admin wrote and finds it in their progress, and the admin edits it, reviews the copy and reads the practice report', async ({ browser }) => {
	test.setTimeout(240_000);
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const kidContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 }, hasTouch: true });
	const admin = await adminContext.newPage();
	const kid = await kidContext.newPage();
	answerPopups(admin);
	const problems = collectProblems([admin, kid]);

	await test.step('the admin gives a child Letter Tracing and links their account', async () => {
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await adminReady(admin);
		await expect(admin.getByRole('heading', { name: 'Members' })).toBeVisible();
		await addAndSync(admin, KID_EMAIL, 'Letter Tracing');
	});

	await test.step('the child signs in and chooses a name', async () => {
		await kid.goto(`${GAMES}/`);
		await signInAtFakeEntra(kid, KID_EMAIL);
		await pageReady(kid);
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
		await expect(admin.getByRole('dialog', { name: 'New activity' })).toBeVisible();
		await admin.locator('#f-type').selectOption('sentence');
		await admin.locator('#f-title').fill(TITLE);
		await admin.locator('#f-status').selectOption('published');
		await admin.locator('#f-mode').selectOption('traceThenCopy');
		await admin.locator('#f-sentence').fill('Zebras jump.');
		await admin.locator('#f-save').click();
		await expect(admin.getByRole('dialog')).toBeHidden();
		await expect(admin.locator('#activities .card .title', { hasText: TITLE })).toBeInViewport({ ratio: 1 });
	});

	await test.step('the admin edits the title, and the card keeps its place', async () => {
		const card = admin.locator('#activities .card', { hasText: TITLE });
		await card.getByRole('button', { name: 'Edit', exact: true }).click();
		await expect(admin.getByRole('dialog', { name: `Edit "${TITLE}"` })).toBeVisible();
		await expect(admin.locator('#f-preview')).toBeVisible();
		await admin.locator('#f-title').fill(RENAMED);
		await admin.locator('#f-save').click();
		await expect(admin.getByRole('dialog')).toBeHidden();
		await expect(admin.locator('#activities .card .title', { hasText: RENAMED })).toBeInViewport({ ratio: 1 });
		await expect(admin.locator('#activities .card .title', { hasText: TITLE, hasNotText: 'leap' })).toHaveCount(0);
	});

	await test.step('the child switches on the Friends board, which has no scores yet', async () => {
		await kid.goto(`${GAMES}/g/letterjoin/`);
		await pageReady(kid);
		await kid.locator('#board-open').click();
		const toggle = kid.getByRole('switch', { name: 'Show my scores on the board' });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect(kid.locator('#bd-explain')).toBeVisible();
		await expect(kid.locator('.bd-level')).toHaveCount(0);
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(kid.locator('#bd-explain')).toBeHidden();
		await expect(kid.locator('.bd-level')).toHaveCount(3);
		await expect(kid.locator('.bd-level .empty')).toHaveCount(3);
	});

	await test.step('the child traces it and the result is saved', async () => {
		await kid.goto(`${GAMES}/g/letterjoin/?debug=1`);
		await expect(kid.getByRole('heading', { level: 1 })).toHaveText('Letter Tracing');
		await kid.locator('.activity-card', { hasText: RENAMED }).click();
		await kid.waitForFunction(() => Boolean((window as unknown as { __tracing?: { layout(): unknown } }).__tracing?.layout()) && !document.getElementById('trace-screen')!.hidden);
		await draw(kid, await outlineStrokes(kid));
		await restPalm(kid);
		expect(await phase(kid)).toBe('tracing');
		const ask = kid.getByRole('dialog', { name: 'Finished tracing?' });
		await kid.locator('#finish').click();
		await ask.getByRole('button', { name: 'Keep tracing' }).click();
		await expect(ask).toBeHidden();
		expect(await phase(kid)).toBe('tracing');
		await kid.locator('#back').click();
		await kid.getByRole('dialog', { name: 'Leave this activity?' }).getByRole('button', { name: 'Keep going' }).click();
		expect(await phase(kid)).toBe('tracing');
		await kid.locator('#finish').click();
		await ask.getByRole('button', { name: "Yes, I've finished" }).click();
		await kid.waitForFunction(() => (window as unknown as { __tracing: { state(): { phase: string } } }).__tracing.state().phase === 'scored');
		await expect(kid.locator('#save-message')).toHaveText('Result saved.');
		expect(Number(await kid.locator('#score').innerText())).toBeGreaterThan(40);
	});

	await test.step('the child writes a copy unaided and it is sent', async () => {
		await kid.locator('#start-copy').click();
		await kid.waitForFunction(() => (window as unknown as { __tracing: { state(): { phase: string } } }).__tracing.state().phase === 'copying');
		await draw(kid, await handwriting(kid));
		await restPalm(kid);
		expect(await phase(kid)).toBe('copying');
		const sent = kid.waitForResponse((response) => response.url().endsWith('/submission') && response.request().method() === 'POST');
		await kid.locator('#copy-done').click();
		await kid.getByRole('dialog', { name: 'Finished writing?' }).getByRole('button', { name: 'Yes, send it' }).click();
		expect((await sent).status()).toBe(201);
	});

	await test.step('in hard mode, nothing at the bottom of the screen ends the writing, and Done and Back ask first', async () => {
		await kid.locator('#back-to-list').click();
		const toggle = kid.locator('.card-slot', { hasText: RENAMED }).locator('.hard-toggle');
		await toggle.click();
		await kid.locator('.activity-card', { hasText: RENAMED }).click();
		await expect(kid.locator('#write-screen')).toBeVisible();
		const pad = (await kid.locator('#write-pad').boundingBox())!;
		await draw(kid, [[{ x: pad.x + 60, y: pad.y + pad.height / 2 }, { x: pad.x + 160, y: pad.y + pad.height / 2 }]]);
		await restPalm(kid);
		await expect(kid.locator('#write-results')).toBeHidden();
		await kid.locator('#write-done').click();
		await kid.getByRole('dialog', { name: 'Finished writing?' }).getByRole('button', { name: 'Keep writing' }).click();
		await expect(kid.locator('#write-done')).toHaveText('Done');
		await kid.locator('#write-back').click();
		await kid.getByRole('dialog', { name: 'Leave this activity?' }).getByRole('button', { name: 'Yes, leave' }).click();
		await expect(kid.locator('#list-screen')).toBeVisible();
		await toggle.click();
	});

	await test.step('the result is in the child\'s progress', async () => {
		await expect(kid.locator('.activity-card[data-done]', { hasText: RENAMED })).toBeVisible();
		await kid.locator('#progress-open').click();
		const today = kid.locator('.pg-day', { has: kid.getByRole('heading', { name: 'Today' }) });
		await expect(today).toContainText('1 activity');
	});

	await test.step('the child is on the Friends board with the points just scored', async () => {
		await kid.locator('#pg-back').click();
		await kid.locator('#board-open').click();
		const mine = kid.locator('.bd-table tr.me', { has: kid.getByRole('rowheader', { name: KID_NAME }) });
		await expect(mine).toHaveCount(1);
		await expect(mine.locator('td').nth(6)).not.toHaveText('–');
		await expect(mine.locator('td.total')).not.toHaveText('–');
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

const DIALOG_SIZES = {
	desktop: { viewport: { width: 1280, height: 800 } },
	phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

for (const [size, options] of Object.entries(DIALOG_SIZES)) {
	test(`on ${size}, creating and editing an activity happens in a dialog over the list`, async ({ browser }) => {
		test.setTimeout(120_000);
		const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
		const page = await context.newPage();
		answerPopups(page);
		const problems = collectProblems([page]);
		const asked: string[] = [];
		let discard = true;
		page.on('dialog', (native) => {
			asked.push(native.message());
			void (discard ? native.accept() : native.dismiss());
		});
		const stamp = `${size}-${RUN}`;
		const title = `Dialog ${stamp}`;
		const dialog = page.getByRole('dialog', { name: 'New activity' });
		const newButton = page.locator('#new-activity');
		const card = (text: string) => page.locator('#activities .card', { hasText: text });
		const scrollY = () => page.evaluate(() => window.scrollY);

		await page.goto(`${ADMIN}/`);
		await signInAtFakeEntra(page, ADMIN_EMAIL);
		await adminReady(page);
		await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
		await page.goto(`${ADMIN}/g/letterjoin/#activities`);
		await adminReady(page);
		await expect(page.locator('#activities .group').first()).toBeVisible();

		const fill = async (name: string, sentence = 'The quick brown fox.') => {
			await page.locator('#f-type').selectOption('sentence');
			await page.locator('#f-level').selectOption('starter');
			await page.locator('#f-title').fill(name);
			await page.locator('#f-sentence').fill(sentence);
		};

		await test.step('the list is long enough to scroll', async () => {
			for (let i = 0; i < 8; i++) {
				await newButton.click();
				await expect(dialog).toBeVisible();
				await fill(`Filler ${i} ${stamp}`);
				await page.locator('#f-save').click();
				await expect(dialog).toBeHidden();
				await expect(card(`Filler ${i} ${stamp}`)).toBeVisible();
			}
			await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			expect(await scrollY()).toBeGreaterThan(0);
		});

		await test.step('New activity is reachable from the scrolled list and opens a labelled, focused modal', async () => {
			await expect(newButton).toBeInViewport({ ratio: 1 });
			await newButton.click();
			await expect(dialog).toBeVisible();
			await expect(dialog).toBeInViewport({ ratio: 1 });
			if (size === 'phone') {
				const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inDialog: document.getElementById('activity-dialog')!.contains(document.activeElement) }));
				expect(focus.tag).not.toMatch(/^(INPUT|TEXTAREA|SELECT)$/);
				expect(focus.inDialog).toBe(true);
			} else await expect(page.locator('#f-title')).toBeFocused();
			const box = (await dialog.boundingBox())!;
			if (size === 'phone') expect([box.width, box.height]).toEqual([390, 844]);
			else {
				expect(box.width).toBeLessThan(1280);
				expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2);
			}
			for (const control of [page.locator('#f-save'), page.locator('#f-cancel')]) {
				const { height } = (await control.boundingBox())!;
				expect(height).toBeGreaterThanOrEqual(44);
				await expect(control).toBeInViewport({ ratio: 1 });
			}
			expect(await dialog.evaluate((el: HTMLDialogElement) => el.matches(':modal'))).toBe(true);
		});

		await test.step('Escape on an untouched form closes it without asking and returns focus', async () => {
			await page.keyboard.press('Escape');
			await expect(dialog).toBeHidden();
			await expect(newButton).toBeFocused();
			expect(asked).toEqual([]);
		});

		await test.step('cancelling a changed form asks first, and keeps the work when the answer is no', async () => {
			await newButton.click();
			await page.locator('#f-title').fill('Half written');
			discard = false;
			await page.locator('#f-cancel').click();
			await expect.poll(() => asked.length).toBe(1);
			await expect(dialog).toBeVisible();
			await expect(page.locator('#f-title')).toHaveValue('Half written');
			await page.keyboard.press('Escape');
			await expect.poll(() => asked.length).toBe(2);
			await expect(dialog).toBeVisible();
			discard = true;
			await page.locator('#f-cancel').click();
			await expect(dialog).toBeHidden();
			expect(asked).toHaveLength(3);
			await expect(card('Half written')).toHaveCount(0);
		});

		await test.step('saving closes the dialog and brings the new card into view, flashed, at the end of its level', async () => {
			await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			await newButton.click();
			await fill(title);
			await page.locator('#f-save').click();
			await expect(dialog).toBeHidden();
			const created = card(title);
			await expect(created).toHaveClass(/just-saved/);
			await expect(created).toBeInViewport({ ratio: 1 });
			await expect(page.locator('#status')).toHaveText(`Saved "${title}".`);
			await expect(page.locator('#activities details[data-level="starter"] .card').last()).toContainText(title);
			const header = (await page.locator('.sticky').boundingBox())!;
			expect((await created.boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height);
			await expect(created).not.toHaveClass(/just-saved/);
		});

		await test.step('Edit opens the same dialog, saves in place and returns focus to that card', async () => {
			await card(title).getByRole('button', { name: 'Edit', exact: true }).click();
			const editor = page.getByRole('dialog', { name: `Edit "${title}"` });
			await expect(editor).toBeVisible();
			await expect(page.locator('#f-title')).toHaveValue(title);
			await expect(page.locator('#f-sentence')).toHaveValue('The quick brown fox.');
			await page.locator('#f-title').fill(`${title} edited`);
			await page.locator('#f-save').click();
			await expect(editor).toBeHidden();
			const edited = card(`${title} edited`);
			await expect(edited).toBeInViewport({ ratio: 1 });
			await expect(page.locator('#activities details[data-level="starter"] .card').last()).toContainText(`${title} edited`);
			await expect(edited.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
		});

		await test.step('a rule the form breaks is shown inside the dialog, which stays open', async () => {
			await card(`${title} edited`).getByRole('button', { name: 'Edit', exact: true }).click();
			await page.locator('#f-title').fill('');
			await page.locator('#f-save').click();
			await expect(page.locator('#f-error')).toContainText('title must not be empty');
			await expect(page.locator('#f-error')).toBeInViewport({ ratio: 1 });
			await page.keyboard.press('Escape');
			await expect(page.getByRole('dialog')).toBeHidden();
		});

		expect(problems).toEqual([]);
		await context.close();
	});
}

for (const [size, options] of Object.entries(DIALOG_SIZES)) {
	test(`on ${size}, a double click on Save creates one activity`, async ({ browser }) => {
		const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
		const page = await context.newPage();
		answerPopups(page);
		const problems = collectProblems([page]);
		const title = `Once ${size}-${RUN}`;
		const posts: string[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(/\/activities$/, async (route) => {
			if (route.request().method() !== 'POST') return route.continue();
			posts.push(route.request().url());
			await held;
			await route.continue();
		});

		await page.goto(`${ADMIN}/`);
		await signInAtFakeEntra(page, ADMIN_EMAIL);
		await adminReady(page);
		await page.goto(`${ADMIN}/g/letterjoin/#activities`);
		await adminReady(page);
		await page.locator('#new-activity').click();
		await page.locator('#f-type').selectOption('sentence');
		await page.locator('#f-title').fill(title);
		await page.locator('#f-sentence').fill('Only one of me.');
		const save = page.locator('#f-save');
		await save.dblclick();
		await expect(save).toBeDisabled();
		await page.locator('#activity-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
		expect(posts).toHaveLength(1);
		release();
		await expect(page.getByRole('dialog')).toBeHidden();
		await expect(page.locator('#activities .card', { hasText: title })).toHaveCount(1);
		expect(posts).toHaveLength(1);
		await expect(save).toBeEnabled();
		expect(problems).toEqual([]);
		await context.close();
	});
}
