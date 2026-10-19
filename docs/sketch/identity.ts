/**
 * @g4k/host's identity module for the games side: who may play, and which games. The player apps and the portal app
 * import it. The admin side has its own module (admin.ts) with its own audience, and the two share only the row types.
 *
 * Portal tables, in g4kportal<suffix>. One writer each, enforced by RBAC per app and per table:
 *   members     PK 'member'    RK PortalUserId               -> Member      admin app
 *   identities  PK 'identity'  RK `${IssuerKey}|${subject}`  -> { userId }  admin app, at invite, when it learns the object id
 *   emails      PK 'email'     RK Email                      -> { userId }  admin app; no games-side app can read it
 *   profiles    PK 'profile'   RK PortalUserId               -> Profile     portal app, on /welcome/
 *   admins      PK 'admin'     RK EntraObjectId              -> AdminRow    tools/bootstrap.mjs on the Mac (admin.ts)
 * Each fact lives in one table. The admin app writes the identity row in the same invite step that learns the object
 * id, so a first sign-in finds a complete row and nothing claims anything.
 *
 * Two gates for a player, both required. "Assignment required" is on for games4kids and each invited account holds
 * its own assignment, so Entra issues no games4kids token to anyone else. Then every games-side app admits only a
 * known identity with an active member row, and a game app also needs the game in `games`.
 *
 * Reserved, not created: guardianships and policies, for a later parent account.
 */

import type { Brand, GameId } from './manifest';

/** Minted by the admin app at invite (a UUID). The only user key a game stores. Survives a change of identity provider. */
export type PortalUserId = Brand<string, 'PortalUserId'>;

/** Lowercased, guest `#EXT#` form unwrapped. Keys the emails table; never in a row a games-side app reads, never telemetry. */
export type Email = Brand<string, 'Email'>;

/** A user or guest object id in the workforce tenant. Equal to drawpad's `oid` key. */
export type EntraObjectId = Brand<string, 'EntraObjectId'>;

/** 'entra' today; 'extid' if Entra External ID is added later for Google or Facebook sign-in. */
export type IssuerKey = Brand<string, 'IssuerKey'>;

export type TrustedIssuer = {
	readonly key: IssuerKey;
	/** https://login.microsoftonline.com/<tenantId>/v2.0 */
	readonly issuer: string;
	/** The games4kids client id. The admin app's issuer names games4kids-admin instead (admin.ts). */
	readonly audience: string;
	readonly keys: URL | { readonly keys: readonly object[] };
	readonly tenantId?: string;
};

/** What a verified games4kids token proves. `subject` is the oid. `email` is display only (the not-invited screen). */
export type Identity = { readonly issuer: IssuerKey; readonly subject: string; readonly email: Email | null };

export type Authentication =
	| { readonly ok: true; readonly identity: Identity }
	| { readonly ok: false; readonly code: 'unauthenticated' | 'invalid_token' };

/** RS256, iss, aud games4kids, tid, ver 2.0, scp contains access_as_user, exp. From letterjoin's identity.js. */
export function verifyGamesToken(issuers: readonly TrustedIssuer[], authorization: string | null): Promise<Authentication> {
	throw new Error('not implemented');
}

export type Profile = {
	/** Unique across the portal (checked by listing profiles), chosen on /welcome/. */
	readonly displayName: string;
	/** IANA zone, chosen on /welcome/. drawpad's daily limit and letterjoin's practice days read it. */
	readonly timeZone: string;
};

/**
 * One members row, written only by the admin app. No email, no object id and no role, so every games-side app may
 * read it. `games` is the explicit grant list: a game not in it is hidden and refused, including every new game.
 */
export type Member = {
	readonly userId: PortalUserId;
	/** A revoked member keeps the row and PortalUserId, so a re-invite restores the child's history. */
	readonly state: 'active' | 'revoked';
	readonly games: readonly GameId[];
};

/** What a games-side app finds for a verified identity, in one pass over identities, members and profiles. */
export type Found =
	| { readonly kind: 'known'; readonly userId: PortalUserId; readonly member: Member | undefined; readonly profile: Profile | undefined }
	| { readonly kind: 'unknown' };

/** What a handler knows about the person. A player, nothing more: no token, oid, email, role or admin flag. */
export type Caller = { readonly userId: PortalUserId; readonly displayName: string; readonly timeZone: string };

export type Admission =
	| { readonly kind: 'player'; readonly caller: Caller; readonly games: readonly GameId[] }
	/** Active member without a profile. The portal app lets this through to /welcome/; a game app answers no_profile. */
	| { readonly kind: 'no-profile'; readonly userId: PortalUserId }
	| { readonly kind: 'not-invited' }
	| { readonly kind: 'not-entitled' };

/**
 * Pure, table-tested. Known identity, active member, granted game (when `game` is not null), profile present.
 * The portal app passes null; a player app passes its own id.
 */
export function decide(found: Found, game: GameId | null): Admission {
	throw new Error('not implemented');
}

/** What every player app may read of the portal tables, over a Table Data Reader credential on three tables. */
export type PortalReader = {
	find(identity: Identity): Promise<Found>;
};

/** The portal app's view: the reader plus the one table it writes. No member, identity or email writer. */
export type PortalStore = PortalReader & {
	/** Lists profiles, refuses a display name another child holds, then writes this child's row. Two children racing for one name is accepted. */
	setProfile(userId: PortalUserId, profile: Profile): Promise<'ok' | 'name_taken'>;
};

/** GET /api/portal/me. Home draws a card for each id in `games`; the shell routes on `state`. */
export type Me =
	| { readonly state: 'not-invited'; readonly email: Email | null }
	| { readonly state: 'no-profile' }
	| { readonly state: 'active'; readonly userId: PortalUserId; readonly profile: Profile; readonly games: readonly GameId[] };

/** Pure: the portal app's `me` route is this function over decide(found, null). */
export function meFor(identity: Identity, admission: Exclude<Admission, { readonly kind: 'not-entitled' }>): Me {
	throw new Error('not implemented');
}
