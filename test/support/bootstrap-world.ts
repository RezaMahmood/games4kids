import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guidFrom, isReadOnly, rec, text, type Command } from '../../tools/bootstrap.ts';
import type { ExecResult, Io } from '../../tools/bootstrap-shell.ts';

export type Row = Record<string, unknown>;
type Fixture = {
	applications: Row[];
	servicePrincipals: Row[];
	providers: Row[];
	identities: Row[];
	roleAssignments: Row[];
	users: Row[];
	organization: Row[];
	grants: Row[];
	appRoleAssignedTo: Row[];
	directoryRoleAssignments: Row[];
	githubOidc: Row;
	githubRepo: Row;
	githubEnvironments: Row;
	githubBranchPolicies: Row;
	staticWebApps: Row[];
	me: Row;
};

export const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/bootstrap-tenant.json', import.meta.url)), 'utf8')) as Fixture;

export const TENANT = 'tenant-0000';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const GRAPH_SP_ID = guidFrom('world/graph-sp');
export const MS_GRAPH_APP = '00000003-0000-0000-c000-000000000000';
export const REPO = 'octo-owner/games4kids';

const scopeIds: Record<string, string> = {
	'User.Invite.All': '63dd7cd9-b489-4adf-a28c-ac38b9a0f962',
	'User.ReadBasic.All': 'b340eb25-3456-403f-be2f-af7a0d370277',
	'AppRoleAssignment.ReadWrite.All': '84bccea3-f856-4a8a-967b-dbe0a3d53a64',
	'Application.Read.All': 'c79f8feb-a9db-4090-85f9-90d820caa0eb',
};

/** A tenant that behaves like the services bootstrap talks to: reads answer from state and every write changes it. */
export class World {
	log: { command: Command; readOnly: boolean }[] = [];
	counter = 0;
	rg: Row | null = null;
	registered = new Set<string>(fixture.providers.map((row: Row) => text(row['namespace']).toLowerCase()));
	applications: Row[] = structuredClone(fixture.applications);
	servicePrincipals: Row[] = [{ id: GRAPH_SP_ID, appId: MS_GRAPH_APP, appRoleAssignmentRequired: false, tags: [], oauth2PermissionScopes: Object.entries(scopeIds).map(([value, id]) => ({ id, value })) }];
	identities: Row[] = [];
	identityCredentials = new Map<string, Row[]>();
	appCredentials = new Map<string, Row[]>();
	users: Row[] = structuredClone(fixture.users);
	directoryRoles: Row[] = [];
	assigned: Row[] = [];
	spOwners = new Map<string, string[]>();
	refusals: { match: RegExp; message: string; times: number }[] = [];
	grants: Row[] = [];
	armRoles: Row[] = [];
	variables = new Map<string, string>();
	environments = new Map<string, { custom: boolean; policies: Row[]; variables: Map<string, string> }>();
	staticWebApps: Row[] = [];
	storageAccounts: Row[] = [];
	/** The old drawpad and letterjoin accounts the migration reads. */
	oldAccountsExist = true;
	entities = new Map<string, Row>();
	oidc: Row = structuredClone(fixture.githubOidc);
	lag = new Map<string, number>();
	ownerId = guidFrom('world/owner');
	owner = { mail: 'owner@example.test', userPrincipalName: 'owner@example.test' };
	domains = ['example.test'];

	private visible(rows: Row[], key: (row: Row) => string): Row[] {
		return rows.filter((row) => {
			const left = this.lag.get(key(row)) ?? 0;
			if (left > 0) this.lag.set(key(row), left - 1);
			return left === 0;
		});
	}

	next = () => guidFrom(`world/${++this.counter}`);
	mutations = () => this.log.filter((entry) => !entry.readOnly).map((entry) => entry.command);
	snapshot = () => JSON.stringify([this.rg, [...this.registered].sort(), this.applications, this.servicePrincipals, this.identities, [...this.identityCredentials], [...this.appCredentials], this.users, this.directoryRoles, this.assigned, [...this.spOwners], this.grants, this.armRoles, [...this.variables], [...this.environments].map(([name, env]) => [name, env.custom, env.policies, [...env.variables]]), [...this.entities]]);

