/**
 * host/src/identity.ts. Who may enter the portal, and what they are in each game. The host Function app and the
 * admin Function app both import it. Games see a `Caller`; the shell sees a `Me`.
 *
 * Portal tables, in the portal storage account g4kportal<suffix>, which no game's Platform reaches. One writer each.
 *   members     PK 'member'    RK PortalUserId               -> Member      admin app (admin.ts)
 *   emails      PK 'email'     RK Email                      -> { userId }  admin app (admin.ts)
 *   identities  PK 'identity'  RK `${IssuerKey}|${subject}`  -> { userId }  host, on the first sign-in
 *   profiles    PK 'profile'   RK PortalUserId               -> Profile     host, on /welcome/
 *   names       PK 'name'      RK lowercased display name    -> { userId }  host, on /welcome/
 * The admin app's identity holds table-scoped RBAC that enforces its half: write on the first two, read on the
 * rest. The host's half is enforced by HostStore, which has no member or email writer.
 *
 * Two gates, both required. Entra "assignment required" is on, and each invited account holds its own assignment
 * to the games4kids enterprise app (default access role), so Entra issues no token to anyone else. A group would
 * need Entra ID P1, which the tenant lacks. Then the host admits only an active member row. The admin app writes
 * both lists, holding Cloud Application Administrator scoped to the games4kids service principal (admin.ts).
 *
 * Reserved, not created: guardianships (PK guardian PortalUserId, RK child PortalUserId) and policies
 * (PK 'policy', RK child PortalUserId -> { dailyPlayMinutes }). A future parent account is a guardianship row,
 * not a portal role, and a parent-set limit would reach games as a Caller field.
 */

import type { Brand, GameId, GameManifest, RoleOf } from './manifest';

/** Minted by the admin app at invite (a UUID). The only user key a game may store. Survives a change of identity provider. */
export type PortalUserId = Brand<string, 'PortalUserId'>;

/** Lowercased, guest `#EXT#` form unwrapped (drawpad's emailFromClaims). Keys the emails table; never a key in game data, never a telemetry value. */
export type Email = Brand<string, 'Email'>;

/** A user or guest object id in the workforce tenant. Equal to drawpad's `oid` key, since oid is per tenant, not per app. */
export type EntraObjectId = Brand<string, 'EntraObjectId'>;

/** Short config key for an accepted issuer: 'entra' today, 'extid' if Entra External ID is added for Google or Facebook sign-in. */
export type IssuerKey = Brand<string, 'IssuerKey'>;

/**
 * One entry per accepted identity provider. Google or Facebook sign-in later means an Entra External ID tenant
 * federated with them, added as a second entry and a second MSAL authority in config.json. Its tokens prove no
 * workforce assignment, so for it the member gate stands alone. Its identity row would map to the child's existing
 * PortalUserId, so the tables, roles and games do not change.
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

/** What a verified token proves. `subject` is the oid for Entra. The email is a hint for the first-sign-in lookup only. */
export type Identity = { readonly issuer: IssuerKey; readonly subject: string; readonly email: Email | null };

export type Authentication =
	| { readonly ok: true; readonly identity: Identity }
	| { readonly ok: false; readonly code: 'unauthenticated' | 'invalid_token' };

/** RS256, iss, aud, tid where pinned, ver 2.0, scp contains access_as_user, exp. From letterjoin's identity.js. Both apps call it. */
export function verifyToken(issuers: readonly TrustedIssuer[], authorization: string | null): Promise<Authentication> {
	throw new Error('not implemented');
}

export type PortalRole = 'member' | 'admin';

/** One rung of the game's ladder per granted game. A game with no entry is hidden: no grant, no access. */
export type Grants = Readonly<Partial<Record<GameId, string>>>;

export type Profile = {
	/** Unique across the portal, chosen on /welcome/. */
	readonly displayName: string;
	/** IANA zone, chosen on /welcome/. drawpad's daily limit and letterjoin's practice days read it. */
	readonly timeZone: string;
};

/** Written only by the admin app. The invite form creates it; the access grid and revoke change it. */
export type Member = {
	readonly userId: PortalUserId;
	readonly email: Email;
	/** The account Microsoft's invitation created or found. null until step 3 of an invite records it. */
	readonly entraObjectId: EntraObjectId | null;
	/** A revoked member keeps the row and PortalUserId, so a re-invite restores the child's game history. */
	readonly state: 'active' | 'revoked';
	readonly portalRole: PortalRole;
	readonly grants: Grants;
};

/** What GET /api/portal/me returns. The shell routes on `state`, so a game page only ever sees 'active'. */
export type Me =
	| { readonly state: 'not-invited'; readonly email: Email | null }
	| { readonly state: 'no-profile'; readonly email: Email }
	| {
			readonly state: 'active';
			readonly userId: PortalUserId;
			readonly profile: Profile;
			readonly portalRole: PortalRole;
			/** Granted games only, with the role held in each. Derived by effectiveRole, never stored. */
			readonly games: readonly { readonly id: GameId; readonly role: string }[];
	  };

/** What the host's store finds for a verified identity, in one pass. */
export type Found =
	/** The identity row exists, so this identity has signed in before. */
	| { readonly kind: 'known'; readonly userId: PortalUserId; readonly member: Member | undefined; readonly profile: Profile | undefined }
	/** No identity row yet. `member` comes from the emails table, keyed by the token's email hint. */
	| { readonly kind: 'new'; readonly member: Member | undefined };

export type Admission =
	| { readonly kind: 'member'; readonly member: Member; readonly profile: Profile | null }
	/** First sign-in of an invited child. The host inserts the identity row, then admits. */
	| { readonly kind: 'claim'; readonly member: Member }
	| { readonly kind: 'not-invited'; readonly email: Email | null };

/**
 * Pure, table-tested. A known identity with an active member admits. A new identity claims only an active member
 * whose entraObjectId equals the token's oid, so an email match alone never claims. A revoked member is not invited.
 */
export function decide(identity: Identity, found: Found): Admission {
	throw new Error('not implemented');
}

/**
 * The only function that computes a game role. A portal admin holds the top rung of every game. Otherwise the
 * member's grant for the game applies, and with no grant the answer is 'none', so a new game is hidden from every
 * child until an admin grants it. The manifest's defaultRole never grants anything.
 */
export function effectiveRole<M extends GameManifest>(member: Member, game: GameId, manifest: M): RoleOf<M> | 'none' {
	throw new Error('not implemented');
}

/** The host's view of the portal tables. No method writes members or emails. */
export type HostStore = {
	find(identity: Identity): Promise<Found>;
	/**
	 * The only claim step: insert the identities row for member.userId if absent. A rerun, or a second tab racing
	 * the first, finds the row and does nothing, per make-operations-idempotent.
	 */
	claim(identity: Identity, member: Member): Promise<void>;
	/** Reserves the name row first (insert if absent), then writes the profile. */
	setProfile(userId: PortalUserId, profile: Profile): Promise<'ok' | 'name_taken'>;
	/** Read only, for each game's Roster. */
	members(): Promise<readonly { readonly member: Member; readonly profile: Profile | null }[]>;
};
