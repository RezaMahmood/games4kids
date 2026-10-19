/**
 * admin/src: the admin Function app, func-g4k-admin. It serves only /api/admin/*, for the /admin/ pages, and runs
 * no game code: it imports identity.ts and storage naming from @g4k/host, never games/*, and reads the live
 * catalog.json, so a new game appears in the invite form without an admin deploy. admin/src/graph.ts is the only
 * file that calls Graph or the token endpoint.
 *
 * The app holds no standing Entra right. Every Entra call runs as the signed-in admin through OAuth 2.0
 * on-behalf-of (OBO), so it works only while an admin is signed in to /admin/, and no background job or cold start
 * reaches Graph. Two registrations, both created by tools/bootstrap.mjs on the Mac:
 *   games4kids        the SPA client and the API the game apps and the portal app accept (scope access_as_user)
 *   games4kids-admin  the API this app accepts. One scope, admin.manage, which only the /admin/ pages request; the
 *                     games4kids client is pre-authorized for it. Its credential is this app's user-assigned
 *                     identity, id-g4k-obo, as a federated identity credential, so it holds no secret. It holds no
 *                     Graph application permission, so a client-credentials token for it carries no Graph role.
 * Delegated Graph scopes on games4kids-admin, consented at bootstrap for the BOOTSTRAP_ADMINS accounts only
 * (oAuth2PermissionGrant consentType 'Principal'):
 *   User.Invite.All                   POST /invitations
 *   AppRoleAssignment.ReadWrite.All   POST and DELETE /servicePrincipals/{games4kids}/appRoleAssignedTo
 *   Application.Read.All              GET of that list, and the POST's second required scope
 * A delegated call does only what both the scope and the signed-in admin's own Entra role allow. For a Global
 * Administrator the role adds no bound, so the scopes are the bound.
 *
 * The member rows are the intent and Entra follows them. Every operation reads current state and applies only the
 * difference, per make-operations-idempotent, so a retry or the drift fix finishes a run that stopped anywhere,
 * including a run cut short because the admin's session lapsed or Entra asked them to sign in again.
 */

import type { HostReply, HostRequest, PortalRoute } from './host';
import type { Account, Email, EntraObjectId, Grants, Identity, Member, PortalRole, PortalUserId, Profile, TrustedIssuer } from './identity';
import type { Brand } from './manifest';
import type { Catalog } from './registry';
import type { Telemetry } from './telemetry';

/** The admin's bearer token, after verifyAdminToken checked it. Minted only there. It is the OBO request's `assertion`. */
export type AdminAssertion = Brand<string, 'AdminAssertion'>;

export type AdminAuthentication =
	| { readonly ok: true; readonly identity: Identity; readonly assertion: AdminAssertion }
	| { readonly ok: false; readonly code: 'unauthenticated' | 'invalid_token' };

/**
 * verifyToken's checks with the workforce issuer, except aud is games4kids-admin's client id and scp must contain
 * admin.manage. A games4kids token fails the audience check, and OBO accepts only a token whose aud is the caller,
 * so a child's token is never exchanged.
 */
export function verifyAdminToken(issuer: TrustedIssuer, authorization: string | null): Promise<AdminAuthentication> {
	throw new Error('not implemented');
}

/**
 * One request from an active portal admin holding a verified admin.manage token. Minted only by openAdminSession,
 * and the only input that builds an OboGraph, so no code path reaches Graph without a signed-in admin.
 */
export type AdminSession = Brand<{ readonly actor: Member; readonly assertion: AdminAssertion }, 'AdminSession'>;

/** memberFor(identity), active with portalRole admin, or 'forbidden'. */
export function openAdminSession(auth: Extract<AdminAuthentication, { readonly ok: true }>, store: AdminStore): Promise<AdminSession | 'forbidden'> {
	throw new Error('not implemented');
}

/** The id Graph gives one appRoleAssignment, needed to delete it. */
export type AssignmentId = Brand<string, 'AssignmentId'>;

/** One user's assignment to games4kids with the default access role (the app defines no app roles). */
export type Assignment = { readonly objectId: EntraObjectId; readonly assignmentId: AssignmentId };

