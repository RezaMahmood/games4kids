/**
 * apps/admin/api: the admin Function app, func-g4k-admin, behind the admin site on its own origin. It accepts only
 * games4kids-admin tokens, so no games4kids token (a child's, or the owner's own player token) is ever accepted here,
 * and the games origin never holds a token for this audience. It hosts the portal admin routes (members, Entra) and
 * every game's admin module, mounted at /api/admin/g/<id>/.
 *
 * games4kids-admin is the admin site's SPA client and this app's API. Assignment required; only admin accounts are
 * assigned. Two scopes, no pre-authorized client:
 *   admin.console   everyday work: members, grants, revokes, every game's admin screens. Rows only. Never exchanged.
 *   admin.elevate   requested only by a memory-only MSAL instance with prompt=login, for one Entra task. The access
 *                   token carries auth_time (an optional claim on this registration); the backend accepts it for
 *                   ELEVATION_MAX_AGE_SECONDS after that sign-in, and only then runs OBO.
 * Its credential is id-g4k-admin, a user-assigned identity, as a federated identity credential: no secret. It holds
 * no Graph application permission and no directory role. Delegated Graph scopes, consented per user (consentType
 * Principal) for the admin account only: User.Invite.All, User.ReadBasic.All, AppRoleAssignment.ReadWrite.All,
 * Application.Read.All. The admin account's own standing (Guest Inviter, and ownership of the games4kids service
 * principal) bounds what those scopes reach.
 *
 * The rows are the intent and Entra follows them. Everyday routes change rows; the one elevated write, syncEntra,
 * reads Entra and applies only the difference, so it converges wherever a previous run stopped.
 */

import type { Accounts, AdminRoute, App, AppEnv, CreateAdminApi, Roster, TokenSource } from './host';
import type { Email, EntraObjectId, Member, PortalUserId, Profile, TrustedIssuer } from './identity';
import type { Brand, GameId, GameManifest } from './manifest';

export type AdminScope = 'admin.console' | 'admin.elevate';

/** The admin's bearer token after verifyAdminToken checked it. Minted only there. It is the OBO `assertion`. */
export type AdminAssertion = Brand<string, 'AdminAssertion'>;

/** What a verified games4kids-admin token proves. */
export type AdminToken = {
	readonly objectId: EntraObjectId;
	readonly scopes: readonly AdminScope[];
	/** The auth_time claim: when the person last entered credentials. null when absent, which never elevates. */
	readonly authTime: Date | null;
	readonly assertion: AdminAssertion;
};

export type AdminAuthentication =
	| { readonly ok: true; readonly token: AdminToken }
	| { readonly ok: false; readonly code: 'unauthenticated' | 'invalid_token' };

/** verifyGamesToken's checks, with aud games4kids-admin and scp containing admin.console or admin.elevate. */
export function verifyAdminToken(issuer: TrustedIssuer, authorization: string | null): Promise<AdminAuthentication> {
	throw new Error('not implemented');
}

/** One admins row, written only by tools/bootstrap.mjs on the Mac. Adding an admin is a Mac step. */
export type AdminRow = { readonly objectId: EntraObjectId; readonly email: Email };

/** A request from an account that is assigned to games4kids-admin and has an admins row. Minted only by openAdminSession. */
export type AdminSession = Brand<{ readonly admin: AdminRow; readonly token: AdminToken }, 'AdminSession'>;

export function openAdminSession(token: AdminToken, store: AdminStore): Promise<AdminSession | 'forbidden'> {
	throw new Error('not implemented');
}

/** Ten minutes from the sign-in that minted the token. One Entra task fits; the next task signs in again. */
export const ELEVATION_MAX_AGE_SECONDS = 600;

/** Proof that this admin entered credentials moments ago for this task. Minted only by elevate. */
export type Elevation = Brand<{ readonly session: AdminSession; readonly until: Date }, 'Elevation'>;

/**
 * 401 with `WWW-Authenticate: Bearer error="insufficient_user_authentication", max_age="600"`. The admin shell
 * answers it by opening the elevation popup and sending the task again.
 */
export type StepUp = { readonly kind: 'step_up_required'; readonly maxAgeSeconds: number };

/**
 * Pure. An Elevation when the token has scope admin.elevate and authTime is within ELEVATION_MAX_AGE_SECONDS of
 * `now`, else StepUp. The oid needs no second check, because auth_time and oid are claims of the same token.
 */
export function elevate(session: AdminSession, now: Date): Elevation | StepUp {
	throw new Error('not implemented');
}

