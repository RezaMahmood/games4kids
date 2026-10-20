import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, addAndSync, adminReady, answerPopups, signInAtFakeEntra } from './support.ts';

const SCREENS = [
	{ name: 'phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
	{ name: 'desktop', options: { viewport: { width: 1280, height: 800 } } },
] as const;

const MEMBERS = '**/api/admin/portal/members';
const ENTRA = '**/api/admin/portal/entra';
const SYNC = '**/api/admin/portal/entra/sync';

type Screen = (typeof SCREENS)[number];

const people = (admin: Page) => admin.getByRole('list', { name: 'People' }).getByRole('button');
const chip = (admin: Page, label: string) => admin.getByRole('radio', { name: new RegExp(`^${label} \\d+$`) });
const banner = (admin: Page) => admin.locator('#attention .banner');
const bannerTitle = (admin: Page) => admin.locator('#attention .banner-title');

const fakeRow = (userId: string, email: string, state: 'active' | 'revoked' = 'active') => ({ member: { userId, state, games: { kind: 'some', ids: ['drawpad'] } }, email, objectId: `o-${userId}`, profile: null });

async function signedIn(browser: Browser, screen: Screen, before: (admin: Page) => Promise<void> = async () => {}): Promise<Page> {
	const context = await browser.newContext({ ignoreHTTPSErrors: true, ...screen.options });
	const admin = await context.newPage();
	answerPopups(admin);
	await before(admin);
	await admin.goto(`${ADMIN}/`);
	await signInAtFakeEntra(admin, ADMIN_EMAIL);
	await adminReady(admin);
	return admin;
}

async function answerMembers(admin: Page, rows: readonly unknown[]): Promise<void> {
	await admin.route(MEMBERS, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: rows }) : route.fallback()));
}

/** Each Entra check answers with the next drift list. */
async function answerChecks(admin: Page, answers: readonly unknown[][]): Promise<void> {
	const queue = [...answers];
	await admin.route(ENTRA, (route) => route.fulfill({ json: queue.shift() ?? [] }));
}

/** Holds the first matching request until the returned function runs. */
async function holdFirst(admin: Page, url: string, method: string): Promise<{ readonly release: () => void; readonly arrived: Promise<void> }> {
	let release!: () => void;
	let arrive!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const arrived = new Promise<void>((resolve) => (arrive = resolve));
	let first = true;
	await admin.route(url, async (route: Route) => {
		if (route.request().method() !== method || !first) return route.fallback();
		first = false;
		arrive();
		await held;
		return route.fallback();
	});
	return { release, arrived };
}

