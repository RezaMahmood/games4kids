import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, collectProblems, signInAtFakeEntra } from './support.ts';

const SHOTS = process.env['G4K_SHOTS'];
const SIZES = [
	{ name: 'at 820px', width: 820, options: { viewport: { width: 820, height: 1000 } } },
	{ name: 'at 390px', width: 390, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
] as const;
const ROUND_API = /\/api\/admin\/g\/timedetectives\/rounds\/[0-9a-f-]{36}$/;

let made = 0;
const unique = (what: string) => `${what} ${Date.now().toString(36)}${(made++).toString(36)}`;

async function adminPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<Page> {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
	const page = await context.newPage();
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
	await page.goto(`${ADMIN}/g/timedetectives/`);
	await adminReady(page);
	return page;
}

async function newTopic(page: Page, title = unique('Vikings')): Promise<string> {
	await page.getByRole('button', { name: 'New topic' }).click();
	await page.getByLabel('Title', { exact: true }).fill(title);
	await page.getByRole('button', { name: 'Save topic' }).click();
	await expect(page.getByRole('link', { name: title })).toBeVisible();
	return title;
}

/** Opens the topic, has the fake AI draft a round in it, and opens that round. */
async function draftedRound(page: Page, topic: string): Promise<void> {
	await page.getByRole('link', { name: topic }).click();
	await page.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(page.locator('#rounds .badge.draft')).toBeVisible();
	await page.getByRole('link', { name: 'The raid on Lindisfarne' }).click();
	await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
}

const shot = (page: Page, name: string) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const STUCK = [
	{
		name: 'a round the AI failed on',
		fake: (real: Record<string, unknown>) => ({ ...real, hasPicture: false, state: { kind: 'failed', focus: 'Lindisfarne', source: 'ai', reason: 'The AI did not answer after 3 tries.' } }),
		badge: 'Failed',
		note: 'The AI did not answer after 3 tries.',
		retry: true,
	},
	{
		name: 'a round whose stored data no longer reads',
		fake: (real: Record<string, unknown>) => ({ id: real['id'], topicId: real['topicId'], broken: ['content: questions must have exactly one who question'] }),
		badge: 'Damaged',
		note: "This round's stored data is damaged, so nobody can edit or play it: content: questions must have exactly one who question. Delete it and make it again.",
		retry: false,
	},
];

for (const { name, fake, badge, note, retry } of STUCK) {
	test(`${name} can still be deleted, which frees its topic`, async ({ browser }) => {
		const page = await adminPage(browser);
		const problems = collectProblems([page]);
		const topic = await newTopic(page);
		await draftedRound(page, topic);
		await page.route(ROUND_API, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			return route.fulfill({ json: fake((await (await route.fetch()).json()) as Record<string, unknown>) });
		});
		await page.reload();
		await adminReady(page);

		await expect(page.locator('#round-badge')).toHaveText(badge);
		await expect(page.locator('#round-note')).toHaveText(note);
		await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ visible: retry });
		await shot(page, `admin-${badge.toLowerCase()}-1280`);
		await page.getByRole('button', { name: 'Delete round' }).click();
		await expect(page.locator('#rounds-empty')).toBeVisible();
		await page.getByRole('link', { name: 'All topics' }).click();
		await page.locator('#topics .card', { hasText: topic }).getByRole('button', { name: 'Delete' }).click();
		await expect(page.getByRole('link', { name: topic })).toHaveCount(0);
		expect(problems).toEqual([]);
		await page.context().close();
	});
}

test('a round whose new picture was refused says why and stays editable with Upload and Redraw, and a published round is not redrawn', async ({ browser }) => {
	const page = await adminPage(browser);
	await draftedRound(page, await newTopic(page));
	const notice = 'The AI could not draw a picture. The AI safety filter turned it down. Upload a picture, or change the picture description and redraw.';
	await page.route(ROUND_API, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const real = (await (await route.fetch()).json()) as { state: Record<string, unknown> };
		return route.fulfill({ json: { ...real, hasPicture: false, state: { ...real.state, notice } } });
	});
	await page.reload();
	await adminReady(page);
	await expect(page.locator('#round-note')).toHaveText(notice);
	await expect(page.getByRole('button', { name: 'Redraw with AI' })).toBeVisible();
	await expect(page.getByText('Upload a picture', { exact: true })).toBeVisible();
	await expect(page.locator('#r-full')).toBeEditable();
	await shot(page, 'admin-picture-refused-1280');
	await page.unroute(ROUND_API);

	await page.reload();
	await adminReady(page);
	await page.getByRole('button', { name: 'Publish', exact: true }).click();
	await expect(page.locator('#round-badge')).toHaveText('Published');
	await expect(page.getByRole('button', { name: 'Redraw with AI' })).toBeHidden();
	await expect(page.getByText('To redraw it with AI, unpublish the round first.')).toBeVisible();
	await page.context().close();
});

