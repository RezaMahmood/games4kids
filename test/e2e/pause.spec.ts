import { expect, test, type Page } from '@playwright/test';
import { PORT_BASE } from './ports.ts';
import { ADMIN_EMAIL, adminReady, answerPopups, pageReady, signInAtFakeEntra } from './support.ts';

const GAMES = `http://localhost:${PORT_BASE}`;
const ADMIN = `http://localhost:${PORT_BASE + 1}`;
const RUN = Date.now().toString(36);
const KID_EMAIL = `pause-${RUN}@example.com`;

const puzzleRow = (admin: Page) => admin.getByRole('list', { name: 'Games' }).getByRole('listitem').filter({ hasText: 'Puzzle' });

/** Another spec on this stack lists Puzzle as a link, so a run that stopped half way must not leave it paused. */
async function makePuzzleAvailable(admin: Page): Promise<void> {
	await admin.goto(`${ADMIN}/games/`);
	await adminReady(admin);
	const again = puzzleRow(admin).getByRole('button', { name: 'Make available' });
	if (await again.isVisible()) {
		await again.click();
		await expect(puzzleRow(admin)).toContainText('Available');
	}
}

test('a paused game stays on the child’s home, greyed out and closed, and opens again once the admin makes it available', async ({ browser }) => {
	test.setTimeout(120_000);
	const adminContext = await browser.newContext();
	const kidContext = await browser.newContext();
	const admin = await adminContext.newPage();
	const kid = await kidContext.newPage();
	answerPopups(admin);

	await admin.goto(`${ADMIN}/`);
	await signInAtFakeEntra(admin, ADMIN_EMAIL);
	await adminReady(admin);
	try {
		await test.step('the admin adds a child with both games', async () => {
			await admin.getByRole('button', { name: 'Add person' }).click();
			const add = admin.getByRole('dialog', { name: 'Add a person' });
			await add.getByLabel('Email').fill(KID_EMAIL);
			await add.getByLabel('Fixture').check();
			await add.getByLabel('Puzzle').check();
			await add.getByRole('button', { name: 'Save person' }).click();
			await add.getByRole('button', { name: 'Sync now' }).click();
			await expect(add.getByRole('status')).toHaveText(`${KID_EMAIL} is synced with Entra and can sign in now.`);
			await add.getByRole('button', { name: 'Done' }).click();
		});

		await test.step('the child signs in and sees both games as links', async () => {
			await kid.goto(`${GAMES}/`);
			await signInAtFakeEntra(kid, KID_EMAIL);
			await pageReady(kid);
			await kid.getByLabel('Your name in games').fill(`P${RUN}`);
			await kid.getByRole('button', { name: "Let's play" }).click();
			await expect(kid.getByRole('list', { name: 'My games' }).getByRole('link')).toHaveCount(2);
		});

		await test.step('the admin opens Games from the bar and pauses Puzzle', async () => {
			await admin.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name: 'Games', exact: true }).click();
			await adminReady(admin);
			await expect(admin.getByRole('heading', { name: 'Games' })).toBeVisible();
			await expect(puzzleRow(admin)).toContainText('Available');
			await expect(admin.getByRole('list', { name: 'Games' }).getByRole('listitem').filter({ hasText: 'Fixture' })).toContainText('Available');
			await puzzleRow(admin).getByRole('button', { name: 'Pause' }).click();
			await expect(admin.getByRole('status')).toHaveText('Paused Puzzle. Players see it greyed out.');
			await expect(puzzleRow(admin)).toContainText('Paused');
			await expect(puzzleRow(admin).getByRole('button', { name: 'Make available' })).toBeFocused();
		});

		await test.step('the child’s home shows Puzzle greyed out with a label, and it is no link', async () => {
			await kid.reload();
			await pageReady(kid);
			const games = kid.getByRole('list', { name: 'My games' });
			await expect(games.getByRole('link')).toHaveCount(1);
			await expect(games.getByRole('link', { name: /Fixture/ })).toBeVisible();
			await expect(games.getByRole('link', { name: /Puzzle/ })).toHaveCount(0);
			const paused = games.getByRole('listitem').filter({ hasText: 'Puzzle' });
			await expect(paused).toContainText('Paused for now');
			await expect(paused.locator('[aria-disabled="true"]')).toHaveCount(1);
			const grey = await paused.locator('img').evaluate((icon) => getComputedStyle(icon).filter);
			expect(grey, 'the icon is greyscale').toContain('grayscale');
			await paused.click();
			await expect(kid, 'a tap on the paused card goes nowhere').toHaveURL(`${GAMES}/`);
		});

		await test.step('the game’s address shows the paused screen, which leads back home', async () => {
			await kid.goto(`${GAMES}/g/puzzle/`);
			await expect(kid.getByRole('heading', { name: 'This game is having a rest' })).toBeVisible();
			await expect(kid.getByText('Your grown-up has paused it for now. Try again later.')).toBeVisible();
			await pageReady(kid);
			await kid.getByRole('button', { name: 'Back to my games' }).click();
			await expect(kid.getByRole('heading', { name: 'My games' })).toBeVisible();
		});

		await test.step('the admin makes Puzzle available, and the child opens it from home', async () => {
			await puzzleRow(admin).getByRole('button', { name: 'Make available' }).click();
			await expect(admin.getByRole('status')).toHaveText('Puzzle is available again. Players can open it.');
			await expect(puzzleRow(admin)).toContainText('Available');
			await kid.reload();
			await pageReady(kid);
			await kid.getByRole('list', { name: 'My games' }).getByRole('link', { name: /Puzzle/ }).click();
			await expect(kid.getByRole('heading', { name: /^Puzzle says hello/ })).toBeVisible();
		});
	} finally {
		await makePuzzleAvailable(admin);
		await kidContext.close();
		await adminContext.close();
	}
});
