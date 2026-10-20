import {
	ADMIN_MARKER,
	APP_KEYS,
	APP_SPECS,
	GITHUB_ENVIRONMENTS,
	IDENTITIES,
	LOCATION,
	PROVIDERS,
	STEPS,
	DEFAULT_STEPS,
	azCommand,
	changesIn,
	formatFinding,
	formatVerify,
	ghCommand,
	guardActions,
	isReadOnly,
	list,
	lookupApp,
	ownedIds,
	parseApplication,
	parseCredentials,
	parseGrant,
	parseRoleAssignments,
	parseServicePrincipal,
	parseUser,
	planAdminAccount,
	planAfterFirstDeploy,
	BORROWED_VISION,
	borrowedVisionScope,
	planAzureRoles,
	planEntraApps,
	planGithub,
	planIdentities,
	planProviders,
	rec,
	render,
	text,
	type Action,
	type AppKey,
	type Command,
	type Core,
	type EnvironmentRow,
	type Finding,
	type RepoFacts,
	type StepName,
	type SubjectForm,
	type UserRow,
} from './bootstrap.ts';
import { RESOURCE_GROUP, staticWebAppName } from './deploy.ts';
import { functionAppName } from './package-app.ts';

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (command: Command) => Promise<ExecResult>;
export type Io = { readonly exec: Exec; readonly prompt: (question: string) => Promise<string>; readonly log: (line: string) => void; readonly sleep: (milliseconds: number) => Promise<void> };

export type Mode = 'plan' | 'apply' | 'verify';
export type Flags = {
	readonly mode: Mode;
	readonly steps: readonly StepName[];
	readonly createAdminAccount: boolean;
	readonly adminUpn: string | null;
	readonly adoptAdminAccount: boolean;
	readonly seedSelf: boolean;
	readonly alertEmail: string | null;
	readonly repo: string | null;
	readonly subjectForm: SubjectForm;
};

export const USAGE = `usage: node tools/bootstrap.mjs [--plan | --apply | --verify] [options]

  --plan                    print every intended change and make none (default)
  --apply                   make the changes
  --verify                  re-read everything and print a pass or fail table
  --step <name[,name]>      run only these steps: ${STEPS.join(', ')}
  --after-first-deploy      add the step that needs the Static Web Apps and the portal account
  --create-admin-account    create the account you administer from (asks for its UPN)
  --admin-upn <upn>         the UPN, instead of being asked
  --adopt-admin-account     use an existing user with that UPN
  --seed-self               write your own sign-in as the admins row (the B5 fallback)
  --alert-email <address>   where the daily cap alert goes (variable ALERT_EMAIL)
  --repo <owner/name>       the GitHub repository (default: the current checkout)
  --subject-form <auto|name|id>   the federated credential subject form (default: what the repository issues)`;

