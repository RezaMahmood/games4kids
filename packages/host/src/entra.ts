import type { Brand, Email, EntraObjectId, PortalUserId } from '@g4k/sdk';
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

	constructor(refusal: EntraRefusal) {
		super(refusal.kind);
		this.refusal = refusal;
	}
}

/** Graph as the elevated admin, for one request. Every method throws EntraRefused when Entra refuses. */
export type OboGraph = {
	findUser(email: Email): Promise<EntraObjectId | null>;
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
	/** Active member with no identity row. Fix: findUser, else inviteGuest; recordIdentity; assign. */
	| { readonly kind: 'needs-account'; readonly userId: PortalUserId; readonly email: Email }
	/** Active member Entra does not admit. Fix: assign. */
	| { readonly kind: 'not-assigned'; readonly userId: PortalUserId; readonly objectId: EntraObjectId }
	/** Revoked member still assigned. Fix: unassign. */
	| { readonly kind: 'assigned-revoked'; readonly userId: PortalUserId; readonly assignment: Assignment }
	/** An assignment with no identity row, such as one bootstrap made. No fix ever removes it. */
	| { readonly kind: 'unmanaged'; readonly assignment: Assignment }
	/** games4kids-admin's own principal holds an app role. An alarm, never changed from here. */
	| { readonly kind: 'admin-app-grant'; readonly grant: AppRoleGrant };

/** Pure. Only members the rows know can draw a fix; anything else in Entra is reported, never touched. */
export function computeDrift(assignments: readonly Assignment[], adminGrants: readonly AppRoleGrant[], rows: readonly MemberView[]): readonly Drift[] {
	const assigned = new Map(assignments.map((assignment) => [assignment.objectId, assignment]));
	const managed = new Set(rows.flatMap((row) => (row.objectId ? [row.objectId] : [])));
	const drift: Drift[] = [];
	for (const { member, email, objectId } of rows) {
		const assignment = objectId ? assigned.get(objectId) : undefined;
		if (member.state === 'active' && !objectId) drift.push({ kind: 'needs-account', userId: member.userId, email });
		else if (member.state === 'active' && objectId && !assignment) drift.push({ kind: 'not-assigned', userId: member.userId, objectId });
		else if (member.state === 'revoked' && assignment) drift.push({ kind: 'assigned-revoked', userId: member.userId, assignment });
	}
	for (const assignment of assignments) if (!managed.has(assignment.objectId)) drift.push({ kind: 'unmanaged', assignment });
	for (const grant of adminGrants) drift.push({ kind: 'admin-app-grant', grant });
	return drift;
}

/** GET portal/entra (elevated). */
export async function checkEntra(graph: OboGraph, store: AdminStore): Promise<readonly Drift[]> {
	const [assignments, grants, rows] = await Promise.all([graph.assignments(), graph.adminAppGrants(), store.rows()]);
	return computeDrift(assignments, grants, rows);
}

/** Unmanaged assignments and admin-app grants have no fix, ever. */
async function fix(drift: Drift, graph: OboGraph, store: AdminStore, redirectUrl: string): Promise<void> {
	switch (drift.kind) {
		case 'needs-account': {
			const objectId = (await graph.findUser(drift.email)) ?? (await graph.inviteGuest(drift.email, redirectUrl));
			await store.recordIdentity(objectId, drift.userId);
			return graph.assign(objectId);
		}
		case 'not-assigned':
			return graph.assign(drift.objectId);
		case 'assigned-revoked':
			return graph.unassign(drift.assignment);
		case 'unmanaged':
		case 'admin-app-grant':
			return;
	}
}

/**
 * POST portal/entra/sync (elevated), for every member or one. Applies the fix for each drift the rows own and returns
 * a fresh check. Each fix reads Entra first, so a second run finds nothing to do and a run cut short converges.
 */
export async function syncEntra(graph: OboGraph, store: AdminStore, only: PortalUserId | null, redirectUrl: string): Promise<readonly Drift[]> {
	const drift = computeDrift(await graph.assignments(), [], await store.rows());
	for (const entry of drift) {
		if (only === null || ('userId' in entry && entry.userId === only)) await fix(entry, graph, store, redirectUrl);
	}
	return checkEntra(graph, store);
}
