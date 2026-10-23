import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, collectProblems, pageReady, signInAtFakeEntra } from './support.ts';

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

/** Saves a new topic, which opens that topic's page. */
async function newTopic(page: Page, title = unique('Vikings')): Promise<string> {
	await page.getByRole('button', { name: 'New topic' }).click();
	await page.getByLabel('Title', { exact: true }).fill(title);
	await page.getByRole('button', { name: 'Save topic' }).click();
	await expect(page.locator('#topic-heading')).toHaveText(title);
	return title;
}

/** On a topic's page, has the fake AI draft a round, and opens it with the card's Review and publish. */
async function draftedRound(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Draft with AI' }).click();
	await expect(page.locator('#rounds .badge.draft')).toBeVisible();
	await page.getByRole('link', { name: 'Review and publish' }).click();
	await expect(page.locator('#round-heading')).toHaveText('The raid on Lindisfarne');
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
		await draftedRound(page);
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
	await newTopic(page);
	await draftedRound(page);
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
		await newTopic(page);
		await draftedRound(page);
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
		await page.getByRole('link', { name: 'All topics' }).click();
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
		await newTopic(page);
		await draftedRound(page);
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
		await newTopic(page);
		await draftedRound(page);
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
		await newTopic(page);
		await draftedRound(page);
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
		await newTopic(page);
		await draftedRound(page);
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
		await newTopic(page);
		await expect(page.locator('#topic-heading')).toBeFocused();
		await page.getByRole('button', { name: 'Draft with AI' }).click();
		await expect(page.locator('#rounds .badge.draft')).toBeVisible();
		await page.getByRole('link', { name: 'The raid on Lindisfarne', exact: true }).click();
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

for (const { name, width, options } of SIZES) {
	test(`${name}, a new topic opens its own page, each card says what to press next, and editing a topic goes back to the list`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		const problems = collectProblems([page]);
		const topic = await newTopic(page);
		await expect(page.locator('.steps li')).toHaveText(['Draft a round with AI or write one.', 'Check it and give it a picture.', 'Publish it so children can play it.']);

		await page.getByRole('button', { name: 'Draft with AI' }).click();
		await page.getByRole('button', { name: 'Draft with AI' }).click();
		await expect(page.locator('#rounds .badge.draft')).toHaveCount(2);
		await page.getByRole('link', { name: 'Review and publish' }).first().click();
		await expect(page.locator('#round-note')).toHaveText('Draft: only you can see this. When you are happy, press Publish at the bottom.');
		await expect(page.locator('#round-checks')).toBeHidden();
		await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
		await shot(page, `admin-clean-draft-${width}`);
		await page.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(page.locator('#round-badge')).toHaveText('Published');

		await page.getByRole('link', { name: 'Back to the topic' }).click();
		await expect(page.locator('#rounds .badge.published')).toHaveText('Published, children can play it');
		await expect(page.locator('#rounds .badge.draft')).toHaveText('Draft, only you can see it');
		await expect(page.getByRole('link', { name: /^View: / })).toBeVisible();
		await shot(page, `admin-topic-rounds-${width}`);

		await page.getByRole('link', { name: 'All topics' }).click();
		const card = page.locator('#topics .card', { hasText: topic });
		await expect(card.locator('.meta')).toHaveText('2 rounds, 1 published, 1 draft to review');
		await expect(card.getByRole('link', { name: `Open ${topic}` })).toBeVisible();
		await shot(page, `admin-topics-${width}`);

		await card.getByRole('button', { name: 'Edit title and guidance' }).click();
		await page.getByLabel('Guidance for the AI (optional)').fill('Everyday life on the island.');
		await page.getByRole('button', { name: 'Save topic' }).click();
		await expect(page.getByRole('status')).toHaveText('Saved.');
		await expect(page.locator('#topics-heading')).toBeVisible();
		await expect(card.locator('.note')).toHaveText('Everyday life on the island.');
		expect(problems).toEqual([]);
		await page.context().close();
	});
}

