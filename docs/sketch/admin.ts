/**
 * admin/src: the admin Function app, func-g4k-admin. It serves only /api/admin/*, for the /admin/ pages, and runs
 * no game code: it imports identity.ts, storage naming and the generated catalog.json, never host/generated/games.ts
 * or games/*. admin/src/graph.ts is the only file that calls Graph. Its user-assigned identity, id-g4k-graph, holds
 * the portal's only Entra rights, both granted by tools/bootstrap.mjs on the Mac:
 *   User.Invite.All                         create guests
 *   Cloud Application Administrator,        add and remove the games4kids enterprise app's assignments; it cannot
 *   scoped to the games4kids service        reach drawpad's or letterjoin's registrations, as a tenant-wide
 *   principal only                          assignment could. Bootstrap's spike proves it before granting it.
 *
 * The member rows are the intent and Entra follows them. Every operation reads current state and applies only the
 * difference, per make-operations-idempotent, so a retry or the drift fix finishes a run that stopped anywhere.
 */

import type { HostReply, HostRequest, PortalRoute } from './host';
import type { Email, EntraObjectId, Grants, Identity, Member, PortalRole, PortalUserId, Profile, TrustedIssuer } from './identity';
import type { Brand } from './manifest';
import type { Catalog } from './registry';
import type { Telemetry } from './telemetry';

/** The id Graph gives one appRoleAssignment, needed to delete it. */
export type AssignmentId = Brand<string, 'AssignmentId'>;

/** One user's assignment to games4kids with the default access role (the app defines no app roles). */
export type Assignment = { readonly objectId: EntraObjectId; readonly assignmentId: AssignmentId };

/** Graph as id-g4k-graph. The host's identity holds no Entra right. */
export type GraphAsApp = {
	/**
	 * POST /invitations with sendInvitationMessage and a redirect to https://<site>/. A repeat for the same email
	 * returns the same account and sends the email again (guess, as drawpad relies on it).
	 */
	inviteGuest(email: Email, redirectUrl: string): Promise<EntraObjectId>;
	/** GET /servicePrincipals/{games4kids}/appRoleAssignedTo, users only. */
	assignments(): Promise<readonly Assignment[]>;
	/**
	 * POST /servicePrincipals/{games4kids}/appRoleAssignedTo with the default access role. An existing assignment
	 * counts as done. While Entra has not replicated a new guest, this asks again after 2, 4, 8 and 16 seconds,
	 * as drawpad's commit 83bc093 does for group adds (assumed to apply here, guess).
	 */
	assign(objectId: EntraObjectId): Promise<void>;
	/** DELETE /servicePrincipals/{games4kids}/appRoleAssignedTo/{assignmentId}. A missing one counts as done. */
	unassign(assignment: Assignment): Promise<void>;
};

/** One row of the /admin/ member list and access grid. */
export type MemberView = { readonly member: Member; readonly profile: Profile | null; readonly signedIn: boolean };

/** The admin app's view of the portal tables. It writes members and emails and reads the rest. */
export type AdminStore = {
	/** The caller's member row, through the identity row the host wrote at first sign-in. */
	memberFor(identity: Identity): Promise<Member | undefined>;
	/** emails insert if absent with a fresh UUID; on conflict the existing one, so a re-invite keeps the PortalUserId. */
	userIdFor(email: Email): Promise<PortalUserId>;
	get(userId: PortalUserId): Promise<Member | undefined>;
	/** Replace while the etag read with it matches, and retry on conflict. */
	put(member: Member): Promise<void>;
	/** Insert if absent, so a seed never overwrites a later change. */
	seed(member: Member): Promise<void>;
	list(): Promise<readonly MemberView[]>;
};

export type InviteRequest = { readonly email: Email; readonly portalRole: PortalRole; readonly grants: Grants };

/**
 * Boundary parse for the invite form and the access grid: every grants key a catalog game, every value on that
 * game's ladder. The form pre-selects each game's defaultRole in its picker; an unticked game sends no key.
 */
export function parseInviteRequest(raw: unknown, catalog: Catalog): InviteRequest | { readonly problems: readonly string[] } {
	throw new Error('not implemented');
}

