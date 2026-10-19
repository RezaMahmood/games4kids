/**
 * host/src/identity.ts. Who may enter the portal, and what they are in each game. The only module that reads
 * a token or the portal tables. Games see a `Caller`; the shell sees a `Me`.
 *
 * Portal tables (prefix `portal`, unreachable from any game's Platform):
 *   portalIdentities  PK 'identity'  RK `${IssuerKey}|${subject}`  -> { userId }
 *   portalMembers     PK 'member'    RK PortalUserId               -> Member
 *   portalNames       PK 'name'      RK lowercased display name    -> { userId }
 *   portalInvites     PK 'invite'    RK Email                      -> Invite
 *   portalDrift       PK 'drift'     RK 'latest'                   -> DriftReport, uploaded by tools/members.mjs
 *
 * Two gates, both required. Entra "assignment required" is on for the games4kids enterprise app, so Entra
 * issues no token to an account you have not assigned. Then an active `portalMembers` row (or a pending
 * invite) admits. tools/invite.mjs writes both lists and tools/members.mjs reconcile reports where they differ.
 * The Function app holds no Graph permission, so the host cannot read or change assignments.
 *
 * Reserved, not created: portalGuardianships (PK guardian PortalUserId, RK child PortalUserId) and
 * portalPolicies (PK 'policy', RK child PortalUserId -> { dailyPlayMinutes }). A future parent account is a
 * guardianship row, not a portal role, and a parent-set limit would reach games as a Caller field.
 */

import type { Brand, GameId, GameManifest, RoleOf } from './manifest';

/** Minted by the portal (a UUID). The only user key a game may store. Survives a change of identity provider. */
export type PortalUserId = Brand<string, 'PortalUserId'>;

/** Lowercased, guest `#EXT#` form unwrapped (drawpad's emailFromClaims). Matches invites; never a key in game data. */
export type Email = Brand<string, 'Email'>;

/** Short config key for an accepted issuer: 'entra' today, 'extid' if Entra External ID is added for Google or Facebook sign-in. */
export type IssuerKey = Brand<string, 'IssuerKey'>;

/**
 * One entry per accepted identity provider. Google or Facebook sign-in later means an Entra External ID tenant
 * federated with them, added as a second entry and a second MSAL authority in config.json. A `link` invite maps
 * the new identity to the child's existing PortalUserId, so the tables, roles and games do not change.
 */
export type TrustedIssuer = {
	readonly key: IssuerKey;
	/** https://login.microsoftonline.com/<tenantId>/v2.0 for the workforce tenant. */
	readonly issuer: string;
	/** The client id of the single "games4kids" registration. */
	readonly audience: string;
	readonly keys: URL | { readonly keys: readonly object[] };
	/** Pinned for the workforce tenant. A CIAM issuer has no tid to pin. */
	readonly tenantId?: string;
	/** true for the workforce tenant: Entra issues a token only to an account assigned to the enterprise app. */
	readonly assignmentRequired: boolean;
};

/**
 * What a verified token proves. `subject` is the oid for Entra. The email is a hint for invite matching only.
 * `assigned` is copied from the issuer's `assignmentRequired`: a token from such an issuer proves an assignment.
 */
export type Identity = { readonly issuer: IssuerKey; readonly subject: string; readonly email: Email | null; readonly assigned: boolean };

export type Authentication =
	| { readonly ok: true; readonly identity: Identity }
	| { readonly ok: false; readonly code: 'unauthenticated' | 'invalid_token' };

/** RS256, iss, aud, tid where pinned, ver 2.0, scp contains access_as_user, exp. From letterjoin's identity.js. */
export function verifyToken(issuers: readonly TrustedIssuer[], authorization: string | null): Promise<Authentication> {
	throw new Error('not implemented');
}

export type PortalRole = 'member' | 'admin';

/** A rung on the game's ladder, or 'none' to hide a game whose defaultRole would otherwise apply. */
export type Grants = Readonly<Partial<Record<GameId, string>>>;

export type Profile = {
	/** Unique across the portal, chosen on /welcome/. */
	readonly displayName: string;
	/** IANA zone, chosen on /welcome/. drawpad's daily limit and letterjoin's practice days read it. */
	readonly timeZone: string;
};

export type Member = {
	readonly userId: PortalUserId;
	readonly email: Email;
	/** A revoked member keeps the row, profile and name, so reconcile can finish a half-done revoke and a re-invite restores them. */
	readonly state: 'active' | 'revoked';
	readonly portalRole: PortalRole;
	/** null until /welcome/ is completed. A member without a profile can reach no game. */
	readonly profile: Profile | null;
	readonly grants: Grants;
};

export type Invite =
	/** A new person. Claimed on their first sign-in with a matching email. */
	| { readonly kind: 'join'; readonly email: Email; readonly portalRole: PortalRole; readonly grants: Grants; readonly invitedAt: string }
	/** An existing member signing in through a second issuer. Maps the new identity to the old PortalUserId. */
	| { readonly kind: 'link'; readonly email: Email; readonly userId: PortalUserId; readonly invitedAt: string };