export type AssignmentId = Brand<string, 'AssignmentId'>;

/** One user's assignment to games4kids with the default access role. */
export type Assignment = { readonly objectId: EntraObjectId; readonly assignmentId: AssignmentId };

/** An app role that some API granted to the games4kids-admin service principal. There should be none. */
export type AppRoleGrant = { readonly resourceDisplayName: string; readonly appRoleId: string };

/** Why Entra refused a call made as the admin. */
export type EntraRefusal =
	/** The token endpoint answered interaction_required with claims. 401 with WWW-Authenticate error="insufficient_claims" and the claims. */
	| { readonly kind: 'claims_challenge'; readonly claims: string }
	/** Graph answered 403 (the admin's role does not reach it), or consent is missing. 403 entra_forbidden. Nothing retries. */
	| { readonly kind: 'entra_forbidden'; readonly call: 'find-user' | 'invite' | 'list-assignments' | 'assign' | 'unassign' | 'list-admin-grants' };

export class EntraRefused extends Error {
	constructor(readonly refusal: EntraRefusal) {
		super(refusal.kind);
	}
}

/** Graph as the elevated admin, for one request. Every method throws EntraRefused when Entra refuses. */
export type OboGraph = {
	/** GET /users?$filter=mail eq '<email>' or otherMails/any(m:m eq '<email>') or userPrincipalName eq '<email>', under User.ReadBasic.All. */
	findUser(email: Email): Promise<EntraObjectId | null>;
	/** POST /invitations with sendInvitationMessage and a redirect to the games site. Only for someone findUser did not find. */
	inviteGuest(email: Email, redirectUrl: string): Promise<EntraObjectId>;
	/** GET /servicePrincipals/{games4kids}/appRoleAssignedTo, users only. */
	assignments(): Promise<readonly Assignment[]>;
	/** POST .../appRoleAssignedTo with the default access role. An existing one counts as done; a new guest is retried after 2, 4, 8 and 16 seconds (guess). */
	assign(objectId: EntraObjectId): Promise<void>;
	/** DELETE .../appRoleAssignedTo/{id}. A missing one counts as done. */
	unassign(assignment: Assignment): Promise<void>;
	/** GET /servicePrincipals/{games4kids-admin}/appRoleAssignments. */
	adminAppGrants(): Promise<readonly AppRoleGrant[]>;
};

/** id-g4k-admin's token for api://AzureADTokenExchange from the managed identity endpoint, used as the OBO client_assertion. */
export type ClientAssertion = () => Promise<string>;

/**
 * The only OBO exchange, and it needs an Elevation. POST /oauth2/v2.0/token with grant_type jwt-bearer,
 * client_id games4kids-admin, client_assertion from clientAssertion(), assertion = the elevated token,
 * scope https://graph.microsoft.com/.default, requested_token_use on_behalf_of. The Graph token lives for this request
 * only: no cache across requests.
 */
export function graphAs(elevation: Elevation, clientAssertion: ClientAssertion, tenantId: string): OboGraph {
	throw new Error('not implemented');
}

/** How the admin app reaches Graph. Production passes `(e) => graphAs(e, clientAssertion, tenantId)`; tests and dev pass a fake. */
export type GraphFor = (elevation: Elevation) => OboGraph;

/** One row of the members screen. `objectId` comes from the identities row, null until the first sync records it. */
export type MemberView = { readonly member: Member; readonly email: Email; readonly objectId: EntraObjectId | null; readonly profile: Profile | null };

/** The admin app's view of the portal tables: writes members, emails and identities; reads profiles and admins. */
export type AdminStore = {
	admin(objectId: EntraObjectId): Promise<AdminRow | undefined>;
	/** setAccess answers 404 for an unknown id instead of writing a member row with no email. */
	member(userId: PortalUserId): Promise<Member | undefined>;
	/** emails insert-if-absent with a fresh UUID; on conflict the existing userId, so a re-invite keeps the child's history. */
	userIdFor(email: Email): Promise<PortalUserId>;
	/** Replace while the etag read with it matches, and retry on conflict. */
	putMember(member: Member): Promise<void>;
	/** identities insert-if-absent, `entra|<objectId>` -> userId. */
	recordIdentity(objectId: EntraObjectId, userId: PortalUserId): Promise<void>;
	rows(): Promise<readonly MemberView[]>;
};

export type MemberRequest = { readonly email: Email; readonly games: readonly GameId[] };

/** Boundary parse: a valid email, every game a known GameId. An unticked game sends nothing and grants nothing. */
export function parseMemberRequest(raw: unknown, games: readonly GameId[]): MemberRequest | { readonly problems: readonly string[] } {
	throw new Error('not implemented');
}