/**
 * POST /api/admin/invites. Four steps, each safe to repeat. A crash leaves:
 *   1. userIdFor(email)          an email row with no member, which nothing reads; a retry reuses it
 *   2. put the member row        an active member Entra still refuses: drift 'no-account'
 *      (active, role, grants, any known entraObjectId kept)
 *   3. unless the member has     a guest whose id is not recorded: drift 'no-account'; a retry gets the same id
 *      signed in, inviteGuest
 *      and record entraObjectId
 *   4. assign                    a member Entra refuses: drift 'not-assigned'
 * Sending the same form again runs all four and converges. Until the child signs in, it also re-sends Microsoft's email.
 */
export function invite(request: InviteRequest, store: AdminStore, graph: GraphAsApp, redirectUrl: string): Promise<Member> {
	throw new Error('not implemented');
}

/** PUT /api/admin/members/{userId}/access, from the access grid. Changes grants and portal role. Entra is untouched. */
export function setAccess(userId: PortalUserId, access: Omit<InviteRequest, 'email'>, actor: Member, store: AdminStore): Promise<void> {
	throw new Error('not implemented');
}

/**
 * POST /api/admin/members/{userId}/revoke. 1. state 'revoked', so the host refuses the next request. 2. unassign,
 * so Entra issues no new token. A crash between them leaves drift 'assigned-without-member'.
 */
export function revoke(userId: PortalUserId, actor: Member, store: AdminStore, graph: GraphAsApp): Promise<void> {
	throw new Error('not implemented');
}

/** No revoking yourself, no demoting or revoking the last admin. From both apps' admin rules. */
export function revokeProblem(target: Member, actor: Member, members: readonly Member[]): string | null {
	throw new Error('not implemented');
}

/** One way the app's assignments and the member rows disagree. */
export type Drift =
	/** Entra admits the account, but no active member has it. Includes a half-done revoke. Fix: unassign. */
	| { readonly kind: 'assigned-without-member'; readonly assignment: Assignment; readonly userId: PortalUserId | null }
	/** An active member Entra refuses. Fix: assign. */
	| { readonly kind: 'not-assigned'; readonly userId: PortalUserId; readonly objectId: EntraObjectId }
	/** An active member with no recorded account. Fix: invite steps 3 and 4. */
	| { readonly kind: 'no-account'; readonly userId: PortalUserId; readonly email: Email };

/** Pure, table-tested. Run live on every GET /api/admin/members, from assignments() and the member rows. */
export function computeDrift(assignments: readonly Assignment[], members: readonly Member[]): readonly Drift[] {
	throw new Error('not implemented');
}

/**
 * POST /api/admin/drift/fix computes drift, applies one fix per entry, and returns a fresh computeDrift. The rows
 * are the intent, so a fix changes only Entra. Each fix counts "already done" as done, so a second click finds nothing.
 */
export function fixDrift(store: AdminStore, graph: GraphAsApp, redirectUrl: string): Promise<readonly Drift[]> {
	throw new Error('not implemented');
}

/** BOOTSTRAP_ADMINS, email=objectId pairs that tools/bootstrap.mjs sets from your own signed-in account. */
export type BootstrapAdmin = { readonly email: Email; readonly objectId: EntraObjectId };

/**
 * Runs on every cold start: userIdFor, seed an active admin row, then assign while that row is still active, so
 * a later revoke sticks. GET /api/admin/health reports it done, and the pipeline's verify step waits for that.
 */
export function seedBootstrapAdmins(admins: readonly BootstrapAdmin[], store: AdminStore, graph: GraphAsApp): Promise<void> {
	throw new Error('not implemented');
}

export type AdminDeps = {
	readonly issuers: readonly TrustedIssuer[];
	readonly store: AdminStore;
	readonly graph: GraphAsApp;
	readonly catalog: Catalog;
	/** Every call runs inside telemetry.within({ game: 'portal', route, user }). */
	readonly telemetry: Telemetry;
	/** The SWA origin, the only CORS origin, and the invitation redirect. */
	readonly appOrigin: string;
	readonly version: string;
};

/**
 * Fixed order: match route (404) -> verifyToken (401) -> memberFor, active with portalRole admin (403 forbidden)
 * -> parse body (400) -> run -> CORS for appOrigin. Routes: GET members (with drift), POST invites,
 * PUT members/{userId}/access, POST members/{userId}/revoke, POST drift/fix, GET health.
 */
export function createAdminApp(deps: AdminDeps): { handle(request: HostRequest): Promise<HostReply>; readonly routes: readonly PortalRoute[] } {
	throw new Error('not implemented');
}
