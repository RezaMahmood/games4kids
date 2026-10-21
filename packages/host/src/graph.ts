import { HttpError, parseEntraObjectId, type Email, type EntraObjectId } from '@g4k/sdk';
import type { Elevation } from './admin.ts';
import { EntraRefused, guestUpnPrefix, parseAssignmentId, resolveUser, type AppRoleGrant, type Assignment, type EntraCall, type EntraUser, type OboGraph } from './entra.ts';
import type { Telemetry } from './telemetry.ts';

/** id-g4k-admin's token for api://AzureADTokenExchange from the managed identity endpoint, used as the OBO client_assertion. */
export type ClientAssertion = () => Promise<string>;

export type GraphConfig = {
	readonly tenantId: string;
	/** The games4kids-admin application (client) id. */
	readonly clientId: string;
	/** Object id of the games4kids enterprise application's service principal, where users are assigned. */
	readonly gamesPrincipalId: string;
	/** Object id of games4kids-admin's own service principal, whose app role grants are an alarm. */
	readonly adminPrincipalId: string;
	/** Where a refusal's error code goes, so the next one is diagnosable from App Insights. Never a token or a header. */
	readonly log: Telemetry['log'];
	readonly authorityHost?: string;
	readonly graphOrigin?: string;
	readonly fetch?: typeof fetch;
	readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_ACCESS_ROLE = '00000000-0000-0000-0000-000000000000';

/** A new guest takes a while to replicate, so assign retries a missing principal after these waits. */
export const ASSIGN_RETRY_MS: readonly number[] = [2000, 4000, 8000, 16000];

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {});
const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const odataString = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function jsonOf(response: Response): Promise<Json> {
	return asRecord(await response.json().catch(() => ({})));
}

/**
 * The only OBO exchange, and it needs an Elevation: grant_type jwt-bearer with the elevated token as the assertion
 * and id-g4k-admin's federated token as the client assertion. The Graph token is fetched on first use and kept in
 * this closure only, so it lives for one request.
 */