	appByAppId = (appId: string) => this.applications.find((app) => app['appId'] === appId);
	letterjoinPrincipalId: string | null = null;
	addSwaAndPortal() {
		this.staticWebApps = [
			{ name: 'swa-g4k-games', defaultHostname: 'games-one.4.azurestaticapps.net' },
			{ name: 'swa-g4k-admin', defaultHostname: 'admin-two.4.azurestaticapps.net' },
		];
		this.letterjoinPrincipalId = 'aaaaaaaa-0000-4000-8000-00000000c0de';
		this.storageAccounts = ['portal', 'drawpad', 'letterjoin'].map((game) => ({ name: `g4k${game}ab12c`, id: `${text(this.rg?.['id'])}/providers/Microsoft.Storage/storageAccounts/g4k${game}ab12c`, game }));
	}

	io(options: { prompt?: string } = {}): Io & { lines: string[] } {
		const lines: string[] = [];
		return {
			lines,
			exec: async (command) => this.exec(command),
			prompt: async () => options.prompt ?? '',
			log: (line) => void lines.push(line),
			sleep: async () => {},
		};
	}

	private async exec(command: Command): Promise<ExecResult> {
		this.log.push({ command, readOnly: isReadOnly(command) });
		try {
			const out = command.tool === 'az' ? this.az(command) : this.gh(command);
			return { code: 0, stdout: out === undefined ? '' : JSON.stringify(out), stderr: '' };
		} catch (error) {
			return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
		}
	}