export function parseFlags(argv: readonly string[]): Flags {
	const modes = argv.filter((arg) => arg === '--plan' || arg === '--apply' || arg === '--verify');
	if (modes.length > 1) throw new Error(`choose one of --plan, --apply and --verify\n${USAGE}`);
	const value = (name: string): string | null => {
		const at = argv.indexOf(name);
		if (at < 0) return null;
		const next = argv[at + 1];
		if (!next || next.startsWith('--')) throw new Error(`${name} needs a value\n${USAGE}`);
		return next;
	};
	const known = new Set(['--plan', '--apply', '--verify', '--step', '--after-first-deploy', '--create-admin-account', '--admin-upn', '--adopt-admin-account', '--seed-self', '--alert-email', '--repo', '--subject-form']);
	const valued = new Set(['--step', '--admin-upn', '--alert-email', '--repo', '--subject-form']);
	argv.forEach((arg, index) => {
		if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}\n${USAGE}`);
		if (!arg.startsWith('--') && !valued.has(argv[index - 1] ?? '')) throw new Error(`unexpected argument ${arg}\n${USAGE}`);
	});
	const chosen = value('--step')?.split(',').map((name) => name.trim()) ?? null;
	const unknownStep = chosen?.find((name) => !(STEPS as readonly string[]).includes(name));
	if (unknownStep) throw new Error(`unknown step ${unknownStep}. Steps: ${STEPS.join(', ')}`);
	const afterFirstDeploy = argv.includes('--after-first-deploy');
	const steps = (chosen as StepName[] | null) ?? [...DEFAULT_STEPS, ...(afterFirstDeploy ? (['after-first-deploy'] as const) : [])];
	const form = value('--subject-form') ?? 'auto';
	if (form !== 'auto' && form !== 'name' && form !== 'id') throw new Error(`--subject-form is auto, name or id\n${USAGE}`);
	const repo = value('--repo');
	if (repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo is owner/name');
	return {
		mode: (modes[0]?.slice(2) as Mode | undefined) ?? 'plan',
		steps: STEPS.filter((step) => steps.includes(step)),
		createAdminAccount: argv.includes('--create-admin-account'),
		adminUpn: value('--admin-upn'),
		adoptAdminAccount: argv.includes('--adopt-admin-account'),
		seedSelf: argv.includes('--seed-self'),
		alertEmail: value('--alert-email'),
		repo,
		subjectForm: form,
	};
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ARM = 'https://management.azure.com';
const APP_FIELDS = 'id,appId,displayName,signInAudience,tags,identifierUris,api,spa,optionalClaims,requiredResourceAccess';
const SP_FIELDS = 'id,appId,appRoleAssignmentRequired,tags';
const MAX_ROUNDS = 4;
const TRANSIENT = /PrincipalNotFound|does not exist|not found|ResourceNotFound|Request_ResourceNotFound|replicat|AuthorizationFailed|Forbidden|\b403\b|Insufficient privileges|RoleAssignmentExists/i;
const RETRY = { quick: { tries: 8, wait: 5_000 }, propagation: { tries: 40, wait: 30_000 } } as const;

const azGet = (url: string, ...headers: string[]): Command => azCommand('rest', '--method', 'GET', '--url', url, ...(headers.length > 0 ? ['--headers', ...headers] : []));

export async function run(flags: Flags, io: Io): Promise<number> {
	const remembered = new Map<string, string>();
	const memo = new Map<string, Promise<unknown>>();
	let applied = 0;

	const read = async (command: Command): Promise<ExecResult> => {
		if (!isReadOnly(command)) throw new Error(`internal error: a read was not read-only: ${render(command)}`);
		return io.exec(command);
	};
	const json = async (command: Command): Promise<unknown> => {
		const result = await read(command);
		if (result.code !== 0) throw new Error(`${render(command)} failed: ${result.stderr.trim()}`);
		return result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
	};
	const attempt = async (command: Command): Promise<{ ok: true; value: unknown } | { ok: false; stderr: string }> => {
		const result = await read(command);
		return result.code === 0 ? { ok: true, value: result.stdout.trim() === '' ? null : JSON.parse(result.stdout) } : { ok: false, stderr: result.stderr };
	};
	const graphList = async (path: string, ...headers: string[]): Promise<readonly unknown[]> => {
		const rows: unknown[] = [];
		for (let next: string | null = `${GRAPH}${path}`; next; ) {
			const page = rec(await json(azGet(next, ...headers)));
			rows.push(...list(page['value']));
			next = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : null;
		}
		return rows;
	};
	const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
		const cached = memo.get(key);
		if (cached) return cached as Promise<T>;
		const loaded = load();
		memo.set(key, loaded);
		return loaded;
	};
	const invalidate = () => memo.clear();

	const byId = async (path: string): Promise<unknown | null> => {
		for (let tries = 0; tries < 4; tries++) {
			const got = await attempt(azGet(`${GRAPH}${path}`));
			if (got.ok) return got.value;
			await io.sleep(2_000);
		}
		return null;
	};

	const core = (): Promise<Core> =>
		once('core', async () => {
			const account = rec(await json(azCommand('account', 'show')));
			const groups = list(await json(azCommand('group', 'list', '--query', `[?name=='${RESOURCE_GROUP}']`)));
			const group = rec(groups[0]);
			const listed = (await graphList(`/applications?$select=${APP_FIELDS}&$top=999`)).map(parseApplication);
			for (const key of APP_KEYS) {
				const id = remembered.get(`application:${APP_SPECS[key].tag}`);
				if (id && !listed.some((app) => app.id === id)) {
					const got = await byId(`/applications/${id}?$select=${APP_FIELDS}`);
					if (got) listed.push(parseApplication(got));
				}
			}
			const apps = { games: lookupApp(listed, APP_SPECS.games), admin: lookupApp(listed, APP_SPECS.admin) };
			const sps: Record<AppKey, ReturnType<typeof parseServicePrincipal> | null> = { games: null, admin: null };
			for (const key of APP_KEYS) {
				const lookup = apps[key];
				if (lookup.kind !== 'found') continue;
				const found = (await graphList(`/servicePrincipals?$filter=appId eq '${lookup.app.appId}'&$select=${SP_FIELDS}`)).map(parseServicePrincipal);
				const id = remembered.get(`servicePrincipal:${APP_SPECS[key].tag}`);
				const later = found.length === 0 && id ? await byId(`/servicePrincipals/${id}?$select=${SP_FIELDS}`) : null;
				sps[key] = found[0] ?? (later ? parseServicePrincipal(later) : null);
			}
			const identities: Record<string, { id: string; clientId: string; principalId: string }> = {};
			if (group['name']) {
				for (const row of list(await json(azCommand('identity', 'list', '--resource-group', RESOURCE_GROUP)))) {
					const item = rec(row);
					if (IDENTITIES.includes(text(item['name']) as (typeof IDENTITIES)[number])) identities[text(item['name'])] = { id: text(item['id']), clientId: text(item['clientId']), principalId: text(item['principalId']) };
				}
			}
			const graphSp = rec((await graphList(`/servicePrincipals?$filter=appId eq '00000003-0000-0000-c000-000000000000'&$select=id,oauth2PermissionScopes`))[0]);
			const scopes = Object.fromEntries(list(graphSp['oauth2PermissionScopes']).map((scope) => [text(rec(scope)['value']), text(rec(scope)['id'])]));
			return {
				subscription: { id: text(account['id']), tenantId: text(account['tenantId']), user: text(rec(account['user'])['name']) },
				rg: { exists: Boolean(group['name']), id: group['id'] ? text(group['id']) : null, location: group['location'] ? text(group['location']) : null },
				apps,
				sps,
				identities,
				graph: { spId: graphSp['id'] ? text(graphSp['id']) : null, scopes },
			};
		});

	const repoName = (): Promise<string> =>
		once('repoName', async () => flags.repo ?? text(rec(await json(ghCommand('repo', 'view', '--json', 'nameWithOwner')))['nameWithOwner']));

	const repoFacts = (): Promise<RepoFacts> =>
		once('repoFacts', async () => {
			const name = await repoName();
			const repo = rec(await json(ghCommand('api', `repos/${name}`)));
			const oidc = rec(await json(ghCommand('api', `repos/${name}/actions/oidc/customization/sub`)));
			return {
				owner: text(rec(repo['owner'])['login']),
				name: text(repo['name']),
				ownerId: Number(rec(repo['owner'])['id']),
				id: Number(repo['id']),
				oidc: { useDefault: oidc['use_default'] !== false, useImmutableSubject: oidc['use_immutable_subject'] === true, prefix: typeof oidc['sub_claim_prefix'] === 'string' ? oidc['sub_claim_prefix'] : null },
			};
		});

	const adminUsers = (upn: string | null): Promise<{ admin: UserRow | null; sameUpn: UserRow | null }> =>
		once(`users:${upn}`, async () => {
			const users = (await graphList('/users?$select=id,userPrincipalName,mail,employeeType&$top=999')).map(parseUser);
			const id = remembered.get(`user:${ADMIN_MARKER}`);
			if (id && !users.some((user) => user.id === id)) {
				const got = await byId(`/users/${id}?$select=id,userPrincipalName,mail,employeeType`);
				if (got) users.push(parseUser(got));
			}
			return { admin: users.find((user) => user.employeeType === ADMIN_MARKER) ?? null, sameUpn: upn ? (users.find((user) => user.userPrincipalName.toLowerCase() === upn.toLowerCase()) ?? null) : null };
		});

	let adminUpn = flags.adminUpn;

	async function plan(step: StepName): Promise<Finding[]> {
		const c = await core();
		switch (step) {
			case 'providers': {
				const rows = list(await json(azCommand('provider', 'list', '--query', '[].{namespace:namespace,state:registrationState}')));
				return planProviders(c, Object.fromEntries(rows.map((row) => [text(rec(row)['namespace']).toLowerCase(), text(rec(row)['state'])])));
			}
			case 'entra-apps':
				return planEntraApps(c);
			case 'identities': {
				const credentials: Record<string, ReturnType<typeof parseCredentials>> = {};
				for (const { identity } of GITHUB_ENVIRONMENTS) {
					if (c.identities[identity]) credentials[identity] = parseCredentials(list(await json(azCommand('identity', 'federated-credential', 'list', '--identity-name', identity, '--resource-group', RESOURCE_GROUP))));
				}
				const adminApp = c.apps.admin;
				const adminAppCredentials = adminApp.kind === 'found' ? parseCredentials(await graphList(`/applications/${adminApp.app.id}/federatedIdentityCredentials`)) : [];
				return planIdentities(c, { credentials, adminAppCredentials }, await repoFacts(), flags.subjectForm);
			}
			case 'azure-roles': {
				const assignments = c.rg.id ? parseRoleAssignments(list(rec(await json(azGet(`${ARM}${c.rg.id}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01`)))['value'])) : [];
				return planAzureRoles(c, assignments);
			}
			case 'admin-account': {
				const domains = (await graphList('/organization?$select=verifiedDomains')).flatMap((org) => list(rec(org)['verifiedDomains'])).map((domain) => text(rec(domain)['name']).toLowerCase());
				const { admin, sameUpn } = await adminUsers(adminUpn);
				const account = admin ?? (flags.adoptAdminAccount ? sameUpn : null);
				const adminSp = c.sps.admin;
				const directoryRoles = account ? (await graphList(`/roleManagement/directory/roleAssignments?$filter=principalId eq '${account.id}'`)).map((row) => ({ roleDefinitionId: text(rec(row)['roleDefinitionId']), directoryScopeId: text(rec(row)['directoryScopeId']) })) : [];
				const assigned = adminSp ? (await graphList(`/servicePrincipals/${adminSp.id}/appRoleAssignedTo?$top=100`)).map((row) => text(rec(row)['principalId'])) : [];
				const grants = adminSp ? (await graphList(`/oauth2PermissionGrants?$filter=clientId eq '${adminSp.id}'`)).map(parseGrant) : [];
				return planAdminAccount(c, { verifiedDomains: domains, admin, sameUpn, directoryRoles, assignedPrincipalIds: assigned, grants }, { create: flags.createAdminAccount, upn: adminUpn, adopt: flags.adoptAdminAccount });
			}
			case 'github': {
				const name = await repoName();
				const repoVariables = Object.fromEntries(list(rec(await json(ghCommand('api', `repos/${name}/actions/variables?per_page=100`)))['variables']).map((row) => [text(rec(row)['name']), text(rec(row)['value'])]));
				const listedEnvironments = list(rec(await json(ghCommand('api', `repos/${name}/environments?per_page=100`)))['environments']).map(rec);
				const environments: Record<string, EnvironmentRow | undefined> = {};
				for (const { name: environment } of GITHUB_ENVIRONMENTS) {
					const found = listedEnvironments.find((row) => row['name'] === environment);
					if (!found) continue;
					const policies = list(rec(await json(ghCommand('api', `repos/${name}/environments/${environment}/deployment-branch-policies`)))['branch_policies']).map((row) => ({ id: Number(rec(row)['id']), name: text(rec(row)['name']) }));
					const variables = Object.fromEntries(list(rec(await json(ghCommand('api', `repos/${name}/environments/${environment}/variables`)))['variables']).map((row) => [text(rec(row)['name']), text(rec(row)['value'])]));
					environments[environment] = { name: environment, customPolicies: rec(found['deployment_branch_policy'])['custom_branch_policies'] === true, policies, variables };
				}
				return planGithub(c, { repoVariables, environments }, { repo: name, alertEmail: flags.alertEmail });
			}
			case 'after-first-deploy': {
				const hosts: Record<AppKey, string | null> = { games: null, admin: null };
				let portal: { name: string; id: string } | null = null;
				if (c.rg.exists) {
					const sites = list(await json(azCommand('staticwebapp', 'list', '--resource-group', RESOURCE_GROUP))).map(rec);
					for (const key of APP_KEYS) hosts[key] = text(sites.find((site) => site['name'] === staticWebAppName(key === 'games' ? 'games' : 'admin'))?.['defaultHostname']) || null;
					const accounts = list(await json(azCommand('storage', 'account', 'list', '--resource-group', RESOURCE_GROUP, '--query', "[?tags.game=='portal'].{name:name,id:id}")));
					const first = rec(accounts[0]);
					portal = first['name'] ? { name: text(first['name']), id: text(first['id']) } : null;
				}
				const meRaw = rec(await json(azGet(`${GRAPH}/me?$select=id,mail,userPrincipalName`)));
				const me = { id: text(meRaw['id']), email: text(meRaw['mail']) || text(meRaw['userPrincipalName']) };
				const { admin } = await adminUsers(adminUpn);
				const source = admin ?? (flags.seedSelf ? me : null);
				let roles: ReturnType<typeof parseRoleAssignments> = [];
				let row: { state: 'present' | 'absent' | 'unknown'; email: string | null } = { state: 'unknown', email: null };
				if (portal) {
					const scoped = await attempt(azGet(`${ARM}${portal.id}/tableServices/default/tables/admins/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01`));
					roles = scoped.ok ? parseRoleAssignments(list(rec(scoped.value)['value'])) : [];
					if (source) {
						const got = await attempt(azCommand('storage', 'entity', 'show', '--account-name', portal.name, '--table-name', 'admins', '--partition-key', 'admin', '--row-key', source.id, '--auth-mode', 'login'));
						row = got.ok ? { state: 'present', email: text(rec(got.value)['email']) } : /ResourceNotFound|does not exist|404/i.test(got.stderr) ? { state: 'absent', email: null } : { state: 'unknown', email: null };
					}
				}
				const vision = { playPrincipalId: null as string | null, roles: [] as ReturnType<typeof parseRoleAssignments> };
				if (c.rg.exists) {
					const app = await attempt(azCommand('functionapp', 'identity', 'show', '--resource-group', RESOURCE_GROUP, '--name', functionAppName(BORROWED_VISION.game)));
					vision.playPrincipalId = app.ok ? text(rec(app.value)['principalId']) || null : null;
					const granted = await attempt(azGet(`${ARM}${borrowedVisionScope(c)}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01`));
					vision.roles = granted.ok ? parseRoleAssignments(list(rec(granted.value)['value'])) : [];
				}
				return planAfterFirstDeploy(c, { hosts, portal, me, roles, row, vision }, { adminAccount: admin, seedSelf: flags.seedSelf });
			}
		}
	}

	async function mutate(item: Action): Promise<void> {
		if (flags.mode !== 'apply') throw new Error(`internal error: ${item.summary} would change something outside --apply`);
		const budget = item.retry === 'none' ? { tries: 1, wait: 0 } : RETRY[item.retry];
		for (let attemptNo = 1; ; attemptNo++) {
			const result = await io.exec(item.command);
			if (result.code === 0) {
				if (item.remember) {
					const id = text(rec(result.stdout.trim() === '' ? {} : JSON.parse(result.stdout))['id']);
					if (id) remembered.set(`${item.remember.kind}:${item.remember.key}`, id);
				}
				return;
			}
			if (attemptNo >= budget.tries || !TRANSIENT.test(result.stderr)) throw new Error(`${item.summary} failed: ${result.stderr.trim()}`);
			io.log(`          retrying in ${budget.wait / 1000}s: ${result.stderr.trim().split('\n')[0]}`);
			await io.sleep(budget.wait);
		}
	}

	const header = async () => {
		const c = await core();
		io.log(`bootstrap ${flags.mode}: subscription ${c.subscription.id}, tenant ${c.subscription.tenantId}, signed in as ${c.subscription.user}`);
		io.log(`resource group ${RESOURCE_GROUP} in ${LOCATION}. Providers: ${PROVIDERS.length}. Steps: ${flags.steps.join(', ')}`);
	};

	if (flags.mode === 'apply' && flags.createAdminAccount && flags.steps.includes('admin-account') && !adminUpn) {
		const existing = (await adminUsers(null)).admin;
		if (!existing) adminUpn = (await io.prompt('UPN for the admin account (a name in one of your verified domains, for example g4k-admin@yourdomain): ')).trim();
		invalidate();
	}

	let failed = false;
	let blockedCount = 0;
	const all: Finding[] = [];
	try {
		await header();
		for (const step of flags.steps) {
			io.log(`\n== ${step} ==`);
			for (let round = 1; round <= MAX_ROUNDS; round++) {
				const rows = await plan(step);
				guardActions(changesIn(rows), ownedIds(await core()));
				const runnable = changesIn(rows).filter((fix) => fix.awaits.length === 0);
				const waiting = changesIn(rows).filter((fix) => fix.awaits.length > 0);
				if (flags.mode !== 'apply') {
					if (flags.mode === 'plan') rows.forEach((row) => io.log(formatFinding(row, true).join('\n')));
					all.push(...rows);
					blockedCount += rows.filter((row) => row.status === 'blocked').length;
					break;
				}
				const shown = round === 1 ? rows.filter((row) => row.status !== 'ok') : [];
				if (round === 1) io.log(`  ${rows.filter((row) => row.status === 'ok').length} checks already satisfied`);
				shown.forEach((row) => io.log(formatFinding(row, false).join('\n')));
				if (runnable.length === 0) {
					if (waiting.length > 0) {
						io.log(`  BLOCKED these wait for something that does not exist: ${waiting.map((fix) => `${fix.summary} (after ${fix.awaits.join(' and ')})`).join('; ')}`);
						blockedCount += waiting.length;
					}
					blockedCount += rows.filter((row) => row.status === 'blocked').length;
					all.push(...rows);
					break;
				}
				for (const item of runnable) {
					io.log(`  apply   ${item.summary}`);
					await mutate(item);
					applied += 1;
					io.log('  done');
				}
				invalidate();
				if (round === MAX_ROUNDS) throw new Error(`${step} did not converge in ${MAX_ROUNDS} rounds`);
			}
		}
	} catch (error) {
		failed = true;
		io.log(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (flags.mode === 'verify') {
		const afterwards: Finding[] = [
			{ step: 'admin-account', id: 'B4', status: 'todo', detail: 'a token from the elevation popup carries auth_time, and a silently refreshed admin.console token carries the old value', fix: [] },
			{ step: 'admin-account', id: 'B6', status: 'todo', detail: 'findUser finds one real existing guest under User.ReadBasic.All, including through otherMails, and a sync for that guest sends no invitation', fix: [] },
		];
		const rows = [...all, ...afterwards];
		io.log(`\n${formatVerify(rows)}`);
		const failures = all.filter((row) => row.status === 'change' || row.status === 'blocked').length;
		io.log(`\n${failures === 0 && !failed ? 'All checks pass.' : `${failures} check(s) fail.`} Build checks B4, B5 and B6 need a person to run them.`);
		return failed || failures > 0 ? 1 : 0;
	}
	if (flags.mode === 'plan') {
		const changes = all.filter((row) => row.status === 'change').length;
		io.log(`\n${failed ? 'The plan could not be completed.' : changes === 0 && blockedCount === 0 ? 'No changes.' : `${changes} change(s) planned, ${blockedCount} blocked. Nothing was changed.`}`);
		return failed ? 1 : 0;
	}
	io.log(`\n${failed ? 'Stopped before finishing. Run --apply again: it continues from what exists.' : applied === 0 && blockedCount === 0 ? 'No changes.' : `Applied ${applied} change(s)${blockedCount > 0 ? `, ${blockedCount} blocked` : ''}.`}`);
	return failed ? 1 : blockedCount > 0 ? 2 : 0;
}
