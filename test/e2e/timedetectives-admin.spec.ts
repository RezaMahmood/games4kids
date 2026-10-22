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