for (const { name, width, options } of SIZES) {
	test(`${name}, the check's findings say what might spoil the quiz, quote the field, and Go to it moves there`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await newTopic(page);
		await draftedRound(page);
		let checks: unknown = [
			{ field: 'where-hint', problem: 'give the answer away', sure: false },
			{ field: 'brief', problem: 'give away the answer to "Who is it?"', sure: true },
		];
		await page.route(ROUND_API, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const real = (await (await route.fetch()).json()) as { state: Record<string, unknown> };
			return route.fulfill({ json: { ...real, state: { ...real.state, checks } } });
		});
		await page.reload();
		await adminReady(page);

		const panel = page.locator('#round-checks');
		await expect(panel.getByRole('heading')).toHaveText('Worth a second look');
		await expect(panel.locator('#checks-intent')).toHaveText('An automatic check read this round and thinks these might spoil the quiz. Fix them, or publish as it is if you disagree.');
		const hint = page.locator('#q-where-hint');
		const items = panel.locator('li');
		await expect(items.nth(0)).toContainText(`The "Where is it?" hint might give the answer away: "${await hint.inputValue()}"`);
		await expect(items.nth(1)).toContainText('The short clue seems to give away the answer to "Who is it?": "');
		await expect(page.locator('#round-note')).toHaveText('Draft: only you can see this. When you are happy, press Publish at the bottom.');
		await expect(panel.getByRole('button', { name: 'Redraft with AI using these notes' })).toBeEnabled();
		await shot(page, `admin-checks-${width}`);

		await items.nth(0).getByRole('button', { name: 'Go to it' }).click();
		await expect(hint).toBeFocused();
		await expect(hint).toBeInViewport();
		await hint.fill('Look for the island in the story.');
		await expect(items.nth(0)).toContainText('"Look for the island in the story."');

		checks = 'not-run';
		await page.reload();
		await adminReady(page);
		await expect(panel.locator('#checks-intent')).toHaveText('The automatic check could not read this round this time. Read it through before you publish it.');
		await expect(panel.locator('li')).toHaveCount(0);
		await expect(panel.getByRole('button', { name: 'Redraft with AI using these notes' })).toBeHidden();
		await page.context().close();
	});
}

const COSTS_API = /\/api\/admin\/g\/timedetectives\/costs$/;
const ESTIMATE_NOTE = 'Estimated from token counts and Azure list prices; your Azure bill is the final word.';

for (const { name, width, options } of SIZES) {
	test(`${name}, the AI cost shows on the topic list, the topic page and the round, and a redraw raises the round's`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		const problems = collectProblems([page]);
		const topic = await newTopic(page);
		await expect(page.locator('#topic-cost')).toBeHidden();
		await draftedRound(page);
		const roundCost = page.locator('#round-cost');
		// One chat reply (800 input, 200 cached, 500 output at 0.75, 0.075, 4.5) is 2865 micro-USD; one check (2000 input at 0.042) is 84; one picture (50 text, 1000 output at 2, 8) is 8100.
		const before = 'AI cost so far: est. $0.011 (3 AI calls)';
		await expect(roundCost).toHaveText(before);
		await shot(page, `costs-round-${width}`);

		await page.getByRole('button', { name: 'Redraw with AI' }).click();
		await expect(roundCost).not.toHaveText(before);
		await expect(page.locator('#round-badge')).toHaveText('Draft');
		await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
		const after = 'AI cost so far: est. $0.019 (4 AI calls)';
		await expect(roundCost).toHaveText(after);

		await page.getByRole('link', { name: 'Back to the topic' }).click();
		await expect(page.locator('#topic-cost-total')).toHaveText(after.replace(/ \(.*/, ''));
		await expect(page.locator('#topic-cost')).toContainText(ESTIMATE_NOTE);
		await expect(page.locator('#topic-cost-deleted')).toBeHidden();
		await expect(page.locator('#rounds .card')).toContainText(after);
		await shot(page, `costs-topic-${width}`);

		await page.getByRole('link', { name: 'All topics' }).click();
		await expect(page.locator('#topics .card', { hasText: topic })).toContainText(`AI cost: ${after.replace(/^AI cost so far: | \(.*/g, '')}`);
		await shot(page, `costs-topics-${width}`);

		await page.getByRole('link', { name: topic, exact: true }).click();
		await page.getByRole('link', { name: 'Review and publish' }).click();
		await page.getByRole('button', { name: 'Delete round' }).click();
		await expect(page.locator('#rounds-empty')).toBeVisible();
		await expect(page.locator('#topic-cost-total')).toHaveText('AI cost so far: est. $0.019');
		await shot(page, `costs-topic-deleted-${width}`);
		await expect(page.locator('#topic-cost-deleted')).toHaveText('Includes est. $0.019 spent on rounds since deleted.');
		expect(problems).toEqual([]);
		await page.context().close();
	});
}