for (const { name, width, options } of SIZES) {
	test(`${name}, the status and the round's actions share one bar that covers neither each other nor the end of the page`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await draftedRound(page, await newTopic(page));
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		const status = page.getByRole('status').filter({ hasText: 'Saved.' });
		await expect(status).toBeVisible();

		const actions = page.getByRole('button', { name: /^(Save|Publish|Delete round)$/ });
		const statusBox = await status.boundingBox();
		expect(statusBox).not.toBeNull();
		for (const button of await actions.all()) {
			const box = await button.boundingBox();
			if (box && statusBox) expect(overlaps(statusBox, box), `"${await button.textContent()}" is not under the status`).toBe(false);
		}
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		const lastPreview = await page.locator('#preview-body > :last-child').boundingBox();
		expect(lastPreview).not.toBeNull();
		for (const cover of [status, ...(await actions.all())]) {
			const box = await cover.boundingBox();
			if (box && lastPreview) expect(overlaps(lastPreview, box), `"${await cover.textContent()}" leaves the end of the preview showing`).toBe(false);
		}
		await shot(page, `admin-saved-${width}`);
		await page.context().close();
	});
}

for (const { name, width, options } of SIZES) {
	test(`${name}, a topic title another topic has is refused with a clear message by the title`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		const title = await newTopic(page);
		await page.getByRole('button', { name: 'New topic' }).click();
		await page.getByLabel('Title', { exact: true }).fill(title.toUpperCase());
		await page.getByRole('button', { name: 'Save topic' }).click();
		await expect(page.locator('#topic-problems')).toHaveText(`There is already a topic called "${title}". Choose another title.`);
		await expect(page.getByLabel('Title', { exact: true })).toBeFocused();
		await expect(page.locator('#topics .card', { hasText: title })).toHaveCount(1);
		await shot(page, `admin-duplicate-topic-${width}`);
		await page.context().close();
	});
}

