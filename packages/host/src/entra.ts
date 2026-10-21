import { parseEmail, type Brand, type Email, type EntraObjectId, type PortalUserId } from '@g4k/sdk';
import type { AdminStore, Elevation, MemberView } from './admin.ts';

export type AssignmentId = Brand<string, 'AssignmentId'>;

/** Graph's appRoleAssignment id, parsed where a Graph reply enters the system. */
export function parseAssignmentId(raw: unknown): AssignmentId | null {
	return typeof raw === 'string' && raw.length > 0 ? (raw as AssignmentId) : null;
}

/** One user's assignment to games4kids with the default access role. */
export type Assignment = { readonly objectId: EntraObjectId; readonly assignmentId: AssignmentId };

/** An app role that some API granted to the games4kids-admin service principal. There should be none. */
export type AppRoleGrant = { readonly resourceDisplayName: string; readonly appRoleId: string };

export type EntraCall = 'find-user' | 'invite' | 'list-assignments' | 'assign' | 'unassign' | 'list-admin-grants';

export type EntraRefusal =
	/** The token endpoint answered interaction_required with claims. */
	| { readonly kind: 'claims_challenge'; readonly claims: string }
	/** Graph answered 403, or consent is missing. Nothing retries. */
	| { readonly kind: 'entra_forbidden'; readonly call: EntraCall };

export class EntraRefused extends Error {
	readonly refusal: EntraRefusal;

	/** `message` is the detail App Insights records, such as Graph's error code. Never a token. */
	constructor(refusal: EntraRefusal, message: string = refusal.kind) {
		super(message);
		this.refusal = refusal;
	}
}

/** What findUser learns about an address. Two matches are never guessed between. */
export type UserLookup =
	| { readonly kind: 'found'; readonly objectId: EntraObjectId }
	| { readonly kind: 'none' }
	| { readonly kind: 'ambiguous'; readonly userPrincipalNames: readonly string[] };

/** A user as Graph's basic profile shows them. */
export type EntraUser = { readonly id: EntraObjectId; readonly mail: string | null; readonly userPrincipalName: string };

/** How Entra names a guest invited by this address, up to the tenant domain: jane_outlook.com#EXT#@ for jane@outlook.com. */
export const guestUpnPrefix = (email: Email): string => `${email.replace('@', '_')}#EXT#@`;

/** The address a guest UPN encodes, with the @ turned into the last _. null for a UPN that is not a guest's. */
export function guestHomeEmail(userPrincipalName: string): Email | null {
	const guest = /^(.+)_([^_]+)#ext#@/i.exec(userPrincipalName);
	return guest ? parseEmail(`${guest[1]}@${guest[2]}`) : null;
}

/**
 * Pure. A user matches when their mail, their UPN, or the address their guest UPN encodes equals the email. No
 * criterion outranks another. otherMails is never consulted, because anyone can hold an alternate email.
 */
export function resolveUser(email: Email, users: readonly EntraUser[]): UserLookup {
	const matches = users.filter((user) => [user.mail, user.userPrincipalName, guestHomeEmail(user.userPrincipalName)].some((address) => address?.toLowerCase() === email));
	const [only, ...rest] = matches;
	if (!only) return { kind: 'none' };
	if (rest.length === 0) return { kind: 'found', objectId: only.id };
	return { kind: 'ambiguous', userPrincipalNames: matches.map((user) => user.userPrincipalName) };
}

/** Graph as the elevated admin, for one request. Every method throws EntraRefused when Entra refuses. */
export type OboGraph = {
	findUser(email: Email): Promise<UserLookup>;
	/** Only for someone findUser did not find. */
	inviteGuest(email: Email, redirectUrl: string): Promise<EntraObjectId>;
	/** games4kids's user assignments only. The admin site's own registration is never listed or changed here. */
	assignments(): Promise<readonly Assignment[]>;
	/** An existing assignment counts as done. */
	assign(objectId: EntraObjectId): Promise<void>;
	/** A missing assignment counts as done. */
	unassign(assignment: Assignment): Promise<void>;
	adminAppGrants(): Promise<readonly AppRoleGrant[]>;
};

/**
 * The only way the admin app reaches Graph, and it needs an Elevation. Production passes OBO through graphAs; tests
 * and the dev stack pass a fake.
 */
export type GraphFor = (elevation: Elevation) => OboGraph;

export type Drift =
	/** Active member with no identity row. `account` is what findUser found. Fix: that account, else inviteGuest; recordIdentity; assign. */
	| { readonly kind: 'needs-account'; readonly userId: PortalUserId; readonly email: Email; readonly account: EntraObjectId | null }
	/** Active member Entra does not admit. Fix: assign. */
	| { readonly kind: 'not-assigned'; readonly userId: PortalUserId; readonly objectId: EntraObjectId }
	/**
	 * Active member whose identity row names another account than the one findUser finds for their email. Fix:
	 * unassign the linked account, forgetIdentity, recordIdentity for the found account, assign it. Forgetting first
	 * means a member never holds two identity rows, and a run cut short after it resumes as needs-account.
	 */
	| { readonly kind: 'wrong-account'; readonly userId: PortalUserId; readonly email: Email; readonly linked: EntraObjectId; readonly account: EntraObjectId; readonly assignment: Assignment | null }
	/** More than one account matches an active member's email. No fix: nothing changes until Entra has one match. */
	| { readonly kind: 'ambiguous-account'; readonly userId: PortalUserId; readonly email: Email; readonly userPrincipalNames: readonly string[] }
	/** The account an active member's email finds is another member's sign-in. No fix: one account signs in as one member. */
	| { readonly kind: 'account-taken'; readonly userId: PortalUserId; readonly email: Email; readonly account: EntraObjectId; readonly owner: PortalUserId }
	/** Revoked member still assigned. Fix: unassign. */
	| { readonly kind: 'assigned-revoked'; readonly userId: PortalUserId; readonly assignment: Assignment }
	/** An assignment with no identity row, such as one bootstrap made. No fix ever removes it. */
	| { readonly kind: 'unmanaged'; readonly assignment: Assignment }
	/** games4kids-admin's own principal holds an app role. An alarm, never changed from here. */
	| { readonly kind: 'admin-app-grant'; readonly grant: AppRoleGrant };