test('a costs request that fails leaves every page working, with no cost text', async ({ browser }) => {
	const page = await adminPage(browser);
	await page.route(COSTS_API, (route) => route.fulfill({ status: 500, json: { error: { message: 'no costs today' } } }));
	await page.reload();
	await adminReady(page);
	await newTopic(page);
	await draftedRound(page);
	await expect(page.locator('#round-cost')).toBeHidden();
	await page.getByRole('link', { name: 'Back to the topic' }).click();
	await expect(page.locator('#rounds .card')).toHaveCount(1);
	await expect(page.locator('#topic-cost')).toBeHidden();
	await expect(page.locator('#rounds .card')).not.toContainText('AI cost');
	await page.getByRole('link', { name: 'All topics' }).click();
	await expect(page.locator('#topics .card').first()).toBeVisible();
	await expect(page.locator('#topics')).not.toContainText('AI cost');
	await page.context().close();
});

/** dev/fake-foundry.ts's GIVEAWAY_FOCUS: the fake AI writes a "who" hint that names the answer, which the fake check flags, until it is asked for a redraft. */
const GIVEAWAY_FOCUS = 'a hint that gives the answer away';
const REDRAFT_API = /\/api\/admin\/g\/timedetectives\/rounds\/[0-9a-f-]{36}\/redraft$/;

for (const { name, width, options } of SIZES) {
	test(`${name}, Redraft with AI rewrites only flagged words with no unsaved edits, keeps the picture, and raises the round's cost`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		const problems = collectProblems([page]);
		await newTopic(page);
		await draftedRound(page);
		const redraft = page.getByRole('button', { name: 'Redraft with AI using these notes' });
		await expect(page.locator('#round-checks')).toBeHidden();
		await expect(redraft).toBeHidden();

		await page.getByRole('link', { name: 'Back to the topic' }).click();
		await page.getByLabel('What should it be about? (optional)').fill(GIVEAWAY_FOCUS);
		await page.getByRole('button', { name: 'Draft with AI' }).click();
		const card = page.locator('#rounds .card', { hasText: 'worth a second look' });
		await expect(card).toContainText('1 thing worth a second look');
		await card.getByRole('link', { name: 'Review and publish' }).click();
		await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);

		const panel = page.locator('#round-checks');
		await expect(panel.locator('li')).toHaveText(['The "Who is it?" hint seems to give the answer away: "The Vikings sailed across the North Sea." Go to it']);
		await expect(redraft).toBeEnabled();
		await expect(panel.locator('#redraft-note')).toHaveText('The AI rewrites the words to fix these notes. The picture stays. This costs an AI call.');
		// Two asks and two checks, since the first answer failed its check, then one picture.
		const roundCost = page.locator('#round-cost');
		await expect(roundCost).toHaveText('AI cost so far: est. $0.014 (5 AI calls)');
		await shot(page, `redraft-panel-${width}`);

		const hint = page.locator('#q-who-hint');
		await hint.fill('Who came over the sea?');
		await expect(redraft).toBeDisabled();
		await expect(panel.getByText('Save or undo your changes first')).toBeVisible();
		await shot(page, `redraft-unsaved-${width}`);
		await hint.fill('The Vikings sailed across the North Sea.');
		await expect(redraft).toBeEnabled();
		await expect(panel.getByText('Save or undo your changes first')).toBeHidden();

		// Hold the round as the redraft left it, so the page shows the AI at work before it shows the result.
		let revising: unknown = null;
		await page.route(REDRAFT_API, async (route) => {
			const reply = await route.fetch();
			revising = await reply.json();
			return route.fulfill({ response: reply });
		});
		await page.route(ROUND_API, (route) => (route.request().method() === 'GET' && revising ? route.fulfill({ json: revising }) : route.fallback()));
		await page.route(/\/api\/admin\/g\/timedetectives\/topics\/[0-9a-f-]{36}\/rounds$/, async (route) => {
			if (route.request().method() !== 'GET' || !revising) return route.fallback();
			const held = revising as { id: string };
			const { rounds } = (await (await route.fetch()).json()) as { rounds: { id: string }[] };
			return route.fulfill({ json: { rounds: rounds.map((round) => (round.id === held.id ? held : round)) } });
		});
		await redraft.click();
		await expect(page.locator('#round-badge')).toHaveText('Redrafting…');
		await expect(page.locator('#round-note')).toHaveText('The AI is redrafting this round. This page updates when it is done.');
		await expect(panel).toBeHidden();
		await expect(hint).toBeDisabled();
		await shot(page, `redraft-working-${width}`);
		await page.getByRole('link', { name: 'Back to the topic' }).click();
		await expect(page.locator('#rounds .card', { hasText: 'The AI is redrafting it…' })).toBeVisible();
		await shot(page, `redraft-card-${width}`);
		await page.locator('#rounds .card', { hasText: 'The AI is redrafting it…' }).getByRole('link').first().click();
		await expect(page.locator('#round-badge')).toHaveText('Redrafting…');

		revising = null;
		await expect(page.locator('#round-badge')).toHaveText('Draft');
		await pageReady(page);
		await expect(hint).toHaveValue('Look for who the ships carried across the North Sea.');
		await expect(panel).toBeHidden();
		await expect(page.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
		// One more ask and one more check: 13998 + 2865 + 84 micro-USD.
		await expect(roundCost).toHaveText('AI cost so far: est. $0.017 (7 AI calls)');
		await shot(page, `redraft-done-${width}`);
		expect(problems).toEqual([]);
		await page.context().close();
	});
}

