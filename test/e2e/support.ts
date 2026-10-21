import { expect, type Browser, type Page } from '@playwright/test';
import { REAL_PORT_BASE } from './ports.ts';

export const GAMES = `http://localhost:${REAL_PORT_BASE}`;
export const ADMIN = `http://localhost:${REAL_PORT_BASE + 1}`;
export const ADMIN_EMAIL = 'admin@example.com';

export async function signInAtFakeEntra(page: Page, email: string): Promise<void> {
	await page.waitForURL('**/oauth2/v2.0/authorize?**');
	await page.getByLabel('Email').fill(email);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A page's first load is done and body[aria-busy] is gone. Until then the page is inert, and fill() types into nothing. */
export async function pageReady(page: Page): Promise<void> {
	await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
}

/** The admin page's first load is done: the shell bar is up and the page takes input. */
export async function adminReady(page: Page): Promise<void> {
	await expect(page.locator('admin-bar .g4k-bar')).toBeVisible();
	await pageReady(page);
}

/** The fake popup asks for credentials again, as prompt=login does. */
export function answerPopups(page: Page): void {
	page.on('popup', async (popup) => {
		await popup.waitForLoadState('domcontentloaded');
		await popup.getByRole('button', { name: 'Sign in' }).click();
	});
}

/** Page errors and policy violations, which a page that still renders would hide. */
export function collectProblems(pages: readonly Page[]): string[] {
	const problems: string[] = [];
	for (const page of pages) {
		page.on('pageerror', (error) => problems.push(`${page.url()}: ${error.message}`));
		page.on('console', (message) => message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text()) && problems.push(message.text()));
	}
	return problems;
}

export async function addAndSync(admin: Page, email: string, game: string): Promise<void> {
	await admin.getByRole('button', { name: 'Add person' }).click();
	const add = admin.getByRole('dialog', { name: 'Add a person' });
	await add.getByLabel('Email').fill(email);
	await add.getByLabel(game).check();
	await add.getByRole('button', { name: 'Save person' }).click();
	await expect(add.getByRole('status')).toHaveText(`Saved ${email}. Sync now so their sign-in works.`);
	await add.getByRole('button', { name: 'Sync now' }).click();
	await expect(add.getByRole('status')).toHaveText(`${email} is synced with Entra and can sign in now.`);
	await add.getByRole('button', { name: 'Done' }).click();
	await expect(add).toBeHidden();
}

/** A child the admin invited to `game`, signed in and named, on their home page. */
export async function namedChild(browser: Browser, admin: Page, email: string, name: string, game: string, options: Parameters<Browser['newContext']>[0]): Promise<Page> {
	await addAndSync(admin, email, game);
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