function activeDrift({ member: { userId }, email, objectId }: MemberView, lookup: UserLookup, assigned: ReadonlyMap<EntraObjectId, Assignment>, ownerOf: ReadonlyMap<EntraObjectId, PortalUserId>): Drift | null {
	if (lookup.kind === 'ambiguous') return { kind: 'ambiguous-account', userId, email, userPrincipalNames: lookup.userPrincipalNames };
	const account = lookup.kind === 'found' ? lookup.objectId : null;
	const owner = account ? ownerOf.get(account) : undefined;
	if (account && owner && owner !== userId) return { kind: 'account-taken', userId, email, account, owner };
	if (!objectId) return { kind: 'needs-account', userId, email, account };
	if (account && account !== objectId) return { kind: 'wrong-account', userId, email, linked: objectId, account, assignment: assigned.get(objectId) ?? null };
	return assigned.has(objectId) ? null : { kind: 'not-assigned', userId, objectId };
}

/**
 * Pure. Only members the rows know can draw a fix; anything else in Entra is reported, never touched. `lookups` holds
 * findUser's answer for each active member; a member missing from it counts as found nowhere.
 */
export function computeDrift(assignments: readonly Assignment[], adminGrants: readonly AppRoleGrant[], rows: readonly MemberView[], lookups: ReadonlyMap<PortalUserId, UserLookup>): readonly Drift[] {
	const assigned = new Map(assignments.map((assignment) => [assignment.objectId, assignment]));
	const ownerOf = new Map(rows.flatMap((row) => (row.objectId ? [[row.objectId, row.member.userId] as const] : [])));
	const drift: Drift[] = [];
	for (const row of rows) {
		const assignment = row.objectId ? assigned.get(row.objectId) : undefined;
		const entry =
			row.member.state === 'active'
				? activeDrift(row, lookups.get(row.member.userId) ?? { kind: 'none' }, assigned, ownerOf)
				: assignment
					? ({ kind: 'assigned-revoked', userId: row.member.userId, assignment } as const)
					: null;
		if (entry) drift.push(entry);
	}
	for (const assignment of assignments) if (!ownerOf.has(assignment.objectId)) drift.push({ kind: 'unmanaged', assignment });
	for (const grant of adminGrants) drift.push({ kind: 'admin-app-grant', grant });
	return drift;
}

/** One findUser per active member, the only per-member Graph call a check makes. */
async function lookUp(graph: OboGraph, rows: readonly MemberView[]): Promise<ReadonlyMap<PortalUserId, UserLookup>> {
	const active = rows.filter((row) => row.member.state === 'active');
	return new Map(await Promise.all(active.map(async (row) => [row.member.userId, await graph.findUser(row.email)] as const)));
}

/** GET portal/entra (elevated). */
export async function checkEntra(graph: OboGraph, store: AdminStore): Promise<readonly Drift[]> {
	const [assignments, grants, rows] = await Promise.all([graph.assignments(), graph.adminAppGrants(), store.rows()]);
	return computeDrift(assignments, grants, rows, await lookUp(graph, rows));
}

/** Ambiguous and taken accounts, unmanaged assignments and admin-app grants have no fix, ever. */
async function fix(drift: Drift, graph: OboGraph, store: AdminStore, redirectUrl: string): Promise<void> {
	switch (drift.kind) {
		case 'needs-account': {
			const objectId = drift.account ?? (await graph.inviteGuest(drift.email, redirectUrl));
			await store.recordIdentity(objectId, drift.userId);
			return graph.assign(objectId);
		}
		case 'not-assigned':
			return graph.assign(drift.objectId);
		case 'wrong-account':
			if (drift.assignment) await graph.unassign(drift.assignment);
			await store.forgetIdentity(drift.linked);
			await store.recordIdentity(drift.account, drift.userId);
			return graph.assign(drift.account);
		case 'assigned-revoked':
			return graph.unassign(drift.assignment);
		case 'ambiguous-account':
		case 'account-taken':
		case 'unmanaged':
		case 'admin-app-grant':
			return;
	}
}

/**
 * POST portal/entra/sync (elevated), for every member or one. Applies the fix for each drift the rows own and returns
 * a fresh check. Each fix reads Entra first, so a second run finds nothing to do and a run cut short converges. The
 * fresh check reuses the run's lookups: a fix moves identity rows and assignments, and an invited guest is linked by then.
 */
export async function syncEntra(graph: OboGraph, store: AdminStore, only: PortalUserId | null, redirectUrl: string): Promise<readonly Drift[]> {
	const rows = await store.rows();
	const lookups = await lookUp(graph, rows);
	const drift = computeDrift(await graph.assignments(), [], rows, lookups);
	for (const entry of drift) {
		if (only === null || ('userId' in entry && entry.userId === only)) await fix(entry, graph, store, redirectUrl);
	}
	const [assignments, grants, fresh] = await Promise.all([graph.assignments(), graph.adminAppGrants(), store.rows()]);
	return computeDrift(assignments, grants, fresh, lookups);
}