/** POST /api/admin/portal/members (admin.console). userIdFor, then the active member row. No Graph. */
export function saveMember(request: MemberRequest, session: AdminSession, store: AdminStore): Promise<Member> {
	throw new Error('not implemented');
}

/** PUT /api/admin/portal/members/{userId} (admin.console). Grants or revoke. Every games-side app applies it on the next request. */
export function setAccess(userId: PortalUserId, change: Pick<Member, 'state' | 'games'>, session: AdminSession, store: AdminStore): Promise<void> {
	throw new Error('not implemented');
}

/** One way Entra and the rows disagree. */
export type Drift =
	/** Active member with no identity row. Fix: findUser, else inviteGuest; recordIdentity; assign. */
	| { readonly kind: 'needs-account'; readonly userId: PortalUserId; readonly email: Email }
	/** Active member Entra does not admit. Fix: assign. */
	| { readonly kind: 'not-assigned'; readonly userId: PortalUserId; readonly objectId: EntraObjectId }
	/** Revoked member still assigned, such as a revoke not yet synced. Fix: unassign. */
	| { readonly kind: 'assigned-revoked'; readonly userId: PortalUserId; readonly assignment: Assignment }
	/** An assignment with no identity row, such as one bootstrap made. Shown as unmanaged; no fix ever removes it. */
	| { readonly kind: 'unmanaged'; readonly assignment: Assignment }
	/** games4kids-admin's own principal holds an app role. An alarm: shown in red, never changed from here. */
	| { readonly kind: 'admin-app-grant'; readonly grant: AppRoleGrant };

/** Pure, table-tested. */
export function computeDrift(assignments: readonly Assignment[], adminGrants: readonly AppRoleGrant[], rows: readonly MemberView[]): readonly Drift[] {
	throw new Error('not implemented');
}

/** GET /api/admin/portal/entra (elevated). */
export function checkEntra(graph: OboGraph, store: AdminStore): Promise<readonly Drift[]> {
	throw new Error('not implemented');
}

/**
 * POST /api/admin/portal/entra/sync (elevated), for every member or one. Computes drift, applies the fix for each
 * needs-account, not-assigned and assigned-revoked entry, and returns a fresh computeDrift. Invite is saveMember
 * followed by a sync for that member; revoke is setAccess followed by a sync. A second run finds nothing to do.
 */
export function syncEntra(graph: OboGraph, store: AdminStore, only: PortalUserId | null, redirectUrl: string): Promise<readonly Drift[]> {
	throw new Error('not implemented');
}

/** What the admin app lends a game's admin module. */
export type ModuleHost = {
	readonly accounts: Accounts;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tokens: TokenSource;
	readonly now: () => Date;
	readonly roster: (game: GameId) => Roster;
};

/**
 * One game's admin part. A list cannot hold CreateAdminApi<GameManifest>: a game's create takes its own narrower
 * platform, so it is not assignable to the erased one. adminModule closes over the manifest's literal types instead.
 */
export type AdminModule = { readonly id: GameId; mount(host: ModuleHost): readonly AdminRoute[] };

export function adminModule<M extends GameManifest>(manifest: M, create: CreateAdminApi<M>): AdminModule {
	throw new Error('not implemented');
}

export type AdminAppDeps = Omit<AppEnv, 'issuers'> & {
	readonly issuer: TrustedIssuer;
	readonly store: AdminStore;
	readonly graph: GraphFor;
	/** Every game a member can be granted, with or without an admin part. */
	readonly games: readonly GameId[];
	readonly modules: readonly AdminModule[];
	readonly accounts: Accounts;
	readonly tokens: TokenSource;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The games site origin, the invitation redirect. */
	readonly gamesOrigin: string;
};

/**
 * func-g4k-admin. Fixed order: match route (404) -> verifyAdminToken (401) -> openAdminSession (403 forbidden)
 * -> for the two elevated routes, elevate (401 step_up_required) and graphAs -> parse body (400) -> run
 * -> EntraRefused to 401 insufficient_claims or 403 entra_forbidden.
 * Portal routes: GET/POST portal/members, PUT portal/members/{userId}, GET portal/entra, POST portal/entra/sync,
 * GET health. Game routes: g/<id>/<path> per module, each handler given an AdminPlatform over that game's account.
 * Every function is registered as adminFunctionName(owner, name).
 */
export function createAdminApp(deps: AdminAppDeps): App {
	throw new Error('not implemented');
}