test('while the AI works on one round, the other cards keep their pictures on screen through every poll', async ({ browser }) => {
	const page = await adminPage(browser);
	const problems = collectProblems([page]);
	await newTopic(page);
	await draftedRound(page);
	await page.getByRole('link', { name: 'Back to the topic' }).click();
	const thumb = page.locator('#rounds img.thumb');
	const ROUNDS_API = /\/api\/admin\/g\/timedetectives\/topics\/[0-9a-f-]{36}\/rounds$/;
	await page.route(ROUNDS_API, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const reply = await route.fetch();
		const body = (await reply.json()) as { rounds: Record<string, unknown>[] };
		const drawing = { ...body.rounds[0], id: '00000000-0000-4000-8000-000000000001', hasPicture: false, state: { kind: 'drafting', focus: 'Jorvik', source: 'ai' } };
		return route.fulfill({ response: reply, json: { rounds: [...body.rounds, drawing] } });
	});
	let pictureFetches = 0;
	page.on('request', (request) => {
		if (/\/rounds\/[0-9a-f-]{36}\/picture$/.test(request.url())) pictureFetches++;
	});
	let polls = 0;
	page.on('response', (response) => {
		if (ROUNDS_API.test(response.url())) polls++;
	});

	await page.reload();
	await adminReady(page);
	await expect(thumb).toHaveAttribute('src', /^blob:/);
	await thumb.evaluate((img) => ((img as HTMLImageElement & { marked?: boolean }).marked = true));
	const fetchesAfterLoad = pictureFetches;
	await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
	expect(await thumb.evaluate((img) => Boolean((img as HTMLImageElement & { marked?: boolean }).marked)), 'the same picture element survives each poll').toBe(true);
	expect(await thumb.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), 'the picture stayed loaded').toBe(true);
	expect(pictureFetches - fetchesAfterLoad, 'an unchanged round is not fetched again on a poll').toBe(0);
	await page.unroute(ROUNDS_API);
	expect(problems).toEqual([]);
});

