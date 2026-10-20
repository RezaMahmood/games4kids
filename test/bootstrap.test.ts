import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	ADMIN_IDENTITY,
	ADMIN_MARKER,
	APP_SPECS,
	ASSIGNABLE_TO_ANY,
	ASSIGNABLE_TO_DEPLOY,
	AZURE_ROLES,
	DIRECTORY_ROLES,
	GRAPH_DELEGATED,
	PASSWORD_SENTINEL,
	PROVIDERS,
	azCommand,
	conditionKey,
	githubSubject,
	graphCommand,
	guardActions,
	guardCommand,
	guidFrom,
	isReadOnly,
	lookupApp,
	parseApplication,
	parseRoleAssignments,
	planAdminAccount,
	planEntraApps,
	rbacCondition,
	type Core,
	type GraphApp,
	type RepoFacts,
} from '../tools/bootstrap.ts';
import { parseFlags, run } from '../tools/bootstrap-shell.ts';
import { World, fixture } from './support/bootstrap-world.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const APPLY = ['--apply', '--create-admin-account', '--admin-upn', 'g4k-admin@example.test', '--alert-email', 'owner@example.test'];
const drawPad = () => fixture.applications.find((app) => app['displayName'] === 'Draw Pad');
const letterTracing = () => fixture.applications.find((app) => app['displayName'] === 'Letter Tracing');

describe('a command is a read only when it can be shown to be one', () => {
	const reads = [
		azCommand('account', 'show'),
		azCommand('group', 'list', '--query', "[?name=='x']"),
		azCommand('identity', 'federated-credential', 'list', '--identity-name', 'a', '--resource-group', 'rg'),
		azCommand('rest', '--method', 'GET', '--url', 'https://graph.microsoft.com/v1.0/applications'),
		azCommand('rest', '--url', 'https://graph.microsoft.com/v1.0/applications'),
		azCommand('storage', 'entity', 'show', '--account-name', 'a'),
		{ tool: 'gh' as const, args: ['api', 'repos/o/r/environments'] },
		{ tool: 'gh' as const, args: ['repo', 'view', '--json', 'nameWithOwner'] },
	];
	const writes = [
		azCommand('group', 'create', '--name', 'x'),
		azCommand('provider', 'register', '--namespace', 'Microsoft.Web'),
		azCommand('role', 'assignment', 'delete', '--ids', 'x'),
		azCommand('storage', 'entity', 'insert', '--account-name', 'a'),
		azCommand('somethingnew', 'frobnicate'),
		graphCommand('POST', '/applications', {}),
		graphCommand('PATCH', '/applications/x', { a: 1 }),
		graphCommand('DELETE', '/applications/x'),
		azCommand('rest', '--method', 'post', '--url', 'https://graph.microsoft.com/v1.0/applications'),
		{ tool: 'gh' as const, args: ['variable', 'set', 'A', '--body', 'b'] },
		{ tool: 'gh' as const, args: ['api', '--method', 'PUT', 'repos/o/r/environments/infra'] },
		{ tool: 'gh' as const, args: ['api', 'repos/o/r/environments/infra', '-f', 'a=b'] },
		{ tool: 'gh' as const, args: ['api', '-X', 'DELETE', 'repos/o/r/x'] },
	];
	for (const command of reads) test(`read: ${command.args.slice(0, 4).join(' ')}`, () => assert.equal(isReadOnly(command), true));
	for (const command of writes) test(`write: ${command.args.slice(0, 4).join(' ')} ${command.body === undefined ? '' : 'with a body'}`, () => assert.equal(isReadOnly(command), false));
});

