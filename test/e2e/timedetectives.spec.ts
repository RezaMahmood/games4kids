import { expect, test } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, adminReady, answerPopups, collectProblems, GAMES, namedChild, pageReady, signInAtFakeEntra } from './support.ts';

const RUN = Date.now().toString(36);
const TOPIC = `Vikings ${RUN}`;
const HINT = `Look for the holy island ${RUN}.`;

test('an admin drafts a round with the AI, edits it and publishes it, and a child solves it with one wrong try and one hint', async ({ browser }) => {
	test.setTimeout(180_000);
	const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
	const admin = await adminContext.newPage();
	answerPopups(admin);
	admin.on('dialog', (dialog) => dialog.accept());
	await admin.goto(`${ADMIN}/`);
	await signInAtFakeEntra(admin, ADMIN_EMAIL);
	await adminReady(admin);
	const kid = await namedChild(browser, admin, `detective-${RUN}@example.com`, `Sherlock${RUN}`, 'Time Detectives', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const problems = collectProblems([admin, kid]);

	await test.step('the admin adds a topic and the AI drafts a round in it', async () => {
		await admin.goto(`${ADMIN}/g/timedetectives/`);
		await adminReady(admin);
		await admin.getByRole('button', { name: 'New topic' }).click();
		await admin.getByLabel('Title', { exact: true }).fill(TOPIC);
		await admin.getByRole('button', { name: 'Save topic' }).click();
		await expect(admin.locator('#topic-heading')).toHaveText(TOPIC);
		await admin.getByLabel('What should it be about? (optional)').fill('Lindisfarne');
		await admin.getByRole('button', { name: 'Draft with AI' }).click();
		await expect(admin.locator('#rounds .badge.draft')).toBeVisible();
	});

	await test.step('the admin changes a hint and publishes the round', async () => {
		await admin.getByRole('link', { name: 'The raid on Lindisfarne', exact: true }).click();
		await expect(admin.locator('#r-picture')).toHaveAttribute('src', /^blob:/);
		await admin.locator('#q-where-hint').fill(HINT);
		await admin.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(admin.locator('#status')).toHaveText('Saved.');
		await admin.getByRole('button', { name: 'Publish', exact: true }).click();
		await expect(admin.locator('#round-badge')).toHaveText('Published');
	});

	await test.step('the child opens the door, picks the topic and says they know a bit', async () => {
		await kid.goto(`${GAMES}/g/timedetectives/`);
		await pageReady(kid);
		await kid.getByRole('button', { name: 'Open the door to the past' }).click();
		await kid.getByRole('button', { name: new RegExp(TOPIC) }).click();
		await kid.getByRole('button', { name: /I know a bit about the subject/ }).click();
		await expect(kid.locator('#read-text')).toContainText('The year was AD 793');
		await kid.getByRole('button', { name: "I've read it" }).click();
	});

	await test.step('a wrong first try is greyed out, and the hint shows what the admin wrote', async () => {
		const who = kid.locator('.question', { hasText: 'Who is it?' });
		await who.getByRole('button', { name: 'Romans' }).click();
		await expect(who.getByRole('button', { name: 'Romans' })).toBeDisabled();
		await expect(who.locator('.feedback')).toHaveText('Not quite. Have another go!');
		await who.getByRole('button', { name: 'Vikings' }).click();
		await expect(who.locator('.feedback')).toHaveText('You got it! +5');

		const where = kid.locator('.question', { hasText: 'Where is it?' });
		await where.getByRole('button', { name: /Show a hint/ }).click();
		await expect(where.locator('.hint-text')).toHaveText(HINT);
		await where.getByRole('button', { name: 'Lindisfarne' }).click();
		await expect(where.locator('.feedback')).toHaveText('Brilliant! +7');

		await kid.locator('.question', { hasText: 'When was it?' }).getByRole('button', { name: 'AD 793' }).click();
		await kid.getByRole('button', { name: 'See my points' }).click();
	});

	await test.step('the result counts 22 for the answers times 1.2 for knowing a bit', async () => {
		await expect(kid.locator('#result-points')).toHaveText('26');
		await expect(kid.locator('#result-bonus')).toHaveText('22 for your answers, times 1.2 for knowing a bit.');
		await expect(kid.locator('#result-answers li.right')).toHaveCount(3);
		await expect(kid.getByRole('switch', { name: 'Show my scores on the board' })).toHaveAttribute('aria-checked', 'false');
		await kid.getByRole('button', { name: 'Play another' }).click();
		await expect(kid.getByRole('button', { name: new RegExp(TOPIC) })).toBeVisible();
	});

	expect(problems).toEqual([]);
	await kid.context().close();
	await adminContext.close();
});
