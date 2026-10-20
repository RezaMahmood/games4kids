import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, signInAtFakeEntra } from './support.ts';

const SCREENS = [
	{ name: 'phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
	{ name: 'desktop', options: { viewport: { width: 1280, height: 800 } } },
] as const;

const people = (admin: Page) => admin.getByRole('list', { name: 'People' }).getByRole('button');
const chip = (admin: Page, label: string) => admin.getByRole('radio', { name: new RegExp(`^${label} \\d+$`) });

async function save(admin: Page, email: string, game: string): Promise<void> {
	await admin.getByRole('button', { name: 'Add person' }).click();
	const add = admin.getByRole('dialog', { name: 'Add a person' });
	await add.getByLabel('Email').fill(email);
	await add.getByLabel(game).check();
	await add.getByRole('button', { name: 'Save person' }).click();
	await expect(add.getByRole('status')).toHaveText(`Saved ${email}. Sync now so their sign-in works.`);
	await add.getByRole('button', { name: 'Close' }).click();
	await expect(add).toBeHidden();
}

for (const screen of SCREENS) {
	test(`on a ${screen.name}, the members page finds people, flags who needs a sync, and changes one person in their sheet`, async ({ browser }) => {
		const run = `${screen.name}-${Date.now().toString(36)}`;
		const [ada, ben, cy, dee] = ['ada', 'ben', 'cy', 'dee'].map((name) => `${name}-${run}@example.com`) as [string, string, string, string];
		const context = await browser.newContext({ ignoreHTTPSErrors: true, ...screen.options });
		const admin = await context.newPage();
		answerPopups(admin);
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await adminReady(admin);

		await test.step('people saved without a sync raise the attention banner', async () => {
			await save(admin, ada, 'Draw Pad');
			await save(admin, ben, 'Letter Tracing');
			await save(admin, cy, 'Draw Pad');
			await expect(admin.getByText(/^\d+ (people aren’t|person isn’t) synced with Entra\.$/)).toBeVisible();
			await expect(admin.getByRole('button', { name: 'Sync now' })).toBeVisible();
		});

		await test.step('the search narrows the list live and the chips count within it', async () => {
			await admin.getByRole('searchbox', { name: 'Search people' }).fill(run);
			await expect(people(admin)).toHaveCount(3);
			await expect(chip(admin, 'Needs sync')).toHaveAccessibleName('Needs sync 3');
			await admin.getByRole('searchbox', { name: 'Search people' }).fill(`ben-${run}`);
			await expect(people(admin)).toHaveCount(1);
			await expect(people(admin).first()).toContainText(ben);
			await expect(people(admin).first()).toContainText('Letter Tracing');
			await expect(people(admin).first()).toContainText('Not synced');
			await admin.getByRole('searchbox', { name: 'Search people' }).fill(`nobody-${run}`);
			await expect(admin.getByText(`No one matches “nobody-${run}”.`)).toBeVisible();
			await admin.getByRole('button', { name: 'Show everyone' }).click();
			await expect(admin.getByRole('searchbox', { name: 'Search people' })).toHaveValue('');
			await admin.getByRole('searchbox', { name: 'Search people' }).fill(run);
		});

		await test.step('changing games in the sheet saves them and the list shows the new summary', async () => {
			await people(admin).filter({ hasText: ada }).click();
			const sheet = admin.getByRole('dialog', { name: ada });
			expect(await sheet.evaluate((dialog) => dialog.contains(document.activeElement)), 'focus moves into the sheet').toBe(true);
			await sheet.getByLabel('Letter Tracing').check();
			await sheet.getByRole('button', { name: 'Save games' }).click();
			await expect(sheet.getByRole('status')).toHaveText(`Saved games for ${ada}.`);
			await expect(sheet.getByLabel('Letter Tracing')).toBeChecked();
			await admin.keyboard.press('Escape');
			await expect(sheet).toBeHidden();
			await expect(people(admin).filter({ hasText: ada })).toBeFocused();
			await expect(people(admin).filter({ hasText: ada })).toContainText('Draw Pad, Letter Tracing');
		});

		await test.step('a revoke asks first, can be cancelled, and once confirmed moves the person to Revoked', async () => {
			await people(admin).filter({ hasText: cy }).click();
			const sheet = admin.getByRole('dialog', { name: cy });
			await sheet.getByRole('button', { name: 'Revoke access' }).click();
			await expect(sheet.getByText(`Revoke ${cy}? Their next call is refused.`)).toBeVisible();
			await sheet.getByRole('button', { name: 'Cancel' }).click();
			await expect(sheet.getByRole('button', { name: 'Yes, revoke' })).toHaveCount(0);
			await sheet.getByRole('button', { name: 'Revoke access' }).click();
			await sheet.getByRole('button', { name: 'Yes, revoke' }).click();
			await expect(sheet.getByRole('status')).toContainText(`${cy} is revoked. Their next call is refused.`);
			await expect(sheet.getByRole('button', { name: 'Restore access' })).toBeVisible();
			await sheet.getByRole('button', { name: 'Close' }).click();
			await chip(admin, 'Revoked').check();
			await expect(people(admin)).toHaveCount(1);
			await expect(people(admin).first()).toContainText(cy);
			await expect(people(admin).first()).toContainText('Revoked');
			await chip(admin, 'Active').check();
			await expect(people(admin)).toHaveCount(2);
			await chip(admin, 'All').check();
			await expect(people(admin)).toHaveCount(3);
		});

		await test.step('a new person is saved and synced without leaving the add sheet', async () => {
			await admin.getByRole('button', { name: 'Add person' }).click();
			const add = admin.getByRole('dialog', { name: 'Add a person' });
			await expect(add.getByLabel('Email')).toBeFocused();
			await add.getByLabel('Email').fill(dee);
			await add.getByLabel('Every game, including new ones').check();
			await add.getByRole('button', { name: 'Save person' }).click();
			await expect(add.getByRole('status')).toHaveText(`Saved ${dee}. Sync now so their sign-in works.`);
			await expect(add).toContainText('Games: All games.');
			await add.getByRole('button', { name: 'Sync now' }).click();
			await expect(add.getByRole('status')).toHaveText(`${dee} is synced with Entra and can sign in now.`);
			await add.getByRole('button', { name: 'Done' }).click();
			await expect(admin.getByRole('button', { name: 'Add person' })).toBeFocused();
			await expect(people(admin).filter({ hasText: dee })).toContainText('Active');
		});

		await test.step('one tap on the banner syncs everyone and the banner goes quiet', async () => {
			await admin.getByRole('button', { name: 'Sync now' }).click();
			await expect(admin.locator('#status')).toHaveText('Everyone is synced with Entra.');
			await expect(admin.locator('main').getByText('Entra and this list agree.')).toBeVisible();
			await expect(chip(admin, 'Needs sync')).toHaveAccessibleName('Needs sync 0');
			await expect(people(admin).filter({ hasText: ben })).toContainText('Active');
		});

		await context.close();
	});
}
