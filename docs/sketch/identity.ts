/**
 * host/src/identity.ts. Who may enter the portal, and what they are in each game. The only module that reads
 * a token or the portal tables. Games see a `Caller`; the shell sees a `Me`.
 *
 * Portal tables (prefix `portal`, unreachable from any game's Platform):
 *   portalIdentities  PK 'identity'  RK `${IssuerKey}|${subject}`  -> { userId }
 *   portalMembers     PK 'member'    RK PortalUserId               -> Member
 *   portalNames       PK 'name'      RK lowercased display name    -> { userId }
 *   portalInvites     PK 'invite'    RK Email                      -> Invite
 *
 * `portalMembers` is the one gate. Entra "assignment required" stays off, so no second list of who may enter
 * exists to drift from this one.
 */

import type { Brand, GameId, GameManifest, RoleOf } from './manifest';

/** Minted by the portal (a UUID). The only user key a game may store. Survives a change of identity provider. */
export type PortalUserId = Brand<string, 'PortalUserId'>;

/** Lowercased, guest `#EXT#` form unwrapped (drawpad's emailFromClaims). Matches invites; never a key in game data. */
export type Email = Brand<string, 'Email'>;

/** Short config key for an accepted issuer: 'entra' today, 'extid' if Entra External ID is added. */
export type IssuerKey = Brand<string, 'IssuerKey'>;

/**
 * One entry per accepted identity provider. Opening up to more people later adds a second entry and a second
 * MSAL authority in config.json; the tables, roles and games do not change.
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
};

/** What a verified token proves. `subject` is the oid for Entra. The email is a hint for invite matching only. */
export type Identity = { readonly issuer: IssuerKey; readonly subject: string; readonly email: Email | null };

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
	| { readonly kind: 'not-invited'; readonly email: Email | null };

export type Claim =
	| { readonly kind: 'join'; readonly existing: PortalUserId | undefined; readonly email: Email; readonly portalRole: PortalRole; readonly grants: Grants; readonly fromInvite: boolean }
	| { readonly kind: 'link'; readonly userId: PortalUserId; readonly email: Email };

/**
 * Pure, table-tested. An identity row with a member row admits. Otherwise a link invite, a join invite or a
 * BOOTSTRAP_ADMIN_EMAILS match plans a claim. An identity row whose member was removed and who holds no new
 * invite is not invited; a later re-invite reuses the old PortalUserId, so that child's game history returns.
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
	/** Deletes the member row and frees the name. The identities row stays, so a re-invite restores the same id. */
	remove(userId: PortalUserId): Promise<void>;
	invite(invite: Invite): Promise<void>;
	list(): Promise<{ readonly members: readonly Member[]; readonly invites: readonly Invite[] }>;
};

/** No removing yourself, no demoting or removing the last admin. From both apps' admin rules. */
export function removalProblem(target: Member, actor: Member, members: readonly Member[]): string | null {
	throw new Error('not implemented');
}

/**
 * Optional helper, ported from drawpad's graph.ts. Sends a Microsoft B2B invitation so a family member outside
 * the tenant gets a guest account. Needs User.Invite.All on the Function app identity. With assignment required
 * off, AppRoleAssignment.ReadWrite.All is no longer needed. Graph treats a repeat invite as a no-op.
 */
export function sendGuestInvitation(email: Email, redirectUrl: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: string }> {
	throw new Error('not implemented');
}
