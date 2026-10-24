import { expect, test } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, openBarMenu, signInAtFakeEntra } from './support.ts';

test('the admin bar keeps Games and the account in menus that work by keyboard and name where you are', async ({ page }) => {
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
	const bar = page.locator('admin-bar .g4k-bar');
	const nav = page.getByRole('navigation', { name: 'Admin' });
	const gamesButton = bar.getByRole('button', { name: /^Games/ });

	await test.step('on Members the bar marks Members and shows no menu open', async () => {
		await expect(nav.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
		await expect(bar.locator('[aria-expanded="true"]')).toHaveCount(0);
		await expect(bar.getByRole('button', { name: `Account, signed in as ${ADMIN_EMAIL}` })).toHaveText('A');
	});

	await test.step('Enter on Games opens the menu and puts focus on its first item, and Escape closes it and returns focus', async () => {
		await gamesButton.focus();
		await page.keyboard.press('Enter');
		await expect(gamesButton).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('link', { name: 'Pause and resume games' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(gamesButton).toHaveAttribute('aria-expanded', 'false');
		await expect(gamesButton).toBeFocused();
	});

	await test.step('a click outside closes a menu, and opening the account menu closes Games', async () => {
		await openBarMenu(page, 'Games');
		await page.mouse.click(10, page.viewportSize()!.height - 10);
		await expect(gamesButton).toHaveAttribute('aria-expanded', 'false');
		await openBarMenu(page, 'Games');
		const account = await openBarMenu(page, 'Account');
		await expect(gamesButton).toHaveAttribute('aria-expanded', 'false');
		await expect(account).toContainText(ADMIN_EMAIL);
		await expect(account.getByRole('button', { name: 'Sign out' })).toBeFocused();
	});

	await test.step('Tab out of the open account menu closes it', async () => {
		await page.keyboard.press('Tab');
		await expect(bar.getByRole('button', { name: /^Account/ })).toHaveAttribute('aria-expanded', 'false');
	});

	await test.step('every game with an admin part is in the Games menu, reachable, and marked when you are on it', async () => {
		const names: string[] = [];
		const panel = await openBarMenu(page, 'Games');
		const gameLinks = panel.getByRole('list', { name: 'Game admin pages' }).getByRole('link');
		for (const link of await gameLinks.all()) names.push((await link.textContent())!);
		expect(names).toEqual(expect.arrayContaining(['Letter Tracing', 'Time Detectives']));
		await page.keyboard.press('Escape');
		for (const name of names) {
			const menu = await openBarMenu(page, 'Games');
			await menu.getByRole('link', { name, exact: true }).click();
			await adminReady(page);
			await expect(page.getByRole('button', { name: `Games, now on ${name}` })).toBeVisible();
			await expect(bar.locator('.menu.holds-current')).toHaveCount(1);
			const open = await openBarMenu(page, 'Games');
			await expect(open.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
			await expect(open.getByRole('link', { name: 'Pause and resume games' })).not.toHaveAttribute('aria-current', 'page');
			await page.keyboard.press('Escape');
		}
	});

	await test.step('the pause page is marked in the menu, and each game row has an Open admin link that leads to the game', async () => {
		const panel = await openBarMenu(page, 'Games');
		await panel.getByRole('link', { name: 'Pause and resume games' }).click();
		await adminReady(page);
		await expect(page.getByRole('heading', { name: 'Pause and resume games', level: 1 })).toBeVisible();
		const open = await openBarMenu(page, 'Games');
		await expect(open.getByRole('link', { name: 'Pause and resume games' })).toHaveAttribute('aria-current', 'page');
		await page.keyboard.press('Escape');
		const rows = page.getByRole('list', { name: 'Pause and resume games' }).getByRole('listitem');
		await rows.filter({ hasText: 'Time Detectives' }).getByRole('link', { name: 'Open admin' }).click();
		await adminReady(page);
		await expect(page).toHaveURL(/\/g\/timedetectives\//);
	});

	await test.step('Sign out in the account menu signs the admin out', async () => {
		const account = await openBarMenu(page, 'Account');
		await account.getByRole('button', { name: 'Sign out' }).click();
		await expect(page.locator('admin-bar .g4k-bar')).toHaveCount(0);
	});
});