test('scope ids are the same on every run and differ by name', () => {
	assert.equal(guidFrom('a/b'), guidFrom('a/b'));
	assert.notEqual(guidFrom('a/b'), guidFrom('a/c'));
	assert.match(guidFrom('a/b'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

describe('apps are found by the tag bootstrap set, never by name alone', () => {
	const app = (over: Partial<GraphApp>): GraphApp => ({ ...parseApplication(drawPad()), ...over });
	const spec = APP_SPECS.games;

	test('an untagged app with the same name is a conflict and is not adopted', () => {
		const result = lookupApp([app({ displayName: 'games4kids', appId: 'foreign', tags: [] })], spec);
		assert.equal(result.kind, 'conflict');
	});
	test('a tagged app is found', () => assert.equal(lookupApp([app({ displayName: 'games4kids', tags: [spec.tag] })], spec).kind, 'found'));
	test('a tagged app with another name is a conflict', () => assert.equal(lookupApp([app({ displayName: 'Draw Pad', tags: [spec.tag] })], spec).kind, 'conflict'));
	test('two tagged apps are a conflict', () => assert.equal(lookupApp([app({ displayName: 'games4kids', tags: [spec.tag] }), app({ id: 'other', displayName: 'games4kids', tags: [spec.tag] })], spec).kind, 'conflict'));
	test('with only other registrations, ours is missing', () => assert.equal(lookupApp(fixture.applications.map(parseApplication), spec).kind, 'missing'));
});

describe('the guard refuses any Entra object bootstrap did not create', () => {
	const pad = parseApplication(drawPad());
	const owned = new Set(['11111111-1111-4111-8111-111111111111']);
	const ours = [...owned][0] ?? '';

	test('a change to Draw Pad is refused, by object id and by app id', () => {
		assert.throws(() => guardCommand(graphCommand('PATCH', `/applications/${pad.id}`, { tags: ['x'] }), owned, 'patch'), /did not create/);
		assert.throws(() => guardCommand(graphCommand('POST', '/servicePrincipals', { appId: pad.appId }), owned, 'sp'), /did not create/);
		assert.throws(() => guardCommand(graphCommand('PATCH', `/servicePrincipals/${pad.id}`, {}), owned, 'sp'), /did not create/);
	});
	test('Letter Tracing is refused too, in a grant, a role scope and a credential', () => {
		const tracing = parseApplication(letterTracing());
		assert.throws(() => guardCommand(graphCommand('POST', '/oauth2PermissionGrants', { clientId: tracing.id }), owned, 'grant'), /did not create/);
		assert.throws(() => guardCommand(graphCommand('POST', '/roleManagement/directory/roleAssignments', { directoryScopeId: `/${tracing.id}` }), owned, 'role'), /did not create/);
		assert.throws(() => guardCommand(graphCommand('POST', `/applications/${tracing.id}/federatedIdentityCredentials`, {}), owned, 'fic'), /did not create/);
	});
	test('an owned object passes, and placeholders for objects that do not exist yet pass', () => {
		guardCommand(graphCommand('PATCH', `/applications/${ours}`, {}), owned, 'ours');
		guardCommand(graphCommand('PATCH', '/applications/<games4kids object id>', {}), owned, 'later');
		guardCommand(graphCommand('POST', '/applications', {}), owned, 'create');
		guardActions([{ id: 'a', summary: 'a', command: graphCommand('PATCH', `/applications/${ours.toUpperCase()}`, {}), awaits: [], retry: 'none' }], owned);
	});
	test('a read is never refused', () => guardCommand(azCommand('rest', '--method', 'GET', '--url', `https://graph.microsoft.com/v1.0/applications/${pad.id}`), owned, 'read'));
});

describe('the role condition and the Bicep agree', () => {
	test('every role id the Bicep assigns is one id-g4k-infra may assign', () => {
		const found = new Set<string>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(join(dir, entry.name));
				else if (entry.name.endsWith('.bicep')) for (const match of readFileSync(join(dir, entry.name), 'utf8').matchAll(/var \w+ = '([0-9a-f-]{36})'/g)) found.add(match[1] ?? '');
			}
		};
		walk(join(repoRoot, 'infra'));
		walk(join(repoRoot, 'games'));
		assert.ok(found.size >= 8);
		const allowed = new Set<string>([...ASSIGNABLE_TO_ANY, ...ASSIGNABLE_TO_DEPLOY]);
		assert.deepEqual([...found].filter((id) => !allowed.has(id)), []);
	});

	test('the condition limits both writes and deletes, names the deploy identity once per direction, and never lists an administrator role', () => {
		const condition = rbacCondition('deploy-principal');
		assert.equal(condition.match(/deploy-principal/g)?.length, 2);
		assert.match(condition, /roleAssignments\/write/);
		assert.match(condition, /roleAssignments\/delete/);
		for (const role of [AZURE_ROLES.rbacAdministrator, '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9']) assert.equal(condition.includes(role), false);
		assert.equal(ASSIGNABLE_TO_ANY.includes(AZURE_ROLES.contributor as never), false);
		assert.ok(ASSIGNABLE_TO_DEPLOY.includes(AZURE_ROLES.contributor));
	});

	test('conditions compare by content, not by spacing or the order of ids', () => {
		assert.equal(conditionKey('(A {b, A}  AND\n C)'), conditionKey('(A {a,B} AND C)'));
		assert.notEqual(conditionKey(rbacCondition('one')), conditionKey(rbacCondition('two')));
	});

	test('every provider the Bicep uses is registered by bootstrap', () => {
		const used = new Set<string>();
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(join(dir, entry.name));
				else if (entry.name.endsWith('.bicep')) for (const match of readFileSync(join(dir, entry.name), 'utf8').matchAll(/'(Microsoft\.[A-Za-z]+)\//g)) used.add(match[1] ?? '');
			}
		};
		walk(join(repoRoot, 'infra'));
		walk(join(repoRoot, 'games'));
		assert.deepEqual([...used].filter((namespace) => !PROVIDERS.includes(namespace)), []);
	});
});

describe('the GitHub subject comes from what the repository issues', () => {
	const repo: RepoFacts = { owner: 'octo-owner', name: 'games4kids', ownerId: 1001, id: 2002, oidc: { useDefault: true, useImmutableSubject: true, prefix: 'repo:octo-owner@1001/games4kids@2002' } };
	test('auto follows the immutable prefix the repository reports', () => assert.deepEqual(githubSubject(repo, 'auto', 'infra'), { subject: 'repo:octo-owner@1001/games4kids@2002:environment:infra' }));
	test('auto falls back to the name form on a repository with the default claim', () => assert.deepEqual(githubSubject({ ...repo, oidc: { useDefault: true, useImmutableSubject: false, prefix: null } }, 'auto', 'deploy'), { subject: 'repo:octo-owner/games4kids:environment:deploy' }));
	test('name and id force their form', () => {
		assert.deepEqual(githubSubject(repo, 'name', 'infra'), { subject: 'repo:octo-owner/games4kids:environment:infra' });
		assert.deepEqual(githubSubject({ ...repo, oidc: { useDefault: true, useImmutableSubject: false, prefix: null } }, 'id', 'infra'), { subject: 'repo:octo-owner@1001/games4kids@2002:environment:infra' });
	});
	test('a customized claim blocks auto', () => assert.ok('blocked' in githubSubject({ ...repo, oidc: { useDefault: false, useImmutableSubject: false, prefix: null } }, 'auto', 'infra')));
});

describe('real shapes captured from a tenant parse', () => {
	test('an application registration', () => {
		const pad = parseApplication(drawPad());
		assert.equal(pad.displayName, 'Draw Pad');
		assert.equal(pad.tokenVersion, 2);
		assert.deepEqual(pad.scopes.map((scope) => scope.value), ['access_as_user']);
		assert.deepEqual(pad.claims.accessToken.map((claim) => claim.name), ['email', 'upn']);
		assert.equal(pad.preAuthorized, 1);
	});
	test('role assignments from ARM', () => {
		const rows = parseRoleAssignments(fixture.roleAssignments.length > 0 ? [{ id: 'x', properties: { scope: '/s', principalId: 'ABC', roleDefinitionId: '/subscriptions/1/providers/Microsoft.Authorization/roleDefinitions/AAA' } }] : []);
		assert.deepEqual(rows[0], { id: 'x', scope: '/s', principalId: 'abc', roleDefinitionId: 'aaa', condition: null });
		assert.equal(parseRoleAssignments(fixture.roleAssignments).length, fixture.roleAssignments.length);
	});
});

describe('the flags', () => {
	test('plan is the default and apply is never implied', () => {
		assert.equal(parseFlags([]).mode, 'plan');
		assert.equal(parseFlags(['--create-admin-account']).mode, 'plan');
		assert.equal(parseFlags(['--verify']).mode, 'verify');
	});
	test('the admin account step and the after-first-deploy step run only when asked', () => {
		assert.equal(parseFlags([]).createAdminAccount, false);
		assert.equal(parseFlags([]).steps.includes('after-first-deploy'), false);
		assert.equal(parseFlags(['--after-first-deploy']).steps.at(-1), 'after-first-deploy');
	});
	test('mistakes are refused', () => {
		assert.throws(() => parseFlags(['--plan', '--apply']), /choose one/);
		assert.throws(() => parseFlags(['--aply']), /unknown option/);
		assert.throws(() => parseFlags(['--step', 'nope']), /unknown step/);
		assert.throws(() => parseFlags(['--alert-email']), /needs a value/);
		assert.throws(() => parseFlags(['--subject-form', 'x']), /auto, name or id/);
		assert.throws(() => parseFlags(['apply']), /unexpected argument/);
	});
});

describe('--plan against a tenant that has none of it', () => {
	test('issues only reads, changes nothing, and prints what it would do', async () => {
		const world = new World();
		const before = world.snapshot();
		const io = world.io();
		const code = await run(parseFlags(['--alert-email', 'owner@example.test']), io);
		assert.equal(code, 0);
		assert.equal(world.snapshot(), before);
		assert.deepEqual(world.mutations(), []);
		assert.ok(world.log.length > 10 && world.log.every((entry) => entry.readOnly));
		const out = io.lines.join('\n');
		assert.match(out, /az group create --name rg-games4kids/);
		assert.match(out, /games4kids-bootstrap:games/);
		assert.match(out, /subject repo:octo-owner@1001\/games4kids@2002:environment:infra/);
		assert.match(out, /Nothing was changed/);
	});

	test('with the admin account flag it still only plans, and the password is never in the output', async () => {
		const world = new World();
		const io = world.io();
		await run(parseFlags(['--create-admin-account', '--admin-upn', 'g4k-admin@example.test']), io);
		assert.deepEqual(world.mutations(), []);
		const out = io.lines.join('\n');
		assert.match(out, /create the admin account g4k-admin@example.test/);
		assert.match(out, new RegExp(PASSWORD_SENTINEL));
	});

	test('a plan from a goal-satisfied tenant has no changes', async () => {
		const world = new World();
		assert.equal(await run(parseFlags(APPLY), world.io()), 0);
		const mutated = world.mutations().length;
		const io = world.io();
		assert.equal(await run(parseFlags(['--create-admin-account', '--admin-upn', 'g4k-admin@example.test', '--alert-email', 'owner@example.test']), io), 0);
		assert.match(io.lines.join('\n'), /\nNo changes\.$/);
		assert.equal(world.mutations().length, mutated);
	});
});

describe('--apply', () => {
	test('builds everything, leaves other registrations untouched, and a second run changes nothing', async () => {
		const world = new World();
		const others = JSON.stringify([drawPad(), letterTracing()]);
		const first = world.io();
		assert.equal(await run(parseFlags(APPLY), first), 0, first.lines.join('\n'));
		assert.match(first.lines.join('\n'), /Applied \d+ change/);
		assert.equal(JSON.stringify([world.applications.find((app) => app['displayName'] === 'Draw Pad'), world.applications.find((app) => app['displayName'] === 'Letter Tracing')]), others);
		assert.equal(world.applications.length, fixture.applications.length + 2);

		const mutationsAfterFirst = world.mutations().length;
		const second = world.io();
		const settled = world.snapshot();
		assert.equal(await run(parseFlags(APPLY), second), 0);
		assert.match(second.lines.join('\n'), /\nNo changes\.$/);
		assert.equal(world.mutations().length, mutationsAfterFirst);
		assert.equal(world.snapshot(), settled);
	});

	test('creates what the design lists: both registrations, three identities, the roles, the account and the GitHub settings', async () => {
		const world = new World();
		assert.equal(await run(parseFlags(APPLY), world.io()), 0);
		const games = world.applications.find((app) => app['displayName'] === 'games4kids');
		const admin = world.applications.find((app) => app['displayName'] === 'games4kids-admin');
		assert.ok(games && admin);
		assert.deepEqual(parseApplication(admin).scopes.map((scope) => scope.value), ['admin.console', 'admin.elevate']);
		assert.deepEqual(parseApplication(admin).claims.accessToken.map((claim) => claim.name), ['auth_time', 'email', 'upn']);
		assert.deepEqual(parseApplication(games).identifierUris, [`api://${parseApplication(games).appId}`]);
		assert.equal(world.servicePrincipals.filter((sp) => [games['appId'], admin['appId']].includes(sp['appId'])).every((sp) => sp['appRoleAssignmentRequired'] === true), true);
		assert.deepEqual(world.identities.map((identity) => identity['name']).sort(), ['id-g4k-admin', 'id-g4k-deploy', 'id-g4k-infra']);
		const adminIdentity = world.identities.find((identity) => identity['name'] === ADMIN_IDENTITY);
		assert.equal(world.appCredentials.get(String(admin['id']))?.[0]?.['subject'], adminIdentity?.['principalId']);
		assert.equal(world.armRoles.length, 2);
		assert.deepEqual(world.armRoles.map((row) => String((row['properties'] as { roleDefinitionId: string }).roleDefinitionId.split('/').at(-1))).sort(), [AZURE_ROLES.contributor, AZURE_ROLES.rbacAdministrator].sort());
		const account = world.users.find((user) => user['employeeType'] === ADMIN_MARKER);
		assert.ok(account);
		assert.deepEqual(world.directoryRoles.map((row) => `${row['roleDefinitionId']}|${row['directoryScopeId']}`), [`${DIRECTORY_ROLES.guestInviter}|/`]);
		assert.deepEqual(world.spOwners.get(String(world.servicePrincipals.find((sp) => sp['appId'] === games['appId'])?.['id'])), [account['id']]);
		assert.deepEqual(world.grants.map((grant) => [grant['consentType'], String(grant['scope']).split(' ').length]).sort(), [['Principal', 2], ['Principal', 4]]);
		assert.equal(String(world.grants.find((grant) => String(grant['scope']).includes('User.Invite.All'))?.['scope']).split(' ').every((scope) => scope in GRAPH_DELEGATED), true);
		assert.equal(world.variables.get('GAMES_CLIENT_ID'), games['appId']);
		assert.equal(world.variables.get('ALERT_EMAIL'), 'owner@example.test');
		assert.equal(world.environments.get('infra')?.variables.get('AZURE_CLIENT_ID'), clientIdOf(world, 'id-g4k-infra'));
		assert.equal(world.environments.get('deploy')?.variables.get('AZURE_CLIENT_ID'), clientIdOf(world, 'id-g4k-deploy'));
		assert.deepEqual([...world.environments.values()].map((env) => env.policies.map((policy) => policy['name'])), [['main'], ['main']]);
		assert.equal(JSON.stringify(world.log.map((entry) => entry.command)).includes(PASSWORD_SENTINEL), true);
	});

	test('without --create-admin-account no account is created', async () => {
		const world = new World();
		assert.equal(await run(parseFlags(['--apply', '--alert-email', 'owner@example.test']), world.io()), 0);
		assert.equal(world.users.length, fixture.users.length);
		assert.deepEqual(world.directoryRoles, []);
	});

	test('a run cut short converges: a registration made without its service principal is completed', async () => {
		const world = new World();
		assert.equal(await run(parseFlags(['--apply', '--step', 'providers,entra-apps']), world.io()), 0);
		world.lag.clear();
		world.servicePrincipals = world.servicePrincipals.filter((sp) => sp['appId'] === '00000003-0000-0000-c000-000000000000');
		const io = world.io();
		const code = await run(parseFlags(['--apply', '--step', 'entra-apps']), io);
		assert.equal(code, 0, io.lines.join('\n'));
		assert.equal(world.servicePrincipals.length, 3);
		assert.equal(world.applications.length, fixture.applications.length + 2);
	});

	test('a lookalike registration is left alone and nothing is created in its place', async () => {
		const world = new World();
		world.applications.push({ id: 'foreign-object', appId: 'foreign-app', displayName: 'games4kids', tags: [], identifierUris: [] });
		const before = JSON.stringify(world.applications);
		const io = world.io();
		const code = await run(parseFlags(['--apply', '--step', 'entra-apps']), io);
		assert.equal(code, 2);
		assert.match(io.lines.join('\n'), /exists and bootstrap did not create it/);
		assert.equal(JSON.stringify(world.applications.filter((app) => app['id'] === 'foreign-object')), JSON.stringify([world.applications.find((app) => app['id'] === 'foreign-object')]));
		assert.equal(world.applications.filter((app) => app['displayName'] === 'games4kids').length, 1);
		assert.notEqual(JSON.stringify(world.applications), before);
	});

	test('the admin account is asked for and refused outside a verified domain', async () => {
		const world = new World();
		const io = world.io({ prompt: 'someone@elsewhere.example' });
		const code = await run(parseFlags(['--apply', '--create-admin-account', '--step', 'providers,entra-apps,admin-account']), io);
		assert.equal(code, 2);
		assert.match(io.lines.join('\n'), /not in a verified domain/);
		assert.equal(world.users.length, fixture.users.length);
	});

	test('an existing user is not taken over without --adopt-admin-account', async () => {
		const world = new World();
		const existing = world.users[0];
		assert.ok(existing);
		existing['userPrincipalName'] = 'g4k-admin@example.test';
		const io = world.io();
		const code = await run(parseFlags(['--apply', '--create-admin-account', '--admin-upn', 'g4k-admin@example.test', '--step', 'providers,entra-apps,admin-account']), io);
		assert.equal(code, 2);
		assert.match(io.lines.join('\n'), /bootstrap did not create it\. Pass --adopt-admin-account/);
		assert.equal(existing['employeeType'], null);
	});

	test('an admin account with an extra directory role fails verification', async () => {
		const world = new World();
		await run(parseFlags(APPLY), world.io());
		const account = world.users.find((user) => user['employeeType'] === ADMIN_MARKER);
		world.directoryRoles.push({ id: 'x', principalId: account?.['id'], roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', directoryScopeId: '/' });
		const io = world.io();
		assert.equal(await run(parseFlags(['--verify']), io), 1);
		assert.match(io.lines.join('\n'), /FAIL \| the account also holds 62e90394/);
	});
});

describe('--apply --after-first-deploy', () => {
	async function deployed() {
		const world = new World();
		assert.equal(await run(parseFlags(APPLY), world.io()), 0);
		world.addSwaAndPortal();
		return world;
	}

	test('writes the redirect URIs and the admins row, then changes nothing', async () => {
		const world = await deployed();
		const io = world.io();
		assert.equal(await run(parseFlags(['--apply', '--step', 'after-first-deploy']), io), 0, io.lines.join('\n'));
		const games = parseApplication(world.applications.find((app) => app['displayName'] === 'games4kids'));
		const admin = parseApplication(world.applications.find((app) => app['displayName'] === 'games4kids-admin'));
		assert.deepEqual(games.redirectUris, ['https://games-one.4.azurestaticapps.net/', 'https://games-one.4.azurestaticapps.net/redirect.html']);
		assert.deepEqual(admin.redirectUris, ['https://admin-two.4.azurestaticapps.net/', 'https://admin-two.4.azurestaticapps.net/redirect.html']);
		const account = world.users.find((user) => user['employeeType'] === ADMIN_MARKER);
		assert.deepEqual(world.entities.get(String(account?.['id'])), { PartitionKey: 'admin', RowKey: account?.['id'], email: 'g4k-admin@example.test' });
		const reads = world.armRoles.map((row) => row['properties'] as { scope: string; principalId: string; roleDefinitionId: string }).find((row) => row.principalId === world.letterjoinPrincipalId);
		assert.equal(reads?.scope, '/subscriptions/sub-0000/resourceGroups/rg-letterjoin/providers/Microsoft.CognitiveServices/accounts/cv-letterjoin-ul5nga', 'letterjoin may call the borrowed Vision account');
		assert.match(reads?.roleDefinitionId ?? '', /a97b65f3-24c7-4388-baec-2e87135dc908$/);
		const second = world.io();
		const settled = world.snapshot();
		assert.equal(await run(parseFlags(['--apply', '--after-first-deploy', ...APPLY.slice(1)]), second), 0);
		assert.match(second.lines.join('\n'), /\nNo changes\.$/);
		assert.equal(world.snapshot(), settled);
	});

	test('before the Static Web Apps exist it says so instead of guessing', async () => {
		const world = new World();
		await run(parseFlags(APPLY), world.io());
		const io = world.io();
		assert.equal(await run(parseFlags(['--apply', '--step', 'after-first-deploy']), io), 2);
		assert.match(io.lines.join('\n'), /swa-g4k-games does not exist yet/);
	});

	test('--seed-self writes your own sign-in when no admin account exists', async () => {
		const world = new World();
		assert.equal(await run(parseFlags(['--apply', '--alert-email', 'owner@example.test']), world.io()), 0);
		world.addSwaAndPortal();
		const io = world.io();
		assert.equal(await run(parseFlags(['--apply', '--step', 'after-first-deploy', '--seed-self']), io), 0, io.lines.join('\n'));
		assert.equal(world.entities.get(world.ownerId)?.['email'], 'owner@example.test');
	});

	test('--seed-self as a guest with no mail writes the home address, replacing a row the admin app cannot read', async () => {
		const world = new World();
		world.owner = { mail: '', userPrincipalName: 'owner_example.test#EXT#@tenant.onmicrosoft.com' };
		assert.equal(await run(parseFlags(['--apply', '--alert-email', 'owner@example.test']), world.io()), 0);
		world.addSwaAndPortal();
		world.entities.set(world.ownerId, { PartitionKey: 'admin', RowKey: world.ownerId, email: world.owner.userPrincipalName });
		const io = world.io();
		assert.equal(await run(parseFlags(['--apply', '--step', 'after-first-deploy', '--seed-self']), io), 0, io.lines.join('\n'));
		assert.equal(world.entities.get(world.ownerId)?.['email'], 'owner@example.test');
	});
});

describe('--verify', () => {
	test('passes after apply and lists the checks a person still runs', async () => {
		const world = new World();
		await run(parseFlags(APPLY), world.io());
		const io = world.io();
		assert.equal(await run(parseFlags(['--verify', '--create-admin-account', '--admin-upn', 'g4k-admin@example.test', '--alert-email', 'owner@example.test']), io), 0);
		const out = io.lines.join('\n');
		assert.doesNotMatch(out, /\| FAIL \|/);
		assert.match(out, /\| PASS \|/);
		assert.match(out, /B4 .*TODO/);
		assert.match(out, /B5 .*TODO/);
		assert.match(out, /B6 .*TODO/);
	});

	test('fails on an empty tenant and makes no change', async () => {
		const world = new World();
		const before = world.snapshot();
		const io = world.io();
		assert.equal(await run(parseFlags(['--verify']), io), 1);
		assert.match(io.lines.join('\n'), /\| FAIL \|/);
		assert.equal(world.snapshot(), before);
		assert.deepEqual(world.mutations(), []);
	});
});

describe('the admin account plan', () => {
	const core: Core = {
		subscription: { id: 's', tenantId: 't', user: 'u' },
		rg: { exists: true, id: '/rg', location: 'westeurope' },
		apps: { games: { kind: 'missing' }, admin: { kind: 'missing' } },
		sps: { games: { id: 'g', appId: 'ga', appRoleAssignmentRequired: true, tags: [] }, admin: { id: 'a', appId: 'aa', appRoleAssignmentRequired: true, tags: [] } },
		identities: {},
		graph: { spId: 'graph', scopes: GRAPH_DELEGATED },
	};
	const extras = { verifiedDomains: ['example.test'], admin: null, sameUpn: null, directoryRoles: [], assignedPrincipalIds: [], gamesOwnerIds: [], grants: [] };
	const existing = { id: 'u', userPrincipalName: 'g4k-admin@example.test', employeeType: ADMIN_MARKER, mail: '' };

	test('without the flag it plans nothing for the account', () => {
		const rows = planAdminAccount(core, extras, { create: false, upn: null, adopt: false });
		assert.deepEqual(rows.map((row) => row.status), ['skipped', 'todo']);
	});

	test('the create action carries a sentinel, never a password, and forces a change', () => {
		const rows = planAdminAccount(core, extras, { create: true, upn: 'g4k-admin@example.test', adopt: false });
		const create = rows.flatMap((row) => row.fix).find((fix) => fix.id === 'create the admin account');
		const profile = (create?.command.body as { passwordProfile: { password: string; forceChangePasswordNextSignIn: boolean } }).passwordProfile;
		assert.equal(profile.password, PASSWORD_SENTINEL);
		assert.equal(profile.forceChangePasswordNextSignIn, true);
		assert.match(create?.summary ?? '', /az ad user update --id g4k-admin@example\.test --password <temporary> --force-change-password-next-sign-in true/);
	});

	test('an account is planned as an owner of the games4kids service principal, not given a scoped role', () => {
		const rows = planAdminAccount(core, { ...extras, admin: existing }, { create: true, upn: null, adopt: false });
		assert.equal(rows.some((row) => row.id.includes('Cloud Application Administrator')), false);
		const owner = rows.find((row) => row.id === 'owner:games4kids');
		assert.equal(owner?.status, 'change');
		assert.deepEqual(owner?.fix[0]?.command.args.slice(0, 5), ['rest', '--method', 'POST', '--url', 'https://graph.microsoft.com/v1.0/servicePrincipals/g/owners/$ref']);
		assert.deepEqual(owner?.fix[0]?.command.body, { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/u' });
	});

	test('an account that already owns games4kids has nothing to change', () => {
		const rows = planAdminAccount(core, { ...extras, admin: existing, gamesOwnerIds: ['someone-else', 'u'] }, { create: true, upn: null, adopt: false });
		assert.equal(rows.find((row) => row.id === 'owner:games4kids')?.status, 'ok');
	});

	test('an account holding any role beyond Guest Inviter at the tenant is blocked', () => {
		const scoped = { roleDefinitionId: '158c047a-c907-4556-b7ef-446551a6b5f7', directoryScopeId: '/g' };
		const rows = planAdminAccount(core, { ...extras, admin: existing, directoryRoles: [{ roleDefinitionId: DIRECTORY_ROLES.guestInviter, directoryScopeId: '/' }, scoped] }, { create: true, upn: null, adopt: false });
		assert.equal(rows.find((row) => row.id === 'role:no others')?.status, 'blocked');
	});
});

describe('making the admin account an owner', () => {
	const LICENCE = 'ERROR: Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Only companies who have purchased AAD Premium may perform this operation."}})';
	const ownerPosts = (world: World) => world.mutations().filter((command) => command.args.some((arg) => arg.endsWith('/owners/$ref')));

	test('a second apply says there is nothing to do', async () => {
		const world = new World();
		assert.equal(await run(parseFlags(APPLY), world.io()), 0);
		assert.equal(ownerPosts(world).length, 1);
		const second = world.io();
		assert.equal(await run(parseFlags(APPLY), second), 0);
		assert.match(second.lines.join('\n'), /\nNo changes\.$/);
		assert.equal(ownerPosts(world).length, 1);
	});

	test('a licence refusal fails on the first try and is not retried', async () => {
		const world = new World();
		world.refusals.push({ match: /POST .*\/owners\/\$ref/, message: LICENCE, times: 100 });
		const io = world.io();
		assert.equal(await run(parseFlags(APPLY), io), 1);
		assert.match(io.lines.join('\n'), /Only companies who have purchased AAD Premium/);
		assert.equal(ownerPosts(world).length, 1);
	});

	test('a 403 that is only replication lag is retried until it succeeds', async () => {
		const world = new World();
		world.refusals.push({ match: /POST .*\/owners\/\$ref/, message: 'ERROR: Forbidden({"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}})', times: 3 });
		const io = world.io();
		assert.equal(await run(parseFlags(APPLY), io), 0, io.lines.join('\n'));
		const account = world.users.find((user) => user['employeeType'] === ADMIN_MARKER);
		assert.ok(world.spOwners.get(String(world.servicePrincipals.find((sp) => sp['appId'] === world.applications.find((app) => app['displayName'] === 'games4kids')?.['appId'])?.['id']))?.includes(String(account?.['id'])));
		assert.equal(ownerPosts(world).length, 4);
	});
});

test('entra-apps plans nothing but a blocked row for a lookalike', () => {
	const lookalike: GraphApp = { ...parseApplication(drawPad()), displayName: 'games4kids', tags: [] };
	const core: Core = {
		subscription: { id: 's', tenantId: 't', user: 'u' },
		rg: { exists: true, id: '/rg', location: 'westeurope' },
		apps: { games: lookupApp([lookalike], APP_SPECS.games), admin: { kind: 'missing' } },
		sps: { games: null, admin: null },
		identities: {},
		graph: { spId: null, scopes: GRAPH_DELEGATED },
	};
	const rows = planEntraApps(core).filter((row) => row.id.startsWith('games4kids:'));
	assert.deepEqual(rows.map((row) => row.status), ['blocked']);
	assert.deepEqual(rows[0]?.fix, []);
});

function clientIdOf(world: World, name: string) {
	return world.identities.find((identity) => identity['name'] === name)?.['clientId'];
}
