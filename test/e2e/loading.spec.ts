import { expect, test, type Page } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, signInAtFakeEntra } from './support.ts';

const MEMBERS = '**/api/admin/portal/members';
const SIZES = [
	{ name: 'on a desktop', options: { viewport: { width: 1280, height: 800 } } },
	{ name: 'on a phone', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
];

async function signedInAdmin(page: Page): Promise<void> {
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
}

/** Holds the members list request until the returned function runs, then answers it with `answer`, or lets it through. */
async function holdMembers(page: Page, answer?: Parameters<Page['route']>[1]): Promise<() => void> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(MEMBERS, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		await held;
		return answer ? answer(route, route.request()) : route.continue();
	});
	return release;
}

async function overlay(page: Page) {
	return page.evaluate(() => {
		const grey = getComputedStyle(document.body, '::before');
		const ring = getComputedStyle(document.body, '::after');
		return {
			shown: grey.content !== 'none',
			coversViewport: grey.position === 'fixed' && grey.width === `${innerWidth}px` && grey.height === `${innerHeight}px`,
			spinning: ring.animationName === 'g4k-spin',
		};
	});
}

async function typeIntoEmailByHand(page: Page, text: string): Promise<void> {
	const box = await page.locator('#add-email').boundingBox();
	expect(box, 'the email field is laid out').not.toBeNull();
	await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
	await page.keyboard.type(text);
}

for (const { name, options } of SIZES) {
	test(`${name}, the page is greyed out and unusable until the first members load finishes`, async ({ browser }) => {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		await signedInAdmin(page);
		const release = await holdMembers(page);

		try {
			await page.reload();
			await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
			expect(await overlay(page), 'a grey layer and a spinning ring cover the page').toEqual({ shown: true, coversViewport: true, spinning: true });
			await typeIntoEmailByHand(page, 'early@example.com');
			await expect(page.locator('#add-email'), 'a tap on the form while loading does nothing').toHaveValue('');
			await expect(page.locator('#add-email')).not.toBeFocused();
		} finally {
			release();
		}

		await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
		expect((await overlay(page)).shown, 'the grey layer is gone').toBe(false);
		await typeIntoEmailByHand(page, 'later@example.com');
		await expect(page.locator('#add-email'), 'the form takes input once the list is in').toHaveValue('later@example.com');
		await context.close();
	});

	test(`${name}, a failed first members load still lifts the overlay and shows the error`, async ({ browser }) => {
		const context = await browser.newContext(options);
		const page = await context.newPage();
		await signedInAdmin(page);
		const release = await holdMembers(page, (route) =>
			route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'storage_down', message: 'The member list is unavailable.' }) }),
		);

		try {
			await page.reload();
			await expect(page.locator('body')).toHaveAttribute('aria-busy', 'true');
		} finally {
			release();
		}

		await expect(page.locator('body')).not.toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('status')).toHaveText('The member list is unavailable.');
		await typeIntoEmailByHand(page, 'still@example.com');
		await expect(page.locator('#add-email'), 'the page is usable after the failure').toHaveValue('still@example.com');
		await context.close();
	});
}
