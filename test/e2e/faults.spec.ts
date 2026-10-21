import { expect, test } from '@playwright/test';
import { REAL_PORT_BASE } from './ports.ts';
import { ADMIN, ADMIN_EMAIL, adminReady, signInAtFakeEntra } from './support.ts';

const TELEMETRY = `http://localhost:${REAL_PORT_BASE + 3}`;

type Envelope = { data: { baseType: string; baseData: { exceptions?: { typeName: string; message: string }[]; properties?: Record<string, string> } } };

test('a 5xx the admin page shows reaches App Insights as an exception, and a 4xx answer does not', async ({ page }) => {
	const message = `Entra answered 400 to assign: Request_BadRequest ${Date.now().toString(36)}`;
	await page.goto(`${ADMIN}/`);
	await signInAtFakeEntra(page, ADMIN_EMAIL);
	await adminReady(page);
	await page.route('**/api/admin/portal/members', (route) =>
		route.request().method() === 'GET' ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'entra_unavailable', message }) }) : route.fallback(),
	);
	await page.reload();
	await expect(page.getByRole('status')).toHaveText(message);

	const faults = async () =>
		((await (await page.request.get(`${TELEMETRY}/__events`)).json()) as Envelope[])
			.filter((envelope) => envelope.data.baseType === 'ExceptionData')
			.map(({ data: { baseData } }) => ({ ...baseData.exceptions?.[0], ...baseData.properties }));
	await expect
		.poll(faults)
		.toEqual(expect.arrayContaining([expect.objectContaining({ typeName: 'ApiFailure', message, status: '502', code: 'entra_unavailable', site: 'admin', game: 'portal' })]));

	const before = (await faults()).length;
	await page.unroute('**/api/admin/portal/members');
	await page.route('**/api/admin/portal/members', (route) =>
		route.request().method() === 'GET' ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden', message: 'Not yours.' }) }) : route.fallback(),
	);
	await page.reload();
	await expect(page.getByRole('status')).toHaveText('Not yours.');
	expect((await faults()).length, 'a 4xx is the server answering, not a fault').toBe(before);
});
