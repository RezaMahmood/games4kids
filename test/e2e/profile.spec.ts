import { expect, test, type Browser, type Page } from '@playwright/test';
import { addAndSync, ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, pageReady, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const SIZES = [
	{ name: 'on a desktop', options: { viewport: { width: 1280, height: 800 } } },
	{ name: 'on a phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

/** A child the admin invited, signed in and named, on their home page. */
async function namedChild(browser: Browser, admin: Page, email: string, name: string, options: Parameters<Browser['newContext']>[0]): Promise<Page> {
	await addAndSync(admin, email, 'Draw Pad');
	const context = await browser.newContext({ ignoreHTTPSErrors: true, ...options });
	const kid = await context.newPage();
	await kid.goto(`${GAMES}/`);
	await signInAtFakeEntra(kid, email);
	await pageReady(kid);
	await kid.getByLabel('Your name in games').fill(name);
	await kid.getByRole('button', { name: "Let's play" }).click();
	await expect(kid.getByRole('banner')).toContainText(`Playing as ${name}`);
	return kid;
}

for (const { name, options } of SIZES) {
	test(`${name}, a child renames themselves from the portal bar, and a taken or unkind name is refused`, async ({ browser }) => {
		test.setTimeout(180_000);
		const tag = `${RUN}${name.length}`;
		const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
		const admin = await adminContext.newPage();
		answerPopups(admin);
		await admin.goto(`${ADMIN}/`);
		await signInAtFakeEntra(admin, ADMIN_EMAIL);
		await adminReady(admin);

		const kid = await namedChild(browser, admin, `rename-${tag}@example.com`, `Ada${tag}`, options);
		const friend = await namedChild(browser, admin, `friend-${tag}@example.com`, `Bea${tag}`, options);
		const problems = collectProblems([kid, friend]);

		await kid.getByRole('banner').getByRole('link', { name: `Ada${tag}` }).click();
		await expect(kid.getByRole('heading', { name: 'My profile' })).toBeVisible();
		await pageReady(kid);
		await expect(kid.getByLabel('Your name in games')).toHaveValue(`Ada${tag}`);
		await expect(kid.getByRole('link', { name: 'All games' })).toBeVisible();

		await test.step('a name another child has is refused, ignoring case', async () => {
			await kid.getByLabel('Your name in games').fill(`bea${tag}`.toUpperCase());
			await kid.getByRole('button', { name: 'Save' }).click();
			await expect(kid.getByRole('alert')).toHaveText('Someone already has that name. Try another.');
			await expect(kid.getByRole('banner')).toContainText(`Playing as Ada${tag}`);
		});

		await test.step('an unkind name is refused with a kind message', async () => {
			await kid.getByLabel('Your name in games').fill('Loser');
			await kid.getByRole('button', { name: 'Save' }).click();
			await expect(kid.getByRole('alert')).toHaveText('Please choose a kinder name. Try another.');
			await expect(kid.getByRole('banner')).toContainText(`Playing as Ada${tag}`);
		});

		await test.step('a free, kind name is saved and shows in the portal bar with no reload', async () => {
			await kid.getByLabel('Your name in games').fill(`Cleo${tag}`);
			await kid.getByRole('button', { name: 'Save' }).click();
			await expect(kid.getByRole('status')).toHaveText(`Saved. Your name in games is Cleo${tag}.`);
			await expect(kid.getByRole('alert')).toHaveText('');
			await expect(kid.getByRole('banner')).toContainText(`Playing as Cleo${tag}`);
			await expect(kid.getByRole('button', { name: 'Save' })).toBeEnabled();
		});

		await test.step('the new name sticks on the next visit, and the old one is free', async () => {
			await kid.reload();
			await pageReady(kid);
			await expect(kid.getByLabel('Your name in games')).toHaveValue(`Cleo${tag}`);
			await kid.getByRole('link', { name: 'All games' }).click();
			await expect(kid.getByRole('banner')).toContainText(`Playing as Cleo${tag}`);
			await friend.goto(`${GAMES}/profile/`);
			await pageReady(friend);
			await friend.getByLabel('Your name in games').fill(`Ada${tag}`);
			await friend.getByRole('button', { name: 'Save' }).click();
			await expect(friend.getByRole('status')).toHaveText(`Saved. Your name in games is Ada${tag}.`);
		});

		expect(problems).toEqual([]);
		await adminContext.close();
		await kid.context().close();
		await friend.context().close();
	});
}
