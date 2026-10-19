/**
 * @g4k/host's identity module. Who may enter the portal, and what they are in each game. Every game app, the
 * portal app and the admin app import it. Games see a `Caller`; the shell sees a `Me`.
 *
 * Portal tables, in the portal storage account g4kportal<suffix>. One writer each, enforced by RBAC per app. Each
 * fact lives in exactly one table, so no table is a copy of another and nothing has to be kept in step:
 *   members     PK 'member'    RK PortalUserId               -> Member      admin app (admin.ts)
 *   emails      PK 'email'     RK Email                      -> Account     admin app (admin.ts)
 *   identities  PK 'identity'  RK `${IssuerKey}|${subject}`  -> { userId }  portal app, on the first sign-in
 *   profiles    PK 'profile'   RK PortalUserId               -> Profile     portal app, on /welcome/
 *   names       PK 'name'      RK lowercased display name    -> { userId }  portal app, on /welcome/
 * Emails live only in `emails`, which the admin app and the portal app read and no game app can. Each game app's
 * identity holds Storage Table Data Reader on members, identities and profiles only, none of which holds an email,
 * and no write on any portal table. Its code gets a PortalReader, whose rows have no email field and which has no
 * writer, so a first sign-in that reaches a game app before the portal app gets 403 not_claimed, and the shell
 * claims through the portal app and retries.
 *
 * Two gates, both required. Entra "assignment required" is on for games4kids, and each invited account holds its
 * own assignment to the games4kids enterprise app (default access role), so Entra issues no token to anyone else.
 * Then every app admits only an active member row. The admin app writes both lists, the second one as the
 * signed-in admin through on-behalf-of (admin.ts); no app holds a standing Entra right.
 *
 * Rows change additively within a contract major (release.ts). An app parses each row at the boundary, and a state
 * it does not know is refused, so a game app built against an older minor fails closed, never open.
 *
 * Reserved, not created: guardianships (PK guardian PortalUserId, RK child PortalUserId) and policies
 * (PK 'policy', RK child PortalUserId -> { dailyPlayMinutes }). A future parent account is a guardianship row,
 * not a portal role, and a parent-set limit would reach games as a Caller field.
 */

import type { Brand, GameId, RoleLadder } from './manifest';

/** Minted by the admin app at invite (a UUID). The only user key a game may store. Survives a change of identity provider. */
export type PortalUserId = Brand<string, 'PortalUserId'>;

/** Lowercased, guest `#EXT#` form unwrapped (drawpad's emailFromClaims). Keys the emails table; never in a table a game app reads, never a telemetry value. */
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
	/** The client id of the "games4kids" registration. The admin app's issuer names games4kids-admin instead (admin.ts). */
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

/** RS256, iss, aud games4kids, tid where pinned, ver 2.0, scp contains access_as_user, exp. From letterjoin's identity.js. Every game app and the portal app call it; the admin app has its own (admin.ts). */
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

/**
 * One members row, written only by the admin app. The invite form creates it; the access grid and revoke change it.
 * It holds no email and no Entra object id, so every app may read it.
 */
export type Member = {
	readonly userId: PortalUserId;
	/** A revoked member keeps the row and PortalUserId, so a re-invite restores the child's game history. */
	readonly state: 'active' | 'revoked';
	readonly portalRole: PortalRole;
	readonly grants: Grants;
};

/** One emails row, written only by the admin app. Read by the admin app and the portal app, never by a game app. */
export type Account = {
	readonly email: Email;
	readonly userId: PortalUserId;
	/** The account Microsoft's invitation created or found. null until step 3 of an invite records it. */
	readonly entraObjectId: EntraObjectId | null;
};

/**
 * What GET /api/portal/me returns. The shell routes on `state`, so a game page only ever sees 'active'. An email
 * here is the caller's own, from their token. The portal
 * app knows no game, so it returns the grants as stored, and the shell derives each game's role with effectiveRole
 * over the live catalog. Each game app derives the same role from its own manifest, and that one is authoritative.
 */
export type Me =
	| { readonly state: 'not-invited'; readonly email: Email | null }
	| { readonly state: 'no-profile'; readonly email: Email }
	| {
			readonly state: 'active';
			readonly userId: PortalUserId;
			readonly profile: Profile;
			readonly portalRole: PortalRole;
			readonly grants: Grants;
	  };

/** What an app's store finds for a verified identity, in one pass. */
export type Found =
	/** The identity row exists, so this identity has signed in before. */
	| { readonly kind: 'known'; readonly userId: PortalUserId; readonly member: Member | undefined; readonly profile: Profile | undefined }
	/** No identity row yet. `account` comes from the emails table, keyed by the token's email hint, and `member` from its userId. */
	| { readonly kind: 'new'; readonly account: Account | undefined; readonly member: Member | undefined };

export type Admission =
	| { readonly kind: 'member'; readonly member: Member; readonly profile: Profile | null }
	/** First sign-in of an invited child. The portal app inserts the identity row, then admits; a game app answers 403 not_claimed. */
	| { readonly kind: 'claim'; readonly member: Member }
	| { readonly kind: 'not-invited'; readonly email: Email | null };

/**
 * Pure, table-tested. A known identity with an active member admits. A new identity claims only an active member
 * whose account's entraObjectId equals the token's oid, so an email match alone never claims. A revoked member is not invited.
 */
export function decide(identity: Identity, found: Found): Admission {
	throw new Error('not implemented');
}

/**
 * The only function that computes a game role. A portal admin holds the top rung of every game. Otherwise the
 * member's grant for the game applies, and with no grant the answer is 'none', so a new game is hidden from every
 * child until an admin grants it. The manifest's defaultRole never grants anything. `ladder` is a manifest in a
 * game app and a catalog entry in the shell.
 */
export function effectiveRole<L extends { readonly roles: RoleLadder }>(member: Pick<Member, 'portalRole' | 'grants'>, game: GameId, ladder: L): L['roles'][number] | 'none' {
	throw new Error('not implemented');
}

/**
 * What every game app may read of the portal tables: identities, members and profiles. Built over a Table Data
 * Reader credential scoped to those three tables; it has no writer, and no row it returns has an email.
 */
export type PortalReader = {
	/** An identity with no row is just 'unclaimed', which the game app answers with 403 not_claimed before any decision. */
	known(identity: Identity): Promise<Extract<Found, { readonly kind: 'known' }> | { readonly kind: 'unclaimed' }>;
	/** For each game's Roster. */
	members(): Promise<readonly { readonly member: Member; readonly profile: Profile | null }[]>;
};

/** The portal app's view. It adds the emails lookup and the two writes the portal app owns, and still no member or email writer. */
export type PortalStore = PortalReader & {
	/** Reads identities, and for a new identity the emails row for its email hint and that row's member. */
	find(identity: Identity): Promise<Found>;
	/**
	 * The only claim step: insert the identities row for member.userId if absent. A rerun, or a second tab racing
	 * the first, finds the row and does nothing, per make-operations-idempotent.
	 */
	claim(identity: Identity, member: Member): Promise<void>;
	/** Reserves the name row first (insert if absent), then writes the profile. */
	setProfile(userId: PortalUserId, profile: Profile): Promise<'ok' | 'name_taken'>;
};