/** Why Entra refused a call made as the admin. */
export type EntraRefusal =
	/**
	 * The token endpoint answered interaction_required, or a claims challenge such as an MFA demand. The app answers
	 * 401 reauth_required with `claims`, and the shell calls acquireTokenRedirect for admin.manage with them.
	 */
	| { readonly kind: 'reauth_required'; readonly claims: string | null }
	/**
	 * Graph answered 403 because the admin's own Entra role does not allow the call, or the token endpoint refused
	 * the exchange for a missing consent (AADSTS65001), which no re-sign-in fixes. 403 entra_forbidden. Nothing retries.
	 */
	| { readonly kind: 'entra_forbidden'; readonly call: 'invite' | 'list-assignments' | 'assign' | 'unassign' };

/** The wire codes for EntraRefusal. shell.ts's onRefusal handles both. */
export type AdminRefusal = EntraRefusal['kind'];

/** Thrown by OboGraph. createAdminApp's handle maps it to its reply, after the rows already written stay written. */
export class EntraRefused extends Error {
	constructor(readonly refusal: EntraRefusal) {
		super(refusal.kind);
	}
}

/** Graph as the signed-in admin, for one session. Every method throws EntraRefused when Entra refuses. */
export type OboGraph = {
	readonly as: AdminSession;
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

/** id-g4k-obo's token for api://AzureADTokenExchange, from the Functions managed identity endpoint. The OBO client_assertion. */
export type ClientAssertion = () => Promise<string>;

/**
 * The only OBO exchange. POSTs to https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token with
 * grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer, client_id=<games4kids-admin>,
 * client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer, client_assertion from
 * clientAssertion(), assertion=session.assertion, scope=https://graph.microsoft.com/.default and
 * requested_token_use=on_behalf_of. The exchange runs on the first Graph call, so a route that changes only rows
 * never reaches Entra. The Graph token stays in this app, for this request only.
 */
export function graphAs(session: AdminSession, clientAssertion: ClientAssertion, tenantId: string): OboGraph {
	throw new Error('not implemented');
}

/** One row of the /admin/ member list and access grid. */
export type MemberView = { readonly member: Member; readonly account: Account; readonly profile: Profile | null; readonly signedIn: boolean };

/** The admin app's view of the portal tables. It writes members and emails and reads the rest. */
export type AdminStore = {
	/** The caller's member row, through the identity row the portal app wrote at first sign-in. */
	memberFor(identity: Identity): Promise<Member | undefined>;
	/** emails insert if absent with a fresh UUID; on conflict the existing row, so a re-invite keeps the PortalUserId. */
	accountFor(email: Email): Promise<Account>;
	/** Set the emails row's entraObjectId while the etag read with it matches, and retry on conflict. */
	recordObjectId(email: Email, objectId: EntraObjectId): Promise<void>;
	get(userId: PortalUserId): Promise<Member | undefined>;
	/** Replace while the etag read with it matches, and retry on conflict. */
	put(member: Member): Promise<void>;
	/** Insert both rows if absent, so a seed never overwrites a later change. */
	seed(account: Account, member: Member): Promise<void>;
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
 * POST /api/admin/invites. Four steps, each safe to repeat. A crash or an EntraRefused leaves:
 *   1. accountFor(email)         an emails row with no member, which nothing reads; a retry reuses it
 *   2. put the member row        an active member Entra still refuses: drift 'no-account'
 *      (active, role, grants)
 *   3. unless the member has     a guest whose id is not recorded: drift 'no-account'; a retry gets the same id
 *      signed in, inviteGuest
 *      and recordObjectId
 *   4. assign                    a member Entra refuses: drift 'not-assigned'
 * Sending the same form again, after a re-sign-in if Entra asked for one, runs all four and converges.
 */
export function invite(request: InviteRequest, store: AdminStore, graph: OboGraph, redirectUrl: string): Promise<Member> {
	throw new Error('not implemented');
}

/** PUT /api/admin/members/{userId}/access, from the access grid. Changes grants and portal role. Entra is untouched. */
export function setAccess(userId: PortalUserId, access: Omit<InviteRequest, 'email'>, session: AdminSession, store: AdminStore): Promise<void> {
	throw new Error('not implemented');
}

/**
 * POST /api/admin/members/{userId}/revoke, by graph.as.actor. 1. state 'revoked', so every app refuses the next
 * request with no Entra call. 2. unassign, so Entra issues no new token. Stopping between them leaves drift
 * 'assigned-without-member' and a child every app already refuses.
 */
export function revoke(userId: PortalUserId, store: AdminStore, graph: OboGraph): Promise<void> {
	throw new Error('not implemented');
}

/** No revoking yourself, no demoting or revoking the last admin. From both apps' admin rules. */
export function revokeProblem(target: Member, actor: Member, members: readonly Member[]): string | null {
	throw new Error('not implemented');
}

/** One way the app's assignments and the rows disagree. */
export type Drift =
	/** Entra admits the account, but no active member has it. Includes a half-done revoke. Fix: unassign. */
	| { readonly kind: 'assigned-without-member'; readonly assignment: Assignment; readonly userId: PortalUserId | null }
	/** An active member Entra refuses. Fix: assign. */
	| { readonly kind: 'not-assigned'; readonly userId: PortalUserId; readonly objectId: EntraObjectId }
	/** An active member with no recorded account. Fix: invite steps 3 and 4. */
	| { readonly kind: 'no-account'; readonly userId: PortalUserId; readonly email: Email };

/** Pure, table-tested, from assignments() and the rows. */
export function computeDrift(assignments: readonly Assignment[], rows: readonly MemberView[]): readonly Drift[] {
	throw new Error('not implemented');
}

/** GET /api/admin/members. The grid loads from storage even when Entra refuses; the drift panel then shows the refusal. */
export type MembersPage = { readonly rows: readonly MemberView[]; readonly drift: readonly Drift[] | EntraRefusal };

export function membersPage(store: AdminStore, graph: OboGraph): Promise<MembersPage> {
	throw new Error('not implemented');
}

/**
 * POST /api/admin/drift/fix computes drift, applies one fix per entry, and returns a fresh computeDrift. The rows
 * are the intent, so a fix changes only Entra. Each fix counts "already done" as done, so a second click finds nothing.
 */
export function fixDrift(store: AdminStore, graph: OboGraph, redirectUrl: string): Promise<readonly Drift[]> {
	throw new Error('not implemented');
}

/** BOOTSTRAP_ADMINS, email=objectId pairs that tools/bootstrap.mjs sets from your own signed-in account. */
export type BootstrapAdmin = { readonly email: Email; readonly objectId: EntraObjectId };

/**
 * Runs on every cold start and writes rows only: accountFor with the known object id, then seed an active admin
 * member. It takes no Graph client; bootstrap on the Mac assigned these accounts to games4kids, because
 * assignment required would otherwise keep the first admin from signing in. GET /api/admin/health reports it done.
 */
export function seedBootstrapAdmins(admins: readonly BootstrapAdmin[], store: AdminStore): Promise<void> {
	throw new Error('not implemented');
}

export type AdminDeps = {
	/** The workforce issuer, with games4kids-admin's client id as audience. */
	readonly issuer: TrustedIssuer;
	readonly tenantId: string;
	readonly store: AdminStore;
	readonly clientAssertion: ClientAssertion;
	/** The live catalog.json from appOrigin, cached for a minute. */
	readonly catalog: () => Promise<Catalog>;
	/** Every call runs inside telemetry.within({ game: 'portal', route, user }). */
	readonly telemetry: Telemetry;
	/** The SWA origin, the only CORS origin, and the invitation redirect. */
	readonly appOrigin: string;
	readonly version: string;
};

/**
 * Fixed order: match route (404) -> verifyAdminToken (401) -> openAdminSession (403 forbidden) -> parse body (400)
 * -> graphAs(session) -> run -> EntraRefused to 401 reauth_required with claims, or 403 entra_forbidden
 * -> CORS for appOrigin. Routes: GET members, POST invites, PUT members/{userId}/access,
 * POST members/{userId}/revoke, POST drift/fix, GET health (no token, AppHealth).
 */
export function createAdminApp(deps: AdminDeps): { handle(request: HostRequest): Promise<HostReply>; readonly routes: readonly PortalRoute[] } {
	throw new Error('not implemented');
}