/** A 1 by 1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

for (const { name, width, options } of SIZES) {
	test(`${name}, Publish publishes what is on screen, and Upload and Unpublish keep edits that were never saved`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await draftedRound(page, await newTopic(page));
		const hint = page.locator('#q-where-hint');
		await hint.fill('Look for the holy island.');
		await page.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.locator('#round-badge')).toHaveText('Published');
		await expect(hint).toHaveValue('Look for the holy island.');

		await page.locator('#r-brief').fill('Sails on the horizon.');
		await page.locator('#r-upload').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: PNG });
		await expect(page.getByRole('status')).toHaveText('Picture saved.');
		await page.locator('#q-who-hint').fill('Who sailed from the north?');
		await page.getByRole('button', { name: 'Unpublish' }).click();
		await expect(page.getByRole('status')).toHaveText('Unpublished, and your changes are saved.');
		await expect(page.locator('#round-badge')).toHaveText('Draft');

		await page.reload();
		await adminReady(page);
		await expect(hint).toHaveValue('Look for the holy island.');
		await expect(page.locator('#r-brief')).toHaveValue('Sails on the horizon.');
		await expect(page.locator('#q-who-hint')).toHaveValue('Who sailed from the north?');
		await shot(page, `admin-unsaved-kept-${width}`);
		await page.context().close();
	});
}

const RETRY_API = /\/api\/admin\/g\/timedetectives\/rounds\/[0-9a-f-]{36}\/retry$/;
const WORDS_REFUSED = 'The AI safety filter turned this round down. Change what it should be about and try again, or delete it.';

for (const { name, width, options } of SIZES) {
	test(`${name}, Try again on a round the AI refused asks about the focus the admin changes it to`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await draftedRound(page, await newTopic(page));
		let refused = true;
		let real: Record<string, unknown> = {};
		await page.route(ROUND_API, async (route) => {
			if (route.request().method() !== 'GET' || !refused) return route.fallback();
			real = (await (await route.fetch()).json()) as Record<string, unknown>;
			return route.fulfill({ json: { ...real, hasPicture: false, state: { kind: 'failed', focus: 'Lindisfarne', source: 'ai', reason: WORDS_REFUSED } } });
		});
		const asked: unknown[] = [];
		await page.route(RETRY_API, (route) => {
			asked.push(route.request().postDataJSON());
			refused = false;
			return route.fulfill({ status: 202, json: { ...real, state: { kind: 'drafting', focus: 'Jorvik', source: 'ai' } } });
		});
		await page.reload();
		await adminReady(page);

		await expect(page.locator('#round-note')).toHaveText(WORDS_REFUSED);
		const focus = page.getByLabel('What should the AI write about this time? (optional)');
		await expect(focus).toHaveValue('Lindisfarne');
		await focus.fill('Jorvik');
		await shot(page, `admin-retry-focus-${width}`);
		await page.getByRole('button', { name: 'Try again' }).click();
		await expect(page.locator('#round-badge')).toHaveText('Draft');
		expect(asked).toEqual([{ focus: 'Jorvik' }]);
		await expect(focus).toBeHidden();
		await page.context().close();
	});
}

const UNPUBLISH_API = /\/api\/admin\/g\/timedetectives\/rounds\/[0-9a-f-]{36}\/unpublish$/;

for (const { name, width, options } of SIZES) {
	test(`${name}, Unpublish takes the round down before saving edits, so an Unpublish that fails puts no unchecked words live`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await draftedRound(page, await newTopic(page));
		const original = await page.locator('#r-brief').inputValue();
		await page.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.locator('#round-badge')).toHaveText('Published');

		await page.route(UNPUBLISH_API, (route) => route.fulfill({ status: 503, json: { error: 'storage_down', message: 'Storage is resting.' } }));
		await page.locator('#r-brief').fill('Words nobody has checked.');
		await page.getByRole('button', { name: 'Unpublish' }).click();
		await expect(page.getByRole('status')).toHaveText('Storage is resting.');
		await expect(page.locator('#r-brief')).toHaveValue('Words nobody has checked.');
		await shot(page, `admin-unpublish-failed-${width}`);
		const other = await page.context().newPage();
		await other.goto(page.url());
		await adminReady(other);
		await expect(other.locator('#round-badge')).toHaveText('Published');
		await expect(other.locator('#r-brief')).toHaveValue(original);
		await other.close();

		await page.unroute(UNPUBLISH_API);
		await page.getByRole('button', { name: 'Unpublish' }).click();
		await expect(page.getByRole('status')).toHaveText('Unpublished, and your changes are saved.');
		await expect(page.locator('#round-badge')).toHaveText('Draft');
		await expect(page.locator('#r-brief')).toHaveValue('Words nobody has checked.');
		await page.context().close();
	});
}

for (const { name, width, options } of SIZES) {
	test(`${name}, Publish refuses a round another admin changed since the page loaded it, and shows their change`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await draftedRound(page, await newTopic(page));
		const other = await page.context().newPage();
		await other.goto(page.url());
		await adminReady(other);
		await other.locator('#r-brief').fill('A change nobody has checked.');
		await other.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(other.getByRole('status')).toHaveText('Saved.');

		await page.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByRole('status')).toHaveText('Someone else changed this since you loaded it. Reload to see the latest version, then make your change again. The page has been reloaded.');
		await expect(page.locator('#round-badge')).toHaveText('Draft');
		await expect(page.locator('#r-brief')).toHaveValue('A change nobody has checked.');
		await shot(page, `admin-publish-changed-${width}`);
		await page.context().close();
	});
}

for (const { name, width, options } of SIZES) {
	test(`${name}, focus moves to what replaced a control that went away, and to the heading of each new view`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await page.getByRole('button', { name: 'New topic' }).click();
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('button', { name: 'New topic' })).toBeFocused();
		const topic = await newTopic(page);
		await expect(page.getByRole('button', { name: 'New topic' })).toBeFocused();
		await page.getByRole('link', { name: topic }).click();
		await expect(page.locator('#topic-heading')).toBeFocused();
		await page.getByRole('button', { name: 'Draft with AI' }).click();
		await expect(page.locator('#rounds .badge.draft')).toBeVisible();
		await page.getByRole('link', { name: 'The raid on Lindisfarne' }).click();
		await expect(page.locator('#round-heading')).toBeFocused();
		await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);

		await page.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Unpublish' })).toBeFocused();
		await page.getByRole('button', { name: 'Unpublish' }).click();
		await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeFocused();
		await shot(page, `admin-focus-publish-${width}`);
		await page.getByRole('button', { name: 'Redraw with AI' }).click();
		await expect(page.locator('#round-heading')).toBeFocused();
		await page.context().close();
	});
}
