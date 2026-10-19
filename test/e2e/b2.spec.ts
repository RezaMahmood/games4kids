import { expect, test, type Page } from '@playwright/test';
import { PORT_BASE } from './ports.ts';

const GAMES = `http://localhost:${PORT_BASE}`;
const ADMIN = `http://localhost:${PORT_BASE + 1}`;
const TELEMETRY = `http://localhost:${PORT_BASE + 3}`;
const IDP_CONTROL = `http://localhost:${PORT_BASE + 5}`;
const ADMIN_EMAIL = 'admin@example.com';
const RUN = Date.now().toString(36);
const KID_EMAIL = `kid-${RUN}@example.com`;
const KID_NAME = `Ada${RUN}`;

async function signInAtFakeEntra(page: Page, email: string): Promise<void> {
	await page.waitForURL('**/oauth2/v2.0/authorize?**');
	await page.getByLabel('Email').fill(email);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The fake popup asks for credentials again, as prompt=login does, so the test answers it. Returns how many opened. */
function answerPopups(page: Page): { readonly opened: () => number } {
	let opened = 0;
	page.on('popup', async (popup) => {
		opened += 1;
		await popup.waitForLoadState('domcontentloaded');
		await expect(popup.getByText('Credentials are required again')).toBeVisible();
		await expect(popup.getByLabel('Email')).toHaveValue(ADMIN_EMAIL);
		await popup.getByRole('button', { name: 'Sign in' }).click();
	});
	return { opened: () => opened };
}

async function authorizations(page: Page): Promise<readonly { clientId: string; prompt: string | null; scope: string }[]> {
	return (await page.request.get(`${IDP_CONTROL}/__control/authorizations`)).json();
}

test('B2: a member is saved with one game, synced in a popup, plays only that game, is refused after a revoke, and a stale sign-in steps up', async ({ browser }) => {
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const kidContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const admin = await adminContext.newPage();
	const kid = await kidContext.newPage();
	const popups = answerPopups(admin);

	await test.step('the admin signs in to the admin site', async () => {
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await expect(admin.getByRole('heading', { name: 'Members' })).toBeVisible();
		await expect(admin.getByRole('navigation', { name: 'Admin' })).toContainText(ADMIN_EMAIL);
	});

	await test.step('a member is saved with one game ticked and nothing else', async () => {
		const add = admin.getByRole('region', { name: 'Add a member' });
		await expect(add.getByLabel('Fixture')).not.toBeChecked();
		await expect(add.getByLabel('Puzzle')).not.toBeChecked();
		await add.getByLabel('Email').fill(KID_EMAIL);
		await add.getByLabel('Fixture').check();
		await add.getByRole('button', { name: 'Save member' }).click();
		await expect(admin.getByRole('status')).toHaveText(`Saved ${KID_EMAIL}.`);
		const row = admin.getByRole('row', { name: new RegExp(KID_EMAIL) });
		await expect(row).toContainText('Active');
		await expect(row).toContainText('Not synced');
		await expect(row.getByLabel('Fixture')).toBeChecked();
		await expect(row.getByLabel('Puzzle')).not.toBeChecked();
		expect(popups.opened(), 'saving a member needs no elevation').toBe(0);
	});

	await test.step('a sync opens a fake popup that asks for credentials again, then links the account', async () => {
		const seen = (await authorizations(admin)).length;
		await admin.getByRole('button', { name: `Sync ${KID_EMAIL} with Entra` }).click();
		await expect(admin.getByRole('status')).toHaveText('Synced with Entra.');
		await expect(admin.getByRole('row', { name: new RegExp(KID_EMAIL) })).toContainText('Linked');
		expect(popups.opened()).toBe(1);
		const elevation = (await authorizations(admin)).slice(seen).filter((a) => a.scope.includes('admin.elevate'));
		expect(elevation.map((a) => a.prompt)).toEqual(['login']);
	});

	await test.step('the child signs in, chooses a name, and sees only the game that was ticked', async () => {
		await kid.goto(`${GAMES}/`);
		await signInAtFakeEntra(kid, KID_EMAIL);
		await expect(kid.getByRole('heading', { name: 'Choose your name' })).toBeVisible();
		await kid.getByLabel('Your name in games').fill(KID_NAME);
		await kid.getByRole('button', { name: "Let's play" }).click();
		await expect(kid.getByRole('heading', { name: 'My games' })).toBeVisible();
		await expect(kid.getByRole('banner')).toContainText(`Playing as ${KID_NAME}`);
		const cards = kid.getByRole('list', { name: 'My games' }).getByRole('link');
		await expect(cards).toHaveCount(1);
		await expect(cards.first()).toContainText('Fixture');
		await expect(kid.getByText('Puzzle')).toHaveCount(0);
	});

	await test.step('the granted game plays, and the other one is refused even by its address', async () => {
		await kid.getByRole('link', { name: /Fixture/ }).click();
		await expect(kid.getByRole('heading', { name: `Hello ${KID_NAME}` })).toBeVisible();
		await expect(kid.locator('#levels')).toHaveText('0 levels');
		await kid.goto(`${GAMES}/g/puzzle/`);
		await expect(kid.getByRole('heading', { name: 'This game is not switched on for you' })).toBeVisible();
		await kid.goto(`${GAMES}/g/fixture/`);
		await expect(kid.getByRole('heading', { name: `Hello ${KID_NAME}` })).toBeVisible();
	});

	await test.step('the shells tell telemetry which game each page was', async () => {
		await expect
			.poll(async () => {
				const events = (await (await kid.request.get(`${TELEMETRY}/__events`)).json()) as { data: { baseData: { properties: { game: string; name: string } } } }[];
				return events.map((event) => `${event.data.baseData.properties.name}:${event.data.baseData.properties.game}`);
			})
			.toEqual(expect.arrayContaining(['page_view:portal', 'page_view:fixture']));
	});

	await test.step('a revoke is refused on the child\'s very next call, with no reload', async () => {
		await admin.getByRole('row', { name: new RegExp(KID_EMAIL) }).getByRole('button', { name: 'Revoke' }).click();
		await expect(admin.getByRole('status')).toHaveText(`${KID_EMAIL} is revoked. Their next call is refused.`);
		await kid.getByRole('button', { name: 'Look again' }).click();
		await expect(kid.getByRole('alert')).toHaveText('Ask your grown-up to invite you.');
	});

	await test.step('a sign-in 11 minutes old is refused for Entra, and the shell reopens the popup once', async () => {
		await admin.request.post(`${IDP_CONTROL}/__control/stale-auth-time?minutes=11&count=1`);
		const before = popups.opened();
		await admin.getByRole('button', { name: 'Check Entra' }).click();
		await expect(admin.getByRole('status')).toHaveText('Checked Entra.');
		expect(popups.opened() - before, 'the stale token opened one popup and the retry opened one more').toBe(2);
		await expect(admin.locator('#drift')).toContainText(`${KID_EMAIL} is revoked but still assigned in Entra`);
	});

	await adminContext.close();
	await kidContext.close();
});