/** On a new topic's page, has the fake AI draft `count` rounds, which all come with a picture. */
async function topicWithDrafts(page: Page, count: number): Promise<void> {
	await newTopic(page);
	for (let made = 1; made <= count; made++) {
		await page.getByRole('button', { name: 'Draft with AI' }).click();
		await expect(page.locator('#rounds .badge.draft')).toHaveCount(made);
	}
}

const ROUNDS_LIST_API = /\/api\/admin\/g\/timedetectives\/topics\/[0-9a-f-]{36}\/rounds$/;
const pickOf = (page: Page, index: number) => page.locator('#rounds .round-card').nth(index).locator('.pick input');
const toolbar = (page: Page) => page.getByRole('group', { name: 'Actions for the chosen rounds' });
const bulkButton = (page: Page, name: string) => toolbar(page).getByRole('button', { name, exact: true });

for (const { name, width, options } of SIZES) {
	test(`${name}, several rounds are published, unpublished and deleted together from the topic page`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		const problems = collectProblems([page]);
		let dialogs = 0;
		page.on('dialog', () => dialogs++);
		await topicWithDrafts(page, 3);
		await expect(bulkButton(page, 'Publish')).toBeDisabled();
		await expect(bulkButton(page, 'Unpublish')).toBeDisabled();
		await expect(page.locator('#bulk-delete')).toBeDisabled();
		await expect(page.locator('#bulk-count')).toHaveText('None selected');
		const target = await page.locator('#rounds .pick').first().boundingBox();
		expect(target?.width).toBeGreaterThanOrEqual(44);
		expect(target?.height).toBeGreaterThanOrEqual(44);
		await expect(page.getByRole('checkbox', { name: 'Select The raid on Lindisfarne' })).toHaveCount(3);
		await shot(page, `bulk/list-${width}`);

		await pickOf(page, 0).check();
		await pickOf(page, 1).check();
		await expect(page.locator('#bulk-count')).toHaveText('2 selected');
		await expect(bulkButton(page, 'Unpublish')).toBeDisabled();
		await shot(page, `bulk/two-selected-${width}`);
		await bulkButton(page, 'Publish').click();
		await expect(page.getByRole('status')).toHaveText('Published 2.');
		await expect(page.locator('#rounds .badge.published')).toHaveCount(2);
		await expect(page.locator('#rounds .badge.draft')).toHaveCount(1);
		await expect(page.locator('#bulk-count')).toHaveText('None selected');
		await expect(pickOf(page, 0)).not.toBeChecked();
		await shot(page, `bulk/published-${width}`);

		await page.locator('#bulk-all').check();
		await expect(page.locator('#bulk-count')).toHaveText('3 selected');
		await expect(bulkButton(page, 'Publish')).toBeEnabled();
		await expect(bulkButton(page, 'Unpublish')).toBeEnabled();
		await page.locator('#bulk-all').uncheck();
		await expect(page.locator('#bulk-count')).toHaveText('None selected');
		await pickOf(page, 0).check();
		await pickOf(page, 1).check();
		await pickOf(page, 2).check();
		await bulkButton(page, 'Unpublish').click();
		await expect(page.getByRole('status')).toHaveText('Unpublished 2.');
		await expect(page.locator('#rounds .badge.draft')).toHaveCount(3);

		await pickOf(page, 0).check();
		await pickOf(page, 2).check();
		await page.locator('#bulk-delete').click();
		await expect(page.getByText('Delete 2 rounds? This cannot be undone.')).toBeVisible();
		await expect(page.locator('#bulk-delete')).toBeHidden();
		await shot(page, `bulk/confirm-delete-${width}`);
		await bulkButton(page, 'Cancel').click();
		await expect(page.locator('#rounds .round-card')).toHaveCount(3);
		await expect(page.locator('#bulk-count')).toHaveText('2 selected');
		await expect(page.locator('#bulk-delete')).toBeVisible();

		await page.locator('#bulk-delete').click();
		await page.locator('#bulk-confirm-yes').click();
		await expect(page.getByRole('status')).toHaveText('Deleted 2.');
		await expect(page.locator('#rounds .round-card')).toHaveCount(1);
		await expect(page.locator('#bulk-count')).toHaveText('None selected');
		await shot(page, `bulk/deleted-${width}`);
		await pickOf(page, 0).check();
		await page.locator('#bulk-delete').click();
		await page.locator('#bulk-confirm-yes').click();
		await expect(page.locator('#rounds-empty')).toBeVisible();
		await expect(toolbar(page)).toBeHidden();
		expect(dialogs, 'no browser dialog').toBe(0);
		expect(problems).toEqual([]);
		await page.context().close();
	});

	test(`${name}, a bulk publish reports a draft without a picture and a round another admin changed, and still publishes the rest`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await topicWithDrafts(page, 3);
		let unpictured = '';
		await page.route(ROUNDS_LIST_API, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const reply = await route.fetch();
			const body = (await reply.json()) as { rounds: { id: string; hasPicture: boolean }[] };
			unpictured ||= body.rounds[0]?.id ?? '';
			return route.fulfill({ response: reply, json: { rounds: body.rounds.map((round) => (round.id === unpictured ? { ...round, hasPicture: false } : round)) } });
		});
		await page.reload();
		await adminReady(page);
		await expect(page.locator('#rounds .round-card')).toHaveCount(3);
		await expect(page.locator('#rounds .round-card').first()).toContainText('Needs a picture');
		const other = await page.context().newPage();
		await other.goto(page.url());
		await adminReady(other);
		await other.locator('#rounds .round-card').nth(1).getByRole('link', { name: /Review and publish/ }).click();
		await other.locator('#r-brief').fill('A change nobody has checked.');
		await other.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(other.getByRole('status')).toHaveText('Saved.');
		await other.close();

		await page.locator('#bulk-all').check();
		await bulkButton(page, 'Publish').click();
		const status = page.getByRole('status');
		await expect(status).toContainText('Published 1. 2 were not published:');
		await expect(status).toContainText('The raid on Lindisfarne needs a picture.');
		await expect(status).toContainText('The raid on Lindisfarne: Someone else changed this since you loaded it.');
		await expect(page.locator('#rounds .badge.published')).toHaveCount(1);
		await shot(page, `bulk/reported-${width}`);
		await page.unroute(ROUNDS_LIST_API);
		await page.context().close();
	});

	test(`${name}, the chosen rounds stay chosen through the list's polls, and a round the AI is working on cannot be chosen`, async ({ browser }) => {
		const page = await adminPage(browser, options);
		await topicWithDrafts(page, 2);
		await page.route(ROUNDS_LIST_API, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback();
			const reply = await route.fetch();
			const body = (await reply.json()) as { rounds: Record<string, unknown>[] };
			const drawing = { ...body.rounds[0], id: '00000000-0000-4000-8000-000000000001', hasPicture: false, state: { kind: 'drafting', focus: 'Jorvik', source: 'ai' } };
			return route.fulfill({ response: reply, json: { rounds: [...body.rounds, drawing] } });
		});
		let polls = 0;
		page.on('response', (response) => {
			if (ROUNDS_LIST_API.test(response.url())) polls++;
		});
		await page.reload();
		await adminReady(page);
		await expect(page.locator('#rounds .round-card')).toHaveCount(3);
		await expect(pickOf(page, 2)).toBeDisabled();
		await pickOf(page, 1).check();
		await pickOf(page, 1).focus();
		const thumb = page.locator('#rounds img.thumb').first();
		await thumb.evaluate((img) => ((img as HTMLImageElement & { marked?: boolean }).marked = true));
		const seen = polls;
		await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThanOrEqual(seen + 2);
		await expect(pickOf(page, 1)).toBeChecked();
		await expect(pickOf(page, 1)).toBeFocused();
		await expect(page.locator('#bulk-count')).toHaveText('1 selected');
		expect(await thumb.evaluate((img) => Boolean((img as HTMLImageElement & { marked?: boolean }).marked)), 'the same picture element survives each poll').toBe(true);
		await page.locator('#bulk-all').check();
		await expect(page.locator('#bulk-count')).toHaveText('2 selected');
		await shot(page, `bulk/after-poll-${width}`);
		await page.unroute(ROUNDS_LIST_API);
		await page.context().close();
	});
}
