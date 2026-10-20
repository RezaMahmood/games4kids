import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startDevStack, type DevStack } from '../dev/stack.ts';
import { healthPath, isAuthorizationError, kuduHost, moduleParameters, retrying, summarizeWhatIf, untagged } from '../tools/deploy.ts';

describe('the health route the pipeline polls is the one each app serves', () => {
	let stack: DevStack;
	before(async () => void (stack = await startDevStack({ fixtures: true })));
	after(() => stack.close());

	for (const app of ['portal', 'admin', 'fixture', 'puzzle']) {
		test(`${app} answers ok without a token`, async () => {
			const response = await fetch(`${stack.apiOrigin}${healthPath(app)}`);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { ok: true });
		});
	}

	test('a path the apps do not serve answers 404, so a wrong health path would fail the deploy', async () => {
		assert.equal((await fetch(`${stack.apiOrigin}${healthPath('nosuchgame')}`)).status, 404);
	});
});

test('the Kudu host of a Flex app is its default host name with scm after the app name', () => {
	assert.equal(kuduHost('func-g4k-portal-x1y2.westeurope-01.azurewebsites.net'), 'func-g4k-portal-x1y2.scm.westeurope-01.azurewebsites.net');
});

test('only an authorization failure counts as role propagation', () => {
	assert.ok(isAuthorizationError('(AuthorizationFailed) The client does not have authorization to perform action'));
	assert.ok(isAuthorizationError('publish answered 403: Forbidden'));
	assert.ok(isAuthorizationError('Kudu answered 401 for the latest deployment'));
	assert.equal(isAuthorizationError('publish answered 500: server error'), false);
	assert.equal(isAuthorizationError('(ResourceNotFound) The Resource was not found'), false);
});

describe('retrying', () => {
	const options = (retryable: (error: Error) => boolean) => ({ budget: 100, every: 30, retryable, sleep: async () => {} });

	test('returns the first success after retryable failures', async () => {
		let calls = 0;
		const value = await retrying(() => (++calls < 3 ? Promise.reject(new Error('403')) : 'ok'), options(() => true));
		assert.equal(value, 'ok');
		assert.equal(calls, 3);
	});

	test('throws a failure it may not retry on the first attempt', async () => {
		let calls = 0;
		await assert.rejects(retrying(() => (++calls, Promise.reject(new Error('500'))), options((error) => error.message === '403')), /500/);
		assert.equal(calls, 1);
	});

	test('gives up with the last failure when the budget is spent', async () => {
		let calls = 0;
		await assert.rejects(retrying(() => Promise.reject(new Error(`403 #${++calls}`)), options(() => true)), /403 #4/);
		assert.equal(calls, 4);
	});
});

test('the what-if summary lists each change and says so when there are none', () => {
	const id = (type: string) => `/subscriptions/s/resourceGroups/rg-games4kids/providers/${type}`;
	const summary = summarizeWhatIf('what-if main', [
		{ changeType: 'Create', resourceId: id('Microsoft.Storage/storageAccounts/g4kportalabcde') },
		{ changeType: 'Ignore', resourceId: id('Microsoft.Web/sites/func-g4k-admin') },
		{ changeType: 'Modify', resourceId: id('Microsoft.Web/sites/func-g4k-portal') },
	]);
	assert.match(summary, /^### what-if main/);
	assert.match(summary, /\| Create \| Microsoft\.Storage\/storageAccounts\/g4kportalabcde \|/);
	assert.match(summary, /\| Modify \| Microsoft\.Web\/sites\/func-g4k-portal \|/);
	assert.doesNotMatch(summary, /func-g4k-admin/);
	assert.match(summarizeWhatIf('what-if game-x', []), /No changes\./);
});

test('cost by tag fails on a resource without app and game, and exempts what Azure and bootstrap make', () => {
	const tags = { app: 'games4kids', game: 'shared' };
	const missing = untagged([
		{ id: 'a', type: 'Microsoft.Storage/storageAccounts', tags },
		{ id: 'b', type: 'Microsoft.Web/sites', tags: { app: 'games4kids' } },
		{ id: 'c', type: 'Microsoft.Web/serverfarms', tags: null },
		{ id: 'd', type: 'Microsoft.Web/sites', tags: { game: 'drawpad' } },
		{ id: 'e', type: 'Microsoft.AlertsManagement/smartDetectorAlertRules' },
		{ id: 'f', type: 'Microsoft.ManagedIdentity/userAssignedIdentities' },
	]);
	assert.deepEqual(missing, ['b', 'c', 'd']);
});

test('a game module receives the names, the principals, the queues and the tags the contract promises', () => {
	assert.deepEqual(
		moduleParameters('drawpad', { storageAccountName: 'g4kdrawpadabcde', playPrincipalId: 'p1', adminPrincipalId: 'a1', queues: ['stencil-jobs'], location: 'westeurope' }),
		{
			tags: { value: { app: 'games4kids', game: 'drawpad' } },
			location: { value: 'westeurope' },
			storageAccountName: { value: 'g4kdrawpadabcde' },
			playPrincipalId: { value: 'p1' },
			adminPrincipalId: { value: 'a1' },
			queues: { value: ['stencil-jobs'] },
		},
	);
});