	private az({ args, body }: Command): unknown {
		const at = (flag: string) => args[args.indexOf(flag) + 1] ?? '';
		if (args[0] === 'account') return { id: 'sub-0000', tenantId: TENANT, user: { name: 'owner@example.test' } };
		if (args[0] === 'group' && args[1] === 'list') return this.rg ? [this.rg] : [];
		if (args[0] === 'group' && args[1] === 'create') return (this.rg = { name: at('--name'), location: at('--location'), id: `/subscriptions/sub-0000/resourceGroups/${at('--name')}` });
		if (args[0] === 'provider' && args[1] === 'list') return fixture.providers.map((row: Row) => ({ namespace: row['namespace'], state: this.registered.has(text(row['namespace']).toLowerCase()) ? 'Registered' : 'NotRegistered' })).concat([...this.registered].filter((ns) => !fixture.providers.some((row: Row) => text(row['namespace']).toLowerCase() === ns)).map((ns) => ({ namespace: ns, state: 'Registered' })));
		if (args[0] === 'provider' && args[1] === 'register') return void this.registered.add(at('--namespace').toLowerCase());
		if (args[0] === 'identity' && args[1] === 'list') return this.identities;
		if (args[0] === 'identity' && args[1] === 'create') {
			const identity = { name: at('--name'), id: `${text(this.rg?.['id'])}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${at('--name')}`, clientId: this.next(), principalId: this.next() };
			this.identities.push(identity);
			return identity;
		}
		if (args[0] === 'identity' && args[1] === 'federated-credential') {
			const name = at('--identity-name');
			const rows = this.identityCredentials.get(name) ?? [];
			if (args[2] === 'list') return rows;
			const row = { name: at('--name'), issuer: at('--issuer'), subject: at('--subject'), audiences: [at('--audiences')] };
			this.identityCredentials.set(name, [...rows.filter((existing) => existing['name'] !== row.name), row]);
			return row;
		}
		if (args[0] === 'role' && args[1] === 'assignment') {
			if (args[2] === 'delete') return void (this.armRoles = this.armRoles.filter((row) => row['id'] !== at('--ids')));
			const scope = at('--scope');
			if (this.armRoles.some((row) => rec(row['properties'])['principalId'] === at('--assignee-object-id') && rec(row['properties'])['scope'] === scope && text(rec(row['properties'])['roleDefinitionId']).endsWith(at('--role')))) throw new Error('RoleAssignmentExists');
			const condition = args.includes('--condition') ? at('--condition') : null;
			const row = { id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${this.next()}`, properties: { scope, principalId: at('--assignee-object-id'), roleDefinitionId: `/subscriptions/sub-0000/providers/Microsoft.Authorization/roleDefinitions/${at('--role')}`, condition, conditionVersion: condition ? '2.0' : null } };
			this.armRoles.push(row);
			return row;
		}
		if (args[0] === 'staticwebapp') return this.staticWebApps;
		if (args[0] === 'functionapp' && args[1] === 'identity') {
			if (at('--name') !== 'func-g4k-letterjoin' || !this.letterjoinPrincipalId) throw new Error('ResourceNotFound');
			return { principalId: this.letterjoinPrincipalId, type: 'SystemAssigned' };
		}
		if (args[0] === 'storage' && args[1] === 'account' && args[2] === 'show') {
			if (!this.oldAccountsExist || !/\/resourceGroups\/rg-(drawpad|letterjoin)\//.test(at('--ids'))) throw new Error('ResourceNotFound');
			return { id: at('--ids') };
		}
		if (args[0] === 'storage' && args[1] === 'account') return this.storageAccounts;
		if (args[0] === 'storage' && args[1] === 'entity') {
			if (args[2] === 'show') {
				const row = this.entities.get(at('--row-key'));
				if (!row) throw new Error('ResourceNotFound: The specified resource does not exist.');
				return row;
			}
			const entity = Object.fromEntries(args.slice(args.indexOf('--entity') + 1).filter((arg) => !arg.startsWith('--')).slice(0, 3).map((pair) => pair.split('=')));
			if (this.entities.has(entity['RowKey']) && !args.includes('replace')) throw new Error('EntityAlreadyExists');
			this.entities.set(entity['RowKey'], entity);
			return entity;
		}
		if (args[0] === 'rest') return this.rest(at('--method'), at('--url'), body);
		throw new Error(`the test tenant has no answer for az ${args.join(' ')}`);
	}

	private rest(method: string, url: string, body: unknown): unknown {
		const path = url.replace(GRAPH, '');
		const quoted = /eq '([^']+)'/.exec(path)?.[1] ?? '';
		if (url.startsWith('https://management.azure.com')) {
			const prefix = url.split('/providers/Microsoft.Authorization')[0] ?? '';
			return { value: this.armRoles.filter((row) => text(rec(row['properties'])['scope']).startsWith(prefix.replace('https://management.azure.com', ''))) };
		}
		const object = /^\/(applications|servicePrincipals|users)\/([^/?]+)(?:\/([^?]+))?/.exec(path);
		if (method === 'GET') {
			if (path.startsWith('/applications?')) return { value: this.visible(this.applications, (app) => text(app['appId'])) };
			if (path.startsWith('/servicePrincipals?')) return { value: this.visible(this.servicePrincipals.filter((sp) => sp['appId'] === quoted), (sp) => `${text(sp['appId'])}/sp`) };
			if (path.startsWith('/users?')) return { value: this.users };
			if (path.startsWith('/organization')) return { value: [{ verifiedDomains: this.domains.map((name) => ({ name })) }] };
			if (path.startsWith('/me')) return { id: this.ownerId, ...this.owner };
			if (path.startsWith('/roleManagement/directory/roleAssignments')) return { value: this.directoryRoles.filter((row) => row['principalId'] === quoted) };
			if (path.startsWith('/oauth2PermissionGrants')) return { value: this.grants.filter((row) => row['clientId'] === quoted) };
			if (object) {
				const [, kind, id, rest] = object;
				const pool = kind === 'applications' ? this.applications : kind === 'users' ? this.users : this.servicePrincipals;
				if (rest === 'federatedIdentityCredentials') return { value: this.appCredentials.get(id ?? '') ?? [] };
				if (rest === 'appRoleAssignedTo') return { value: this.assigned.filter((row) => row['resourceId'] === id) };
				if (rest === 'owners') return { value: (this.spOwners.get(id ?? '') ?? []).map((owner) => ({ id: owner })) };
				const found = pool.find((row) => row['id'] === id);
				if (!found) throw new Error(`Request_ResourceNotFound ${path}`);
				return found;
			}
			throw new Error(`the test tenant has no answer for GET ${path}`);
		}
		const refusal = this.refusals.find((row) => row.times > 0 && row.match.test(`${method} ${path}`));
		if (refusal) {
			refusal.times--;
			throw new Error(refusal.message);
		}
		const input = rec(body);
		if (path === '/applications' && method === 'POST') {
			const app: Row = { id: this.next(), appId: this.next(), identifierUris: [], ...structuredClone(input) };
			this.applications.push(app);
			this.lag.set(text(app['appId']), 3);
			return app;
		}
		if (path === '/servicePrincipals' && method === 'POST') {
			if (!this.appByAppId(text(input['appId']))) throw new Error('Request_ResourceNotFound: application not found');
			const sp: Row = { id: this.next(), ...structuredClone(input) };
			this.servicePrincipals.push(sp);
			this.lag.set(text(sp['appId']) + '/sp', 3);
			return sp;
		}
		if (path === '/users' && method === 'POST') {
			if (rec(input['passwordProfile'])['forceChangePasswordNextSignIn'] !== true) throw new Error('the account must force a password change');
			const user = { id: this.next(), mail: null, ...input };
			this.users.push(user);
			return user;
		}
		if (path === '/roleManagement/directory/roleAssignments' && method === 'POST') {
			this.directoryRoles.push({ id: this.next(), ...input });
			return input;
		}
		if (path === '/oauth2PermissionGrants' && method === 'POST') {
			const grant = { id: Buffer.from(this.next()).toString('base64url'), ...input };
			this.grants.push(grant);
			return grant;
		}
		const grantMatch = /^\/oauth2PermissionGrants\/([^/]+)$/.exec(path);
		if (grantMatch && method === 'PATCH') return void Object.assign(this.grants.find((row) => row['id'] === grantMatch[1]) ?? {}, input);
		if (object) {
			const [, kind, id, rest] = object;
			if (rest === 'owners/$ref' && method === 'POST') {
				const added = text(input['@odata.id']).split('/').at(-1) ?? '';
				this.spOwners.set(id ?? '', [...(this.spOwners.get(id ?? '') ?? []), added]);
				return undefined;
			}
			if (rest === 'appRoleAssignedTo' && method === 'POST') return void this.assigned.push({ id: this.next(), ...input });
			if (rest === 'federatedIdentityCredentials' && method === 'POST') {
				const row = { id: this.next(), ...input };
				this.appCredentials.set(id ?? '', [...(this.appCredentials.get(id ?? '') ?? []), row]);
				return row;
			}
			const pool = kind === 'applications' ? this.applications : kind === 'users' ? this.users : this.servicePrincipals;
			const target = pool.find((row) => row['id'] === id);
			if (!target) throw new Error(`Request_ResourceNotFound ${path}`);
			if (method === 'PATCH') return void Object.assign(target, structuredClone(input));
		}
		throw new Error(`the test tenant has no answer for ${method} ${path}`);
	}

	private gh({ args, body }: Command): unknown {
		if (args[0] === 'repo') return { nameWithOwner: REPO };
		if (args[0] === 'variable') {
			const name = args[2] ?? '';
			const env = args.includes('--env') ? args[args.indexOf('--env') + 1] : undefined;
			const value = args[args.indexOf('--body') + 1] ?? '';
			if (env) {
				const target = this.environments.get(env);
				if (!target) throw new Error('environment not found');
				target.variables.set(name, value);
			} else this.variables.set(name, value);
			return undefined;
		}
		const path = (args.find((arg) => arg.startsWith('repos/')) ?? '').replace(`repos/${REPO}`, '');
		const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
		if (path === '') return fixture.githubRepo;
		if (path === '/actions/oidc/customization/sub') return this.oidc;
		if (path.startsWith('/actions/variables')) return { variables: [...this.variables].map(([name, value]) => ({ name, value })) };
		if (path.startsWith('/environments?')) return { environments: [...this.environments].map(([name, env]) => ({ name, deployment_branch_policy: { protected_branches: false, custom_branch_policies: env.custom } })) };
		const env = /^\/environments\/([^/]+)(?:\/(.+))?$/.exec(path);
		if (env) {
			const [, name = '', rest] = env;
			if (method === 'PUT') return void this.environments.set(name, { custom: rec(rec(body)['deployment_branch_policy'])['custom_branch_policies'] === true, policies: this.environments.get(name)?.policies ?? [], variables: this.environments.get(name)?.variables ?? new Map() });
			const target = this.environments.get(name);
			if (!target) throw new Error('Not Found (HTTP 404)');
			if (rest === 'deployment-branch-policies' && method === 'POST') return void target.policies.push({ id: this.counter++, name: text(rec(body)['name']), type: 'branch' });
			if (rest === 'deployment-branch-policies') return { branch_policies: target.policies };
			if (rest?.startsWith('deployment-branch-policies/') && method === 'DELETE') return void (target.policies = target.policies.filter((row) => String(row['id']) !== rest.split('/')[1]));
			if (rest === 'variables') return { variables: [...target.variables].map(([key, value]) => ({ name: key, value })) };
		}
		throw new Error(`the test tenant has no answer for gh ${args.join(' ')}`);
	}
}

