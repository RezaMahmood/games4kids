import type { Page } from '@playwright/test';
import { REAL_PORT_BASE } from './ports.ts';

export const GAMES = `http://localhost:${REAL_PORT_BASE}`;
export const ADMIN = `http://localhost:${REAL_PORT_BASE + 1}`;
export const ADMIN_EMAIL = 'admin@example.com';

export async function signInAtFakeEntra(page: Page, email: string): Promise<void> {
	await page.waitForURL('**/oauth2/v2.0/authorize?**');
	await page.getByLabel('Email').fill(email);
	await page.getByRole('button', { name: 'Sign in' }).click();
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