for (const screen of SCREENS) {
	test(`on a ${screen.name}, with no one added the banner still offers Check Entra, and the report offers Sync everyone`, async ({ browser }) => {
		const admin = await signedIn(browser, screen, async (page) => {
			await answerMembers(page, []);
			await answerChecks(page, [[]]);
		});
		await expect(admin.getByText('No one has been added yet.')).toBeVisible();
		await expect(bannerTitle(admin)).toHaveText('Not checked against Entra yet.');
		await admin.getByRole('button', { name: 'Check Entra' }).click();
		const report = admin.getByRole('dialog', { name: 'Entra report' });
		await expect(report.getByRole('status')).toHaveText('Checked Entra.');
		await expect(report.getByRole('heading', { name: 'Entra report' }), 'the sheet opens on its heading, not on Close').toBeFocused();
		await expect(report.getByRole('button', { name: 'Sync everyone' })).toBeVisible();
		await report.getByRole('button', { name: 'Close' }).click();
		await expect(bannerTitle(admin)).toHaveText('Entra and this list agree.');
		await admin.context().close();
	});

	test(`on a ${screen.name}, the banner says Entra agrees only after a check that came back empty`, async ({ browser }) => {
		const unmanaged = { kind: 'unmanaged', assignment: { objectId: 'o-stranger', assignmentId: 'a-stranger' } };
		const admin = await signedIn(browser, screen, async (page) => {
			await answerMembers(page, [fakeRow('u-ada', 'ada@example.com'), fakeRow('u-ben', 'ben@example.com')]);
			await answerChecks(page, [[unmanaged], []]);
		});
		await expect(bannerTitle(admin)).toHaveText('Not checked against Entra yet.');
		await expect(admin.locator('main')).not.toContainText('agree');
		await admin.getByRole('button', { name: 'Check Entra' }).click();
		const report = admin.getByRole('dialog', { name: 'Entra report' });
		await expect(report.getByRole('list', { name: 'What Entra reported' })).toContainText('Entra has an assignment this page does not manage.');
		await report.getByRole('button', { name: 'Close' }).click();
		await expect(bannerTitle(admin)).toHaveText('1 note from Entra.');
		await expect(admin.locator('main')).not.toContainText('agree');
		await expect(banner(admin).getByRole('button', { name: 'See report' })).toBeVisible();
		await banner(admin).getByRole('button', { name: 'See report' }).click();
		await report.getByRole('button', { name: 'Check again' }).click();
		await expect(report.getByRole('status')).toHaveText('Checked Entra.');
		await report.getByRole('button', { name: 'Close' }).click();
		await expect(bannerTitle(admin)).toHaveText('Entra and this list agree.');
		await admin.context().close();
	});

	test(`on a ${screen.name}, Entra's ambiguous, taken and wrong accounts show in the banner by name`, async ({ browser }) => {
		const admin = await signedIn(browser, screen, async (page) => {
			const filler = Array.from({ length: 20 }, (_, index) => fakeRow(`u-${index}`, `filler-${index}@example.com`));
			await answerMembers(page, [fakeRow('u-riz', 'riz74@hotmail.com'), fakeRow('u-mum', 'mum@example.com'), fakeRow('u-dad', 'dad@example.com'), ...filler]);
			await answerChecks(page, [
				[
					{ kind: 'ambiguous-account', userId: 'u-riz', email: 'riz74@hotmail.com', userPrincipalNames: ['a@tenant.example', 'b@tenant.example'] },
					{ kind: 'account-taken', userId: 'u-mum', email: 'mum@example.com', account: 'o-riz', owner: 'u-riz' },
					{ kind: 'wrong-account', userId: 'u-dad', email: 'dad@example.com', linked: 'o-dad', account: 'o-dad2', assignment: null },
				],
			]);
		});
		await admin.getByRole('button', { name: 'Check Entra' }).click();
		const report = admin.getByRole('dialog', { name: 'Entra report' });
		await expect(report.getByRole('status')).toHaveText('Checked Entra.');
		await expect(report.locator('#drift li.alarm')).toHaveText([
			'riz74@hotmail.com matches more than one Entra account: a@tenant.example, b@tenant.example. Nothing was changed.',
			'mum@example.com matches the Entra account riz74@hotmail.com signs in with. Nothing was changed.',
		]);
		await expect(report).not.toContainText('does not recognise');
		await report.getByRole('button', { name: 'Close' }).click();

		await expect(banner(admin)).toHaveClass(/alarm/);
		await expect(bannerTitle(admin)).toHaveText('Entra raised 2 alarms.');
		await expect(admin.getByRole('alert').getByRole('listitem')).toHaveText([
			'riz74@hotmail.com matches more than one Entra account: a@tenant.example, b@tenant.example. Nothing was changed.',
			'mum@example.com matches the Entra account riz74@hotmail.com signs in with. Nothing was changed.',
		]);
		await expect(banner(admin)).toContainText('1 person isn’t synced with Entra.');
		await expect(banner(admin).getByRole('button', { name: 'Sync now' })).toBeVisible();
		await expect(people(admin).filter({ hasText: 'dad@example.com' })).toContainText('Not synced');
		await expect(chip(admin, 'Needs sync')).toHaveAccessibleName('Needs sync 1');

		expect(await admin.evaluate(() => (scrollTo(0, document.body.scrollHeight), scrollY)), 'the list scrolls').toBeGreaterThan(0);
		const box = await banner(admin).boundingBox();
		expect(box !== null && box.y >= 0 && box.y + box.height <= screen.options.viewport.height, 'the banner stays on screen in the sticky toolbar').toBe(true);
		await admin.context().close();
	});

	test(`on a ${screen.name}, a revoke shows a sync is needed until a sync confirms it, and focus never drops to the page`, async ({ browser }) => {
		const run = `${screen.name}-${Date.now().toString(36)}`;
		const kid = `revoke-${run}@example.com`;
		const admin = await signedIn(browser, screen);
		await addAndSync(admin, kid, 'Draw Pad');
		const search = admin.getByRole('searchbox', { name: 'Search people' });
		await search.fill(kid);
		await expect(people(admin).first()).toContainText('Active');

		await chip(admin, 'Active').check();
		await people(admin).first().click();
		const sheet = admin.getByRole('dialog', { name: kid });
		await expect(sheet.getByRole('heading', { name: kid }), 'the sheet opens on its heading, not on Close').toBeFocused();
		await sheet.getByRole('button', { name: 'Revoke access' }).click();
		await sheet.getByRole('button', { name: 'Yes, revoke' }).click();
		await expect(sheet.getByRole('status')).toContainText(`${kid} is revoked.`);
		await expect(sheet.getByText('Revoked, sync needed')).toBeVisible();
		await sheet.getByRole('button', { name: 'Close' }).click();
		await expect(search, 'the row left the Active list, so focus goes to the search').toBeFocused();

		await chip(admin, 'All').check();
		await expect(people(admin).first()).toContainText('Revoked, sync needed');
		await expect(chip(admin, 'Needs sync')).toHaveAccessibleName('Needs sync 1');
		await banner(admin).getByRole('button', { name: 'Sync now' }).click();
		await expect(admin.locator('#status')).toHaveText('Everyone is synced with Entra.');
		await expect(people(admin).first()).toContainText(/Revoked$/);
		await expect(chip(admin, 'Needs sync')).toHaveAccessibleName('Needs sync 0');
		await expect(bannerTitle(admin), 'Sync now is gone, so focus goes to the banner heading').toBeFocused();
		await admin.context().close();
	});

	test(`on a ${screen.name}, a save that finishes after the sheet moved to someone else leaves that sheet alone`, async ({ browser }) => {
		const run = `${screen.name}-${Date.now().toString(36)}`;
		const [ada, ben] = [`race-ada-${run}@example.com`, `race-ben-${run}@example.com`];
		const admin = await signedIn(browser, screen);
		await addAndSync(admin, ada, 'Draw Pad');
		await addAndSync(admin, ben, 'Letter Tracing');
		await admin.getByRole('searchbox', { name: 'Search people' }).fill(`race-`);

		const slow = await holdFirst(admin, `${MEMBERS}/*`, 'PUT');
		await people(admin).filter({ hasText: ada }).click();
		const adaSheet = admin.getByRole('dialog', { name: ada });
		await adaSheet.getByLabel('Letter Tracing').check();
		await adaSheet.getByRole('button', { name: 'Save games' }).click();
		await slow.arrived;
		await admin.keyboard.press('Escape');
		await expect(adaSheet).toBeHidden();
		await people(admin).filter({ hasText: ben }).click();
		const benSheet = admin.getByRole('dialog', { name: ben });
		await expect(benSheet).toBeVisible();
		slow.release();

		await expect(admin.locator('#status')).toHaveText(`Saved games for ${ada}.`);
		await expect(benSheet).toBeVisible();
		await expect(admin.locator('#person-title')).toHaveText(ben);
		await expect(benSheet.getByLabel('Letter Tracing')).toBeChecked();
		await expect(benSheet.getByLabel('Draw Pad')).not.toBeChecked();
		await expect(admin.locator('#person-status'), 'ada’s message stays out of ben’s sheet').toBeEmpty();
		const put = admin.waitForRequest((request) => request.method() === 'PUT');
		await benSheet.getByRole('button', { name: 'Save games' }).click();
		const benId = await people(admin).filter({ hasText: ben }).getAttribute('data-user-id');
		expect((await put).url(), 'the next tap acts on the person on screen').toMatch(new RegExp(`/members/${benId}$`));
		await expect(benSheet.getByRole('status')).toHaveText(`Saved games for ${ben}.`);
		await admin.context().close();
	});

	test(`on a ${screen.name}, only one sync runs at a time and every sync button waits for it`, async ({ browser }) => {
		const run = `${screen.name}-${Date.now().toString(36)}`;
		const kid = `guard-${run}@example.com`;
		const admin = await signedIn(browser, screen);
		await admin.getByRole('button', { name: 'Add person' }).click();
		const add = admin.getByRole('dialog', { name: 'Add a person' });
		await add.getByLabel('Email').fill(kid);
		await add.getByLabel('Draw Pad').check();
		await add.getByRole('button', { name: 'Save person' }).click();
		await expect(add.getByRole('status')).toHaveText(`Saved ${kid}. Sync now so their sign-in works.`);
		await add.getByRole('button', { name: 'Close' }).click();

		let syncs = 0;
		admin.on('request', (request) => void (request.method() === 'POST' && request.url().endsWith('/entra/sync') && syncs++));
		const slow = await holdFirst(admin, SYNC, 'POST');
		await banner(admin).getByRole('button', { name: 'Sync now' }).click();
		await slow.arrived;
		await expect(banner(admin).getByRole('button', { name: 'Sync now' })).toBeDisabled();
		await admin.getByRole('searchbox', { name: 'Search people' }).fill(kid);
		await people(admin).first().click();
		const sheet = admin.getByRole('dialog', { name: kid });
		await expect(sheet.getByRole('button', { name: 'Sync with Entra' })).toBeDisabled();
		await sheet.getByRole('button', { name: 'Sync with Entra' }).dispatchEvent('click');
		await expect(admin.locator('#sync-all')).toBeDisabled();
		slow.release();

		await expect(admin.locator('#status')).toHaveText('Everyone is synced with Entra.');
		await expect(sheet.getByRole('button', { name: 'Sync with Entra' })).toBeEnabled();
		expect(syncs, 'the tap during the first sync sent nothing').toBe(1);
		await admin.context().close();
	});
}