export function graphAs(elevation: Elevation, clientAssertion: ClientAssertion, config: GraphConfig): OboGraph {
	const http = config.fetch ?? fetch;
	const sleep = config.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const authority = config.authorityHost ?? 'https://login.microsoftonline.com';
	const graphOrigin = config.graphOrigin ?? 'https://graph.microsoft.com';
	const games = `/v1.0/servicePrincipals/${config.gamesPrincipalId}`;
	let token: Promise<string> | undefined;

	async function exchange(call: EntraCall): Promise<string> {
		const body = new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			client_id: config.clientId,
			client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
			client_assertion: await clientAssertion(),
			assertion: elevation.session.token.assertion,
			scope: 'https://graph.microsoft.com/.default',
			requested_token_use: 'on_behalf_of',
		});
		const response = await http(`${authority}/${config.tenantId}/oauth2/v2.0/token`, { method: 'POST', body });
		const reply = await jsonOf(response);
		if (response.ok && typeof reply['access_token'] === 'string') return reply['access_token'];
		if (reply['error'] === 'interaction_required' && typeof reply['claims'] === 'string') {
			throw new EntraRefused({ kind: 'claims_challenge', claims: reply['claims'] });
		}
		if (response.status >= 400 && response.status < 500) {
			const codes = asList(reply['error_codes']).map((code) => `AADSTS${String(code)}`).join(',');
			config.log('warn', `entra token endpoint refused the OBO exchange for ${call}: status ${response.status} error ${String(reply['error'] ?? 'unknown')} codes ${codes || 'none'}`);
			throw new EntraRefused({ kind: 'entra_forbidden', call });
		}
		throw new HttpError(502, 'entra_unavailable', 'Entra did not answer.');
	}

	async function send(call: EntraCall, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ readonly status: number; readonly data: Json }> {
		token ??= exchange(call);
		const response = await http(path.startsWith('https://') || path.startsWith('http://') ? path : `${graphOrigin}${path}`, {
			method,
			headers: { authorization: `Bearer ${await token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const data = await jsonOf(response);
		if (response.status === 401 || response.status === 403) {
			const refusal = asRecord(data['error']);
			config.log('warn', `graph refused ${call}: status ${response.status} code ${String(refusal['code'] ?? 'unknown')} message ${String(refusal['message'] ?? 'none')}`);
			throw new EntraRefused({ kind: 'entra_forbidden', call });
		}
		return { status: response.status, data };
	}

	const unexpected = (call: EntraCall, status: number) => new HttpError(502, 'entra_unavailable', `Entra answered ${status} to ${call}.`);

	async function pages(call: EntraCall, firstPath: string): Promise<readonly Json[]> {
		const rows: Json[] = [];
		for (let next: string | undefined = firstPath; next; ) {
			const { status, data } = await send(call, 'GET', next);
			if (status !== 200) throw unexpected(call, status);
			rows.push(...asList(data['value']).map(asRecord));
			next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : undefined;
		}
		return rows;
	}

	return {
		async findUser(email: Email) {
			const quoted = odataString(email);
			const filter = `mail eq ${quoted} or userPrincipalName eq ${quoted} or startswith(userPrincipalName,${odataString(guestUpnPrefix(email))})`;
			const { status, data } = await send('find-user', 'GET', `/v1.0/users?$filter=${encodeURIComponent(filter)}&$select=id,mail,userPrincipalName&$count=true`, undefined, { consistencylevel: 'eventual' });
			if (status !== 200) throw unexpected('find-user', status);
			const users = asList(data['value']).flatMap((raw): EntraUser[] => {
				const user = asRecord(raw);
				const id = parseEntraObjectId(user['id']);
				const mail = typeof user['mail'] === 'string' ? user['mail'] : null;
				return id ? [{ id, mail, userPrincipalName: String(user['userPrincipalName'] ?? '') }] : [];
			});
			return resolveUser(email, users);
		},
		async inviteGuest(email, redirectUrl) {
			const { status, data } = await send('invite', 'POST', '/v1.0/invitations', { invitedUserEmailAddress: email, inviteRedirectUrl: redirectUrl, sendInvitationMessage: true });
			const objectId = parseEntraObjectId(asRecord(data['invitedUser'])['id']);
			if (status >= 300 || !objectId) throw unexpected('invite', status);
			return objectId;
		},
		async assignments() {
			const rows = await pages('list-assignments', `${games}/appRoleAssignedTo?$select=id,principalId,principalType&$top=100`);
			return rows.flatMap((row): Assignment[] => {
				const objectId = row['principalType'] === 'User' ? parseEntraObjectId(row['principalId']) : null;
				const assignmentId = parseAssignmentId(row['id']);
				return objectId && assignmentId ? [{ objectId, assignmentId }] : [];
			});
		},
		async assign(objectId: EntraObjectId) {
			const body = { principalId: objectId, resourceId: config.gamesPrincipalId, appRoleId: DEFAULT_ACCESS_ROLE };
			for (let attempt = 0; ; attempt++) {
				const { status, data } = await send('assign', 'POST', `${games}/appRoleAssignedTo`, body);
				if (status === 201) return;
				if (status === 400 && /already exists/i.test(String(asRecord(data['error'])['message']))) return;
				const wait = ASSIGN_RETRY_MS[attempt];
				if (status === 404 && wait !== undefined) {
					await sleep(wait);
					continue;
				}
				throw unexpected('assign', status);
			}
		},
		async unassign(assignment) {
			const { status } = await send('unassign', 'DELETE', `${games}/appRoleAssignedTo/${assignment.assignmentId}`);
			if (status !== 204 && status !== 404) throw unexpected('unassign', status);
		},
		async adminAppGrants() {
			const rows = await pages('list-admin-grants', `/v1.0/servicePrincipals/${config.adminPrincipalId}/appRoleAssignments?$top=100`);
			return rows.map((row): AppRoleGrant => ({ resourceDisplayName: String(row['resourceDisplayName'] ?? ''), appRoleId: String(row['appRoleId'] ?? '') }));
		},
	};
}