/** What GET /api/portal/me returns. The shell routes on `state`, so a game page only ever sees 'active'. */
export type Me =
	| { readonly state: 'not-invited'; readonly email: Email | null }
	| { readonly state: 'no-profile'; readonly email: Email }
	| {
			readonly state: 'active';
			readonly userId: PortalUserId;
			readonly profile: Profile;
			readonly portalRole: PortalRole;
			/** Games this member can see, with the role held in each. Derived by effectiveRole, never stored. */
			readonly games: readonly { readonly id: GameId; readonly role: string }[];
	  };

/** Everything decide() needs, read by the store in one pass. */
export type Found = {
	readonly userId: PortalUserId | undefined;
	readonly member: Member | undefined;
	readonly invite: Invite | undefined;
};

export type Admission =
	| { readonly kind: 'member'; readonly member: Member }
	| { readonly kind: 'claim'; readonly claim: Claim }
	/**
	 * `drift` is true when `identity.assigned` holds but no active member row or invite exists, so Entra let the
	 * account in and the portal did not. The host logs it. The child sees the same not-invited screen.
	 */
	| { readonly kind: 'not-invited'; readonly email: Email | null; readonly drift: boolean };

export type Claim =
	| { readonly kind: 'join'; readonly existing: PortalUserId | undefined; readonly email: Email; readonly portalRole: PortalRole; readonly grants: Grants; readonly fromInvite: boolean }
	| { readonly kind: 'link'; readonly userId: PortalUserId; readonly email: Email };

/**
 * Pure, table-tested. An identity row with an active member row admits. Otherwise a link invite, a join invite
 * or a BOOTSTRAP_ADMIN_EMAILS match plans a claim. A revoked member with no new invite is not invited; a later
 * re-invite reuses the old PortalUserId, so that child's game history returns.
 */
export function decide(identity: Identity, found: Found, bootstrapAdmins: ReadonlySet<Email>): Admission {
	throw new Error('not implemented');
}

/**
 * The only function that computes a game role. Portal admin holds the top rung. Otherwise a grant applies,
 * 'none' hides the game, and with no grant the manifest's defaultRole applies. null means the game is hidden.
 */
export function effectiveRole<M extends GameManifest>(member: Member, game: GameId, manifest: M): RoleOf<M> | null {
	throw new Error('not implemented');
}

/** Boundary parse for admin writes: every key a known game, every value on that game's ladder or 'none'. */
export function parseGrants(raw: unknown, manifests: ReadonlyMap<GameId, GameManifest>): Grants | { readonly problems: readonly string[] } {
	throw new Error('not implemented');
}

export type IdentityStore = {
	find(identity: Identity): Promise<Found>;
	/**
	 * Converges after a crash at any step, per make-operations-idempotent:
	 *   1. insert the identities row with a fresh UUID; on conflict read the existing one
	 *   2. upsert the member row for that userId (join) or confirm it exists (link)
	 *   3. delete the invite
	 * A rerun finds step 1 done, writes the same member row, and deletes nothing new.
	 */
	claim(identity: Identity, claim: Claim): Promise<Member>;
	/** Reserves the name row first (insert if absent), then writes the profile. */
	setProfile(userId: PortalUserId, profile: Profile): Promise<'ok' | 'name_taken'>;
	setGrants(userId: PortalUserId, grants: Grants): Promise<void>;
	setPortalRole(userId: PortalUserId, role: PortalRole): Promise<void>;
	/** Sets state 'revoked'. The first step of a revoke; tools/members.mjs then removes the Entra assignment. */
	revoke(userId: PortalUserId): Promise<void>;
	/** Upsert by email, so tools/invite.mjs can rerun. */
	invite(invite: Invite): Promise<void>;
	/** Members with their identity subjects, so reconcile can match Entra assignments by object id. */
	list(): Promise<{ readonly members: readonly (Member & { readonly subjects: readonly string[] })[]; readonly invites: readonly Invite[] }>;
	saveDrift(report: DriftReport): Promise<void>;
	drift(): Promise<DriftReport | undefined>;
};

/** A user or guest object id in the workforce tenant. Equal to drawpad's `oid` key, since oid is per tenant, not per app. */
export type EntraObjectId = Brand<string, 'EntraObjectId'>;

/** One way the Entra assignment list and the portal rows disagree. Computed by tools/members.mjs, never by the host. */
export type Drift =
	/** Entra admits the account, but no member row or invite exists. Fix: remove the assignment. */
	| { readonly kind: 'assigned-without-row'; readonly principalId: EntraObjectId; readonly email: Email | null }
	/** An active member or pending invite whose account is not assigned, so Entra refuses it. Fix: assign. */
	| { readonly kind: 'row-without-assignment'; readonly email: Email; readonly userId: PortalUserId | null }
	/** A revoke that stopped after its first step. Fix: remove the assignment. */
	| { readonly kind: 'revoked-but-assigned'; readonly principalId: EntraObjectId; readonly userId: PortalUserId };

/** What the /admin/ hub shows. As fresh as the last `tools/members.mjs reconcile` run. */
export type DriftReport = { readonly checkedAt: string; readonly drift: readonly Drift[] };

/** No revoking yourself, no demoting or revoking the last admin. From both apps' admin rules. */
export function revokeProblem(target: Member, actor: Member, members: readonly Member[]): string | null {
	throw new Error('not implemented');
}
